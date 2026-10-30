//! `/run/page/out`: what a program writes there goes to the page once the file is closed, one
//! message per open. The page's app sends its read commands' output this way, so the console
//! stays the terminal's: `{ echo meetings; ls; } > /run/page/out`. The first line names what
//! the message answers.

use std::any::Any;
use std::sync::Arc;

use async_trait::async_trait;
use wasixv2_vfs::{
    Attr, DirEntry, DirSink, Errno, FileType, Filesystem, FsInfo, FsResult, Handle, Node,
    OpenOptions, SetAttr, StatFs,
};

use crate::audio::{DropNode, Played, attr};

/// `f_type` of `statfs`: "page" in ASCII. No Linux filesystem uses it.
const PAGE_MAGIC: u32 = 0x7061_6765;
const ROOT_INO: u64 = 1;
const OUT_INO: u64 = 2;
const OUT: &str = "out";
/// The largest message: 16 MiB.
const MAX_MESSAGE: usize = 16 << 20;

#[derive(Default)]
pub struct Outbox(Played);

impl Outbox {
    /// The messages written since the last call, oldest first.
    pub fn take(&self) -> Vec<Vec<u8>> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

#[async_trait(?Send)]
impl Filesystem for Outbox {
    fn info(&self) -> FsInfo {
        FsInfo {
            name: "page",
            magic: PAGE_MAGIC,
            name_max: 255,
            read_only: false,
            dev: None,
            has_btime: false,
            stable: true,
        }
    }

    fn root(&self) -> Arc<dyn Node> {
        Arc::new(Root(self.0.clone()))
    }

    async fn statfs(&self) -> FsResult<StatFs> {
        Ok(StatFs {
            block_size: 4096,
            blocks: 0,
            blocks_free: 0,
            blocks_avail: 0,
            files: 2,
            files_free: 0,
            name_max: 255,
            fragment_size: 4096,
        })
    }
}

struct Root(Played);

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
        match name == OUT.as_bytes() {
            true => Ok(Arc::new(DropNode::new(OUT_INO, self.0.clone(), MAX_MESSAGE))),
            false => Err(Errno::ENOENT),
        }
    }

    async fn open(&self, _options: OpenOptions) -> FsResult<Box<dyn Handle>> {
        Ok(Box::new(RootHandle))
    }
}

struct RootHandle;

#[async_trait(?Send)]
impl Handle for RootHandle {
    async fn readdir(&self, cookie: u64, sink: &mut dyn DirSink) -> FsResult<()> {
        if cookie == 0 {
            sink.push(DirEntry {
                name: OUT.as_bytes(),
                ino: OUT_INO,
                file_type: FileType::Regular,
                next: 1,
            });
        }
        Ok(())
    }
}
