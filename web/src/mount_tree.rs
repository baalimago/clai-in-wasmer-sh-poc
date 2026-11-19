//! A fetched set of files as one writable, in-memory machine mount.

use std::collections::HashSet;
use std::sync::Arc;

use wasixv2::{Filesystem, OwnedBuffer};
use wasixv2_vfs::{Clock, Timestamp};
use wasixv2_vfs_mem::MemFs;
use wasixv2_vfs_overlay::OverlayFs;
use wasixv2_vfs_package::PackageFs;

struct Epoch;

impl Clock for Epoch {
    fn now(&self) -> Timestamp {
        Timestamp::new(0, 0)
    }
}

/// Checks every name and constructs the complete filesystem before the caller changes the
/// machine. This is what makes rejection atomic.
pub(crate) fn filesystem(
    names: Vec<String>,
    files: Vec<Vec<u8>>,
) -> Result<Arc<dyn Filesystem>, String> {
    if names.len() != files.len() {
        return Err(format!("{} names for {} files", names.len(), files.len()));
    }

    let mut seen = HashSet::new();
    for name in &names {
        validate_name(name, &mut seen)?;
    }

    let files = names
        .into_iter()
        .zip(files.into_iter().map(OwnedBuffer::from));
    let lower: Arc<dyn Filesystem> =
        Arc::new(PackageFs::from_files(files, 1, 1).map_err(|e| format!("mount: {e}"))?);
    let upper: Arc<dyn Filesystem> = Arc::new(MemFs::new(Arc::new(Epoch), 0o755, 1, 1));
    Ok(OverlayFs::new(Some(upper), vec![lower]))
}

fn validate_name(name: &str, seen: &mut HashSet<String>) -> Result<(), String> {
    let reason = if name.is_empty() {
        Some("empty name")
    } else if name.starts_with('/') {
        Some("absolute name")
    } else if name.split('/').any(|part| part == "..") {
        Some("parent component")
    } else if name
        .split('/')
        .any(|part| part.is_empty() || part == "." || part.contains('\0'))
    {
        Some("invalid component")
    } else if !seen.insert(name.to_owned()) {
        Some("repeated name")
    } else {
        None
    };
    match reason {
        Some(reason) => Err(format!("mount: {name}: {reason}")),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use wasixv2_abi::OpenFlags;
    use wasixv2_vfs::{
        Cred, Ctx, DirEntry, DirSink, Errno, LookupFlags, MountFlags, OpenHow, Path, Vfs,
    };

    struct Machine {
        vfs: Arc<Vfs>,
        root: Path,
        cred: Cred,
    }

    impl Machine {
        fn boot() -> Self {
            let root_fs = Arc::new(MemFs::new(Arc::new(Epoch), 0o755, 1, 1));
            let vfs = Vfs::new(root_fs);
            let root = vfs.root();
            Self {
                vfs,
                root,
                cred: Cred::user(1, 1),
            }
        }

        fn cx(&self) -> Ctx<'_> {
            Ctx {
                cred: &self.cred,
                root: &self.root,
                umask: 0o022,
                task: 0,
                leases: None,
            }
        }

        fn mount_tree(&self, path: &str, names: Vec<String>, files: Vec<Vec<u8>>) -> Result<(), String> {
            let fs = filesystem(names, files)?;
            let flags = MountFlags {
                read_only: false,
                ..MountFlags::default()
            };
            block_on(self.vfs.mount(path.as_bytes(), fs, flags, true))
                .map_err(|e| format!("cannot mount {path}: {e:?}"))
        }

        fn mount_files(&self, path: &str, files: &[(&str, &[u8])]) -> Result<(), String> {
            self.mount_tree(
                path,
                files.iter().map(|(name, _)| (*name).to_owned()).collect(),
                files.iter().map(|(_, bytes)| bytes.to_vec()).collect(),
            )
        }

        fn mount_package(&self, path: &str, files: &[(&str, &[u8])]) {
            let entries = files
                .iter()
                .map(|(name, bytes)| ((*name).to_owned(), OwnedBuffer::from(bytes.to_vec())));
            let pkg = Arc::new(PackageFs::from_files(entries, 0, 0).unwrap());
            let flags = MountFlags {
                read_only: true,
                ..MountFlags::default()
            };
            block_on(self.vfs.mount(path.as_bytes(), pkg, flags, true)).unwrap();
        }

        fn read(&self, path: &str) -> Result<Vec<u8>, Errno> {
            let how = OpenHow {
                flags: OpenFlags::O_RDONLY,
                mode: 0,
                lookup: LookupFlags::follow(),
            };
            let file = block_on(self.vfs.open(&self.cx(), &self.root, path.as_bytes(), &how))?;
            let mut buf = vec![0; 128];
            let n = block_on(file.read_at(&mut buf, 0))?;
            buf.truncate(n);
            Ok(buf)
        }

        fn write(&self, path: &str, data: &[u8]) {
            let how = OpenHow {
                flags: OpenFlags::O_CREAT | OpenFlags::O_WRONLY | OpenFlags::O_TRUNC,
                mode: 0o644,
                lookup: LookupFlags::follow(),
            };
            let file = block_on(self.vfs.open(&self.cx(), &self.root, path.as_bytes(), &how))
                .unwrap();
            block_on(file.write_at(data, 0)).unwrap();
        }

        fn ls(&self, path: &str) -> Vec<String> {
            struct Names(Vec<String>);
            impl DirSink for Names {
                fn push(&mut self, entry: DirEntry<'_>) -> bool {
                    self.0.push(String::from_utf8_lossy(entry.name).into_owned());
                    true
                }
            }
            let how = OpenHow {
                flags: OpenFlags::O_RDONLY | OpenFlags::O_DIRECTORY,
                mode: 0,
                lookup: LookupFlags::follow(),
            };
            let dir = block_on(self.vfs.open(&self.cx(), &self.root, path.as_bytes(), &how))
                .unwrap();
            let mut names = Names(Vec::new());
            block_on(dir.readdir(0, &mut names)).unwrap();
            names.0
        }
    }

    /// T3-mount-tree-lands-at-the-path
    #[test]
    fn mount_tree_lands_at_the_path() {
        let m = Machine::boot();
        m.mount_package("/bin", &[("clai", b"clai-bin")]);
        m.mount_files("/usr/local/go", &[("a/b", b"nested"), ("top", b"top")])
            .unwrap();

        assert_eq!(m.read("/usr/local/go/a/b").unwrap(), b"nested");
        assert_eq!(m.read("/usr/local/go/top").unwrap(), b"top");

        let top_entries = m.ls("/usr/local/go");
        assert!(top_entries.contains(&"a".to_owned()), "{top_entries:?}");
        assert!(top_entries.contains(&"top".to_owned()), "{top_entries:?}");
        let sub_entries = m.ls("/usr/local/go/a");
        assert!(sub_entries.contains(&"b".to_owned()), "{sub_entries:?}");
        assert_eq!(m.read("/bin/clai").unwrap(), b"clai-bin");
    }

    /// T3-mount-tree-takes-writes
    #[test]
    fn mount_tree_takes_writes() {
        let m1 = Machine::boot();
        m1.mount_files("/usr/local/go", &[("seed", b"seed"), ("cache/00/entry", b"cached")])
            .unwrap();
        m1.write("/usr/local/go/x", b"later");
        block_on(m1.vfs.mkdir(&m1.cx(), &m1.root, b"/usr/local/go/cache/01", 0o755)).unwrap();
        m1.write("/usr/local/go/cache/01/new", b"written");
        assert_eq!(m1.read("/usr/local/go/x").unwrap(), b"later");
        assert_eq!(m1.read("/usr/local/go/seed").unwrap(), b"seed");
        assert_eq!(m1.read("/usr/local/go/cache/01/new").unwrap(), b"written");

        let m2 = Machine::boot();
        m2.mount_files("/usr/local/go", &[("seed", b"seed")]).unwrap();
        assert_eq!(m2.read("/usr/local/go/x"), Err(Errno::ENOENT));
    }

    /// T3-mount-tree-refuses-a-bad-name
    #[test]
    fn mount_tree_refuses_a_bad_name() {
        let m = Machine::boot();
        block_on(m.vfs.mkdir(&m.cx(), &m.root, b"/usr", 0o755)).unwrap();
        block_on(m.vfs.mkdir(&m.cx(), &m.root, b"/usr/local", 0o755)).unwrap();
        block_on(m.vfs.mkdir(&m.cx(), &m.root, b"/usr/local/go", 0o755)).unwrap();

        for bad in ["../x", "/x", ""] {
            let error = m
                .mount_tree("/usr/local/go", vec!["ok".into(), bad.into()], vec![vec![], vec![]])
                .unwrap_err();
            assert!(error.starts_with("mount: "), "{error:?}");
            if bad.is_empty() {
                assert!(error.contains("empty"), "{error:?}");
            } else {
                assert!(error.contains(bad), "{error:?}");
            }
            assert_eq!(m.read("/usr/local/go/ok"), Err(Errno::ENOENT));
        }

        let error = m
            .mount_tree("/usr/local/go", vec!["x".into(), "x".into()], vec![vec![], vec![]])
            .unwrap_err();
        assert_eq!(error, "mount: x: repeated name");
        assert_eq!(m.read("/usr/local/go/x"), Err(Errno::ENOENT));

        let error = m
            .mount_tree("/usr/local/go", vec!["x".into()], vec![])
            .unwrap_err();
        assert_eq!(error, "1 names for 0 files");
        assert_eq!(m.read("/usr/local/go/x"), Err(Errno::ENOENT));
    }

    /// T3-mount-tree-stacks
    #[test]
    fn mount_tree_stacks() {
        let m = Machine::boot();
        m.mount_files("/usr/local/go", &[("x", b"first")]).unwrap();
        assert_eq!(m.read("/usr/local/go/x").unwrap(), b"first");

        m.mount_files("/usr/local/go", &[("x", b"second")]).unwrap();
        assert_eq!(m.read("/usr/local/go/x").unwrap(), b"second");

        // Kernel mount rejection propagates the kernel's message.
        m.write("/notadir", b"file");
        let error = m.mount_files("/notadir", &[("x", b"v")]).unwrap_err();
        assert!(error.starts_with("cannot mount /notadir: "), "{error:?}");
    }

    /// T3-mount-tree-hides-no-command
    #[test]
    fn mount_tree_hides_no_command() {
        let m = Machine::boot();
        m.mount_package("/bin", &[("bash", b"bash-bin")]);
        m.mount_package("/usr/local/bin", &[("wrap", b"wrap-bin")]);

        assert_eq!(m.read("/bin/bash").unwrap(), b"bash-bin");
        assert_eq!(m.read("/bin/go"), Err(Errno::ENOENT));

        m.mount_files("/usr/local/go", &[("bin/go", b"go-bin")]).unwrap();

        assert_eq!(m.read("/bin/bash").unwrap(), b"bash-bin");
        assert_eq!(m.read("/usr/local/bin/wrap").unwrap(), b"wrap-bin");
        assert_eq!(m.read("/bin/go"), Err(Errno::ENOENT));
        assert_eq!(m.read("/usr/local/go/bin/go").unwrap(), b"go-bin");
    }
}
