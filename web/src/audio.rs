//! The page's audio inputs as files: `/run/audio/<name>` reads what the page captures from
//! that input as it arrives, signed 16-bit little-endian mono samples at [`SAMPLE_RATE`], and
//! ends only when something writes to the file: then its readers read to the end of what was
//! captured and get end of file, which is how a recording stops cleanly (see `audio/ffmpeg.sh`).
//! A read waits until there is audio. The page captures an input only while something has its
//! file open for reading ([`AudioFs::open_inputs`]), and feeds it with [`AudioFs::push`].
//! The page adds inputs as it finds the browser's devices ([`AudioFs::add`]), and
//! `/run/audio/devices` lists them all, one `name<TAB>label` line each, for `audio/ffmpeg.sh`.
//! `/run/audio/play` goes the other way: what is written to it, once closed, is a sound file
//! for the page to play ([`AudioFs::take_played`]).

use std::any::Any;
use std::collections::VecDeque;
use std::future::poll_fn;
use std::sync::{Arc, Mutex};
use std::task::{Poll, Waker};

use async_trait::async_trait;
use wasixv2_vfs::{
    Attr, Device, DirEntry, DirSink, Errno, FileType, Filesystem, FsInfo, FsResult, Handle, Node,
    OpenOptions, SetAttr, StatFs, Timestamp,
};

pub const SAMPLE_RATE: u32 = 48_000;
/// Audio a file holds for a reader that falls behind: 30 s. Older audio is dropped.
const MAX_BUFFERED: usize = 30 * SAMPLE_RATE as usize * 2;
/// `f_type` of `statfs`: "audi" in ASCII. No Linux filesystem uses it.
const AUDIO_MAGIC: u32 = 0x6175_6469;
const ROOT_INO: u64 = 1;
const PLAY_INO: u64 = 2;
const DEVICES_INO: u64 = 3;
const FIRST_INPUT_INO: u64 = 4;
const NAME_MAX: usize = 255;
const PLAY: &str = "play";
const DEVICES: &str = "devices";
/// The largest sound file `play` takes: 64 MiB, ten minutes of 48 kHz stereo WAV and more.
const MAX_PLAYED: usize = 64 << 20;

/// The inputs, in the order the page named them.
pub struct AudioFs {
    inputs: Inputs,
    played: Played,
}

type Inputs = Arc<Mutex<Vec<Arc<Input>>>>;

/// The files written to a [`DropNode`], each once it closed, oldest first.
pub(crate) type Played = Arc<Mutex<Vec<Vec<u8>>>>;

/// One input: what it captured that its readers have not read yet.
struct Input {
    name: String,
    label: Mutex<String>,
    ino: u64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    samples: VecDeque<u8>,
    readers: usize,
    /// A write ended the stream for its readers.
    ended: bool,
    wakers: Vec<Waker>,
}

impl State {
    fn wake(&mut self) {
        for waker in self.wakers.drain(..) {
            waker.wake();
        }
    }
}

#[derive(Debug)]
pub struct InvalidName(pub String);

impl std::fmt::Display for InvalidName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?} cannot name an audio input's file", self.0)
    }
}

impl std::error::Error for InvalidName {}

impl AudioFs {
    /// The inputs `inputs` names, as `(name, label)`.
    pub fn new(inputs: &[(String, String)]) -> Result<Self, InvalidName> {
        let fs = Self {
            inputs: Inputs::default(),
            played: Played::default(),
        };
        for (name, label) in inputs {
            fs.add(name, label)?;
        }
        Ok(fs)
    }

    /// Adds input `name`, or relabels it when there is one.
    pub fn add(&self, name: &str, label: &str) -> Result<(), InvalidName> {
        let mut inputs = self.inputs.lock().unwrap();
        if let Some(input) = inputs.iter().find(|i| i.name == name) {
            *input.label.lock().unwrap() = label.to_owned();
            return Ok(());
        }
        let valid = !name.is_empty()
            && name.len() <= NAME_MAX
            && ![".", "..", PLAY, DEVICES].contains(&name)
            && !name.bytes().any(|b| b == b'/' || b == 0);
        // A label is one line of the devices file.
        if !valid || label.contains(['\n', '\t']) {
            return Err(InvalidName(name.to_owned()));
        }
        let ino = FIRST_INPUT_INO + inputs.len() as u64;
        inputs.push(Arc::new(Input {
            name: name.to_owned(),
            label: Mutex::new(label.to_owned()),
            ino,
            state: Mutex::default(),
        }));
        Ok(())
    }

    /// The inputs whose files are open, which the page should capture.
    pub fn open_inputs(&self) -> Vec<String> {
        self.inputs
            .lock()
            .unwrap()
            .iter()
            .filter(|i| i.state.lock().unwrap().readers > 0)
            .map(|i| i.name.clone())
            .collect()
    }

    /// The sound files written to `play` since the last call, oldest first.
    pub fn take_played(&self) -> Vec<Vec<u8>> {
        std::mem::take(&mut *self.played.lock().unwrap())
    }

    /// Hands `samples` captured from input `name` to its readers; dropped when nothing reads
    /// it. `false` if there is no such input.
    pub fn push(&self, name: &str, samples: &[u8]) -> bool {
        let Some(input) = self.inputs.lock().unwrap().iter().find(|i| i.name == name).cloned() else {
            return false;
        };
        let mut state = input.state.lock().unwrap();
        if state.readers == 0 {
            return true;
        }
        state.samples.extend(samples);
        let excess = state.samples.len().saturating_sub(MAX_BUFFERED);
        // Whole samples only, so the stream stays aligned.
        state.samples.drain(..excess + excess % 2);
        state.wake();
        true
    }
}

#[async_trait(?Send)]
impl Filesystem for AudioFs {
    fn info(&self) -> FsInfo {
        FsInfo {
            name: "audio",
            magic: AUDIO_MAGIC,
            name_max: NAME_MAX,
            read_only: false,
            dev: None,
            has_btime: false,
            stable: true,
        }
    }

    fn root(&self) -> Arc<dyn Node> {
        Arc::new(Root(self.inputs.clone(), self.played.clone()))
    }

    async fn statfs(&self) -> FsResult<StatFs> {
        Ok(StatFs {
            block_size: 4096,
            blocks: 0,
            blocks_free: 0,
            blocks_avail: 0,
            files: self.inputs.lock().unwrap().len() as u64 + 3,
            files_free: 0,
            name_max: NAME_MAX as u32,
            fragment_size: 4096,
        })
    }
}

pub(crate) fn attr(ino: u64, file_type: FileType, mode: u32) -> Attr {
    let epoch = Timestamp::default();
    Attr {
        ino,
        file_type,
        mode,
        nlink: if file_type == FileType::Directory { 2 } else { 1 },
        uid: 0,
        gid: 0,
        rdev: Device::default(),
        size: 0,
        blocks: 0,
        blksize: 4096,
        atime: epoch,
        mtime: epoch,
        ctime: epoch,
        btime: None,
        dev: None,
    }
}

struct Root(Inputs, Played);

/// The devices file: each input's `name<TAB>label` line.
fn devices(inputs: &Inputs) -> Vec<u8> {
    let inputs = inputs.lock().unwrap();
    let lines = inputs.iter().map(|i| format!("{}\t{}\n", i.name, i.label.lock().unwrap()));
    lines.collect::<String>().into_bytes()
}

#[async_trait(?Send)]
impl Node for Root {
    fn ino(&self) -> u64 {
        ROOT_INO
    }

    fn file_type(&self) -> FileType {
        FileType::Directory
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn getattr(&self) -> FsResult<Attr> {
        Ok(attr(ROOT_INO, FileType::Directory, 0o755))
    }

    async fn setattr(&self, _attr: &SetAttr) -> FsResult<Attr> {
        Err(Errno::EROFS)
    }

    async fn lookup(&self, name: &[u8]) -> FsResult<Arc<dyn Node>> {
        if name == PLAY.as_bytes() {
            return Ok(Arc::new(DropNode::new(PLAY_INO, self.1.clone(), MAX_PLAYED)));
        }
        if name == DEVICES.as_bytes() {
            return Ok(Arc::new(DevicesNode(self.0.clone())));
        }
        let inputs = self.0.lock().unwrap();
        let input = inputs.iter().find(|i| i.name.as_bytes() == name);
        Ok(Arc::new(InputNode(input.ok_or(Errno::ENOENT)?.clone())))
    }

    async fn open(&self, _options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        let inputs = self.0.lock().unwrap();
        let mut entries = vec![(PLAY.to_owned(), PLAY_INO), (DEVICES.to_owned(), DEVICES_INO)];
        entries.extend(inputs.iter().map(|i| (i.name.clone(), i.ino)));
        Ok(Box::new(RootHandle(entries)))
    }
}

/// The directory's entries when it was opened.
struct RootHandle(Vec<(String, u64)>);

#[async_trait(?Send)]
impl Handle for RootHandle {
    async fn readdir(&self, cookie: u64, sink: &mut dyn DirSink) -> FsResult<()> {
        let start = usize::try_from(cookie).unwrap_or(usize::MAX);
        for (i, (name, ino)) in self.0.iter().enumerate().skip(start) {
            let entry = DirEntry {
                name: name.as_bytes(),
                ino: *ino,
                file_type: FileType::Regular,
                next: i as u64 + 1,
            };
            if !sink.push(entry) {
                break;
            }
        }
        Ok(())
    }
}

/// `devices`, read-only: the inputs when it is opened.
struct DevicesNode(Inputs);

#[async_trait(?Send)]
impl Node for DevicesNode {
    fn ino(&self) -> u64 {
        DEVICES_INO
    }

    fn file_type(&self) -> FileType {
        FileType::Regular
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn getattr(&self) -> FsResult<Attr> {
        let mut attr = attr(DEVICES_INO, FileType::Regular, 0o444);
        attr.size = devices(&self.0).len() as u64;
        Ok(attr)
    }

    async fn setattr(&self, _attr: &SetAttr) -> FsResult<Attr> {
        Err(Errno::EPERM)
    }

    async fn open(&self, options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        if options.write {
            return Err(Errno::EACCES);
        }
        Ok(Box::new(Snapshot(devices(&self.0))))
    }
}

struct Snapshot(Vec<u8>);

#[async_trait(?Send)]
impl Handle for Snapshot {
    async fn read_at(&self, buf: &mut [u8], offset: u64) -> FsResult<usize> {
        let start = usize::try_from(offset).unwrap_or(usize::MAX).min(self.0.len());
        let n = buf.len().min(self.0.len() - start);
        buf[..n].copy_from_slice(&self.0[start..start + n]);
        Ok(n)
    }
}

struct InputNode(Arc<Input>);

#[async_trait(?Send)]
impl Node for InputNode {
    fn ino(&self) -> u64 {
        self.0.ino
    }

    fn file_type(&self) -> FileType {
        FileType::Regular
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn getattr(&self) -> FsResult<Attr> {
        Ok(attr(self.0.ino, FileType::Regular, 0o666))
    }

    /// A stream has no size or times to change; `O_TRUNC` gets here.
    async fn setattr(&self, _attr: &SetAttr) -> FsResult<Attr> {
        self.getattr().await
    }

    async fn open(&self, options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        if options.write {
            return Ok(Box::new(Ender(self.0.clone())));
        }
        self.0.state.lock().unwrap().readers += 1;
        Ok(Box::new(Reader(self.0.clone())))
    }
}

/// An open input: reads take the input's audio as it arrives, whatever the offset.
struct Reader(Arc<Input>);

impl Drop for Reader {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.readers -= 1;
        if state.readers == 0 {
            state.samples.clear();
            state.ended = false;
        }
    }
}

#[async_trait(?Send)]
impl Handle for Reader {
    async fn read_at(&self, buf: &mut [u8], _offset: u64) -> FsResult<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        poll_fn(|cx| {
            let mut state = self.0.state.lock().unwrap();
            if state.samples.is_empty() && state.ended {
                return Poll::Ready(Ok(0));
            }
            if state.samples.is_empty() {
                state.wakers.push(cx.waker().clone());
                return Poll::Pending;
            }
            let n = buf.len().min(state.samples.len());
            for (slot, byte) in buf.iter_mut().zip(state.samples.drain(..n)) {
                *slot = byte;
            }
            Poll::Ready(Ok(n))
        })
        .await
    }

    async fn write_at(&self, _data: &[u8], _offset: u64) -> FsResult<usize> {
        Err(Errno::EBADF)
    }
}

/// An input opened for writing: whatever is written ends the stream for the input's readers.
struct Ender(Arc<Input>);

impl Ender {
    fn end(&self, len: usize) -> usize {
        let mut state = self.0.state.lock().unwrap();
        if state.readers > 0 {
            state.ended = true;
            state.wake();
        }
        len
    }
}

#[async_trait(?Send)]
impl Handle for Ender {
    async fn write_at(&self, data: &[u8], _offset: u64) -> FsResult<usize> {
        Ok(self.end(data.len()))
    }

    async fn append(&self, data: &[u8]) -> FsResult<(u64, usize)> {
        Ok((0, self.end(data.len())))
    }

    /// `>` truncates before it writes.
    async fn set_size(&self, _size: u64) -> FsResult<()> {
        Ok(())
    }
}

/// A write-only file whose content, once closed, goes to the page: `play`'s sound files, which
/// the page plays, and the page's outbox ([`crate::outbox`]). A file over `max` bytes fails to
/// write with `EFBIG`.
pub(crate) struct DropNode {
    ino: u64,
    inbox: Played,
    max: usize,
}

impl DropNode {
    pub(crate) fn new(ino: u64, inbox: Played, max: usize) -> Self {
        Self { ino, inbox, max }
    }
}

#[async_trait(?Send)]
impl Node for DropNode {
    fn ino(&self) -> u64 {
        self.ino
    }

    fn file_type(&self) -> FileType {
        FileType::Regular
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    async fn getattr(&self) -> FsResult<Attr> {
        Ok(attr(self.ino, FileType::Regular, 0o222))
    }

    async fn setattr(&self, _attr: &SetAttr) -> FsResult<Attr> {
        self.getattr().await
    }

    async fn open(&self, options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        if !options.write {
            return Err(Errno::EACCES);
        }
        Ok(Box::new(Player {
            sound: Mutex::default(),
            played: self.inbox.clone(),
            max: self.max,
        }))
    }
}

struct Player {
    sound: Mutex<Vec<u8>>,
    played: Played,
    max: usize,
}

impl Player {
    fn add(&self, data: &[u8]) -> FsResult<usize> {
        let mut sound = self.sound.lock().unwrap();
        if sound.len() + data.len() > self.max {
            return Err(Errno::EFBIG);
        }
        sound.extend_from_slice(data);
        Ok(data.len())
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        let sound = std::mem::take(&mut *self.sound.lock().unwrap());
        if !sound.is_empty() {
            self.played.lock().unwrap().push(sound);
        }
    }
}

#[async_trait(?Send)]
impl Handle for Player {
    async fn write_at(&self, data: &[u8], _offset: u64) -> FsResult<usize> {
        self.add(data)
    }

    async fn append(&self, data: &[u8]) -> FsResult<(u64, usize)> {
        Ok((0, self.add(data)?))
    }

    async fn set_size(&self, _size: u64) -> FsResult<()> {
        Ok(())
    }
}
