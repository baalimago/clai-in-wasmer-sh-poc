//! The page's audio inputs as files: `/run/audio/<name>` reads what the page captures from
//! that input as it arrives, signed 16-bit little-endian mono samples at [`SAMPLE_RATE`], and
//! ends only when something writes to the file: then its readers read to the end of what was
//! captured and get end of file, which is how a recording stops cleanly (see `audio/ffmpeg.sh`).
//! A read waits until there is audio. The page captures an input only while something has its
//! file open for reading ([`AudioFs::open_inputs`]), and feeds it with [`AudioFs::push`].

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
const NAME_MAX: usize = 255;

/// The inputs, in the order the page names them.
pub struct AudioFs {
    inputs: Arc<[Arc<Input>]>,
}

/// One input: what it captured that its readers have not read yet.
struct Input {
    name: String,
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
    pub fn new(names: &[String]) -> Result<Self, InvalidName> {
        let mut inputs = Vec::with_capacity(names.len());
        for (ino, name) in (ROOT_INO + 1..).zip(names) {
            let valid = !name.is_empty()
                && name.len() <= NAME_MAX
                && name != "."
                && name != ".."
                && !name.bytes().any(|b| b == b'/' || b == 0)
                && !inputs.iter().any(|i: &Arc<Input>| &i.name == name);
            if !valid {
                return Err(InvalidName(name.clone()));
            }
            inputs.push(Arc::new(Input {
                name: name.clone(),
                ino,
                state: Mutex::default(),
            }));
        }
        Ok(Self {
            inputs: inputs.into(),
        })
    }

    /// The inputs whose files are open, which the page should capture.
    pub fn open_inputs(&self) -> Vec<String> {
        self.inputs
            .iter()
            .filter(|i| i.state.lock().unwrap().readers > 0)
            .map(|i| i.name.clone())
            .collect()
    }

    /// Hands `samples` captured from input `name` to its readers; dropped when nothing reads
    /// it. `false` if there is no such input.
    pub fn push(&self, name: &str, samples: &[u8]) -> bool {
        let Some(input) = self.inputs.iter().find(|i| i.name == name) else {
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
        Arc::new(Root(self.inputs.clone()))
    }

    async fn statfs(&self) -> FsResult<StatFs> {
        Ok(StatFs {
            block_size: 4096,
            blocks: 0,
            blocks_free: 0,
            blocks_avail: 0,
            files: self.inputs.len() as u64 + 1,
            files_free: 0,
            name_max: NAME_MAX as u32,
            fragment_size: 4096,
        })
    }
}

fn attr(ino: u64, file_type: FileType, mode: u32) -> Attr {
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

struct Root(Arc<[Arc<Input>]>);

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
        let input = self.0.iter().find(|i| i.name.as_bytes() == name);
        Ok(Arc::new(InputNode(input.ok_or(Errno::ENOENT)?.clone())))
    }

    async fn open(&self, _options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        Ok(Box::new(RootHandle(self.0.clone())))
    }
}

struct RootHandle(Arc<[Arc<Input>]>);

#[async_trait(?Send)]
impl Handle for RootHandle {
    async fn readdir(&self, cookie: u64, sink: &mut dyn DirSink) -> FsResult<()> {
        let start = usize::try_from(cookie).unwrap_or(usize::MAX);
        for (i, input) in self.0.iter().enumerate().skip(start) {
            let entry = DirEntry {
                name: input.name.as_bytes(),
                ino: input.ino,
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
