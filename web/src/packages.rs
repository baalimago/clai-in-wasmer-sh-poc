//! Wasmer registry packages on the machine, as `wasmer run` installs a package tree: each
//! command's atom is an executable file at `/bin/<name>` and `/usr/bin/<name>`, which WASIX v1
//! programs start with the command's `wasi` annotation, and each volume is mounted where the
//! package's filesystem table says.

use std::fmt;

use wasixv2::{CommandDefaults, Layer, Machine, OwnedBuffer};
use webc::metadata::annotations::{Atom, Wasi};
use webc::v3::read::OwnedReader;

#[derive(Debug)]
pub struct Error(String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

pub struct Package {
    name: String,
    reader: OwnedReader,
}

impl Package {
    pub fn parse(webc: Vec<u8>) -> Result<Self, Error> {
        let reader = OwnedReader::parse(webc)
            .map_err(|e| Error(format!("a package is not a webc v3 file: {e}")))?;
        let name = reader
            .manifest()
            .wapm()
            .ok()
            .flatten()
            .and_then(|wapm| wapm.name)
            .unwrap_or_else(|| "a package".into());
        Ok(Self { name, reader })
    }

    fn atom(&self, name: &str) -> Option<OwnedBuffer> {
        self.reader.get_atom(name).map(|(_, atom)| atom.clone())
    }
}

/// A file for `/bin` and `/usr/bin`, and what v1 programs that start it pass along.
struct Command {
    name: String,
    atom: OwnedBuffer,
    defaults: Option<CommandDefaults>,
}

/// Installs `first`, files under their names, then the commands of `packages`, of which the
/// earlier keeps a name two share, and mounts their volumes. Without a package command `sh`,
/// bash's is `sh` too, since programs run `sh -c`. Resolves to the commands and volumes left
/// out, and why.
pub async fn install(
    machine: &mut Machine,
    packages: &[Package],
    first: Vec<(String, OwnedBuffer)>,
) -> Result<Vec<String>, Error> {
    let mut notes = Vec::new();
    let mut commands: Vec<Command> = first
        .into_iter()
        .map(|(name, atom)| Command {
            name,
            atom,
            defaults: None,
        })
        .collect();
    for package in packages {
        commands.extend(package_commands(package, packages, &mut notes)?);
    }
    if !commands.iter().any(|c| c.name == "sh")
        && let Some(bash) = commands.iter().find(|c| c.name == "bash")
    {
        commands.push(Command {
            name: "sh".into(),
            atom: bash.atom.clone(),
            defaults: bash.defaults.clone(),
        });
    }

    let (mut root, mounts) = volumes(machine, packages, &mut notes)?;
    let files = commands.iter().map(|c| (c.name.clone(), c.atom.clone()));
    root.extend(
        machine
            .commands_layer(files)
            .map_err(|e| Error(format!("cannot install the commands: {e}")))?,
    );
    machine
        .mount_root_layers(root)
        .await
        .map_err(|e| Error(format!("cannot stack the packages under /: {e}")))?;
    let defaults = commands
        .into_iter()
        .filter_map(|c| Some((c.name, c.defaults?)));
    machine
        .set_wasix1_command_defaults(defaults)
        .map_err(|e| Error(format!("cannot set the commands' defaults: {e}")))?;
    for (path, layer) in mounts {
        machine
            .mount_layer(&path, &layer, true)
            .await
            .map_err(|e| Error(format!("cannot mount a package volume at {path}: {e}")))?;
    }
    Ok(notes)
}

/// The atom of a command is in its package, or, for an atom of a dependency, in another of
/// `packages`.
fn package_commands(
    package: &Package,
    packages: &[Package],
    notes: &mut Vec<String>,
) -> Result<Vec<Command>, Error> {
    let mut commands = Vec::new();
    for (name, command) in &package.reader.manifest().commands {
        let invalid = |e| Error(format!("{}: the command {name}: {e}", package.name));
        let wasi = command.annotation::<Wasi>(Wasi::KEY).map_err(invalid)?;
        let atom = command.annotation::<Atom>(Atom::KEY).map_err(invalid)?;
        // Older packages name the atom in the `wasi` annotation only.
        #[allow(deprecated)]
        let wasi_atom = wasi.as_ref().map(|w| w.atom.clone());
        let Some(atom_name) = atom.map(|a| a.name).or(wasi_atom) else {
            notes.push(format!(
                "{}: the command {name} names no atom",
                package.name
            ));
            continue;
        };
        let found = package
            .atom(&atom_name)
            .or_else(|| packages.iter().find_map(|p| p.atom(&atom_name)));
        let Some(atom) = found else {
            notes.push(format!(
                "{}: the command {name}: no package has the atom {atom_name}",
                package.name
            ));
            continue;
        };
        let defaults = wasi.map(|wasi| CommandDefaults {
            argv0: wasi.exec_name,
            args: wasi.main_args.unwrap_or_default(),
            env: wasi.env.unwrap_or_default(),
        });
        commands.push(Command {
            name: name.clone(),
            atom,
            defaults,
        });
    }
    Ok(commands)
}

/// The layers of the volumes mounted at `/`, each over the ones before it, and the other
/// volumes with where they go, parents first. An earlier package's volumes, and an earlier
/// mapping's in a package, obscure later ones.
#[allow(clippy::type_complexity)]
fn volumes(
    machine: &Machine,
    packages: &[Package],
    notes: &mut Vec<String>,
) -> Result<(Vec<Layer>, Vec<(String, Layer)>), Error> {
    let (mut root, mut mounts) = (Vec::new(), Vec::new());
    for package in packages.iter().rev() {
        let table = package
            .reader
            .manifest()
            .filesystem()
            .map_err(|e| Error(format!("{}: invalid filesystem table: {e}", package.name)))?
            .unwrap_or_default();
        for mapping in table.0.iter().rev() {
            if let Some(dependency) = &mapping.from {
                notes.push(format!(
                    "{}: {} is a volume of {dependency}, which is not mounted",
                    package.name, mapping.mount_path
                ));
                continue;
            }
            let layer = machine
                .package_layer(&package.reader, &mapping.volume_name)
                .map_err(|e| {
                    let volume = &mapping.volume_name;
                    Error(format!("{}: the volume {volume}: {e}", package.name))
                })?;
            match mapping.mount_path.trim_end_matches('/') {
                "" => root.push(layer),
                path => mounts.push((path.to_string(), layer)),
            }
        }
    }
    mounts.sort_by_key(|(path, _)| path.matches('/').count());
    Ok((root, mounts))
}
