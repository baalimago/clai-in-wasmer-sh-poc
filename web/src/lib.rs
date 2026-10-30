//! One WASIX v2 machine per page, with its network behind a WISP server and the page's terminal
//! as its console. Its `/bin` holds clai and the commands of Wasmer registry packages (WASIX v1
//! programs, which the kernel's v1 compatibility ABI runs). The page runs programs on it one
//! after another, so files they write (clai's config in `~/.config`) stay between runs.

mod audio;
mod packages;

use std::collections::{HashMap, VecDeque};
use std::io;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use js_sys::{Promise, Uint8Array};
use wasixv2::{
    ByteSink, ByteSource, Console, Engine, Image, ImageId, LoadError, Loader, LocalFuture, Machine,
    MachineBuilder, OwnedBuffer, ProcessConfig, RunError, Signaller, Stdio, WebHost, WindowSize,
};
use wasixv2_vfs_package::PackageFs;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use wasmer::Module;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn error(message: &str);
}

/// Panics show in the console instead of as a bare `unreachable` trap.
#[wasm_bindgen(start)]
fn start() {
    std::panic::set_hook(Box::new(|info| error(&info.to_string())));
}

#[wasm_bindgen]
pub struct Shell {
    machine: Rc<Machine>,
    signaller: Signaller,
    input: Arc<Input>,
    output: Output,
    audio: Arc<audio::AudioFs>,
    notes: Vec<String>,
}

/// The page's audio inputs, files in `/run/audio`: the microphone, and the tab, window or
/// screen the user shares.
const AUDIO_INPUTS: [&str; 2] = ["mic", "tab"];

/// Boots the machine; its traffic leaves through the WISP server at `wisp_url`, its TLS
/// clients trust `ca_certificates`, a PEM bundle at `/etc/ssl/certs/ca-certificates.crt`, where
/// Debian keeps it and Go's `crypto/x509` looks first, and its console is a terminal of `rows`
/// by `cols` that [`Shell::type_input`] types into. `/bin` holds `programs` (clai, the MCP
/// server ports and the npx and uvx that start them) under `names`, and the commands of
/// `packages`, webc v3 files, of which the earlier has a name two of them share; their volumes
/// are mounted where the packages say. `/usr/local/bin`, first on `PATH`, holds `local_programs`
/// under `local_names`: wrappers that come before the commands they wrap. The page's audio
/// inputs are files in `/run/audio` (see [`audio`]).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub async fn boot(
    wisp_url: String,
    ca_certificates: Vec<u8>,
    names: Vec<String>,
    programs: Vec<Uint8Array>,
    local_names: Vec<String>,
    local_programs: Vec<Uint8Array>,
    packages: Vec<Uint8Array>,
    rows: u16,
    cols: u16,
) -> Result<Shell, JsError> {
    let backend = wasixv2_vnet_wisp::web::connect(&wisp_url)
        .map_err(|e| JsError::new(&format!("cannot open {wisp_url}: {e:?}")))?;
    let input = Arc::new(Input::default());
    let output = Output::default();
    let console = Console {
        input: input.clone(),
        output: Arc::new(output.clone()),
        size: window_size(rows, cols),
    };
    let mut machine = MachineBuilder::new(Arc::new(WebHost::new()))
        .backend(Arc::new(backend))
        .console(console, [true; 3])
        .loader(Arc::new(Cache::default()))
        .build();
    let packages = packages
        .iter()
        .map(|bytes| packages::Package::parse(bytes.to_vec()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| JsError::new(&e.to_string()))?;
    if names.len() != programs.len() {
        return Err(JsError::new(&format!(
            "{} program names for {} programs",
            names.len(),
            programs.len()
        )));
    }
    let programs = names
        .into_iter()
        .zip(programs.iter().map(|bytes| OwnedBuffer::from(bytes.to_vec())))
        .collect();
    let notes = packages::install(&mut machine, &packages, programs)
        .await
        .map_err(|e| JsError::new(&e.to_string()))?;
    let certs = PackageFs::from_files(
        [(
            "ca-certificates.crt".into(),
            OwnedBuffer::from(ca_certificates),
        )],
        0,
        0,
    )
    .map_err(|e| JsError::new(&format!("cannot hold the CA certificates: {e}")))?;
    machine
        .mount("/etc/ssl/certs", Arc::new(certs), true)
        .await
        .map_err(|e| JsError::new(&format!("cannot mount /etc/ssl/certs: {e}")))?;
    if local_names.len() != local_programs.len() {
        return Err(JsError::new(&format!(
            "{} local program names for {} programs",
            local_names.len(),
            local_programs.len()
        )));
    }
    if !local_names.is_empty() {
        let files = local_names
            .into_iter()
            .zip(local_programs.iter().map(|bytes| OwnedBuffer::from(bytes.to_vec())));
        let local = PackageFs::from_files(files, 0, 0)
            .map_err(|e| JsError::new(&format!("cannot hold /usr/local/bin: {e}")))?;
        machine
            .mount("/usr/local/bin", Arc::new(local), true)
            .await
            .map_err(|e| JsError::new(&format!("cannot mount /usr/local/bin: {e}")))?;
    }
    let names = AUDIO_INPUTS.map(String::from);
    let audio = Arc::new(audio::AudioFs::new(&names).map_err(|e| JsError::new(&e.to_string()))?);
    machine
        .mount("/run/audio", audio.clone(), false)
        .await
        .map_err(|e| JsError::new(&format!("cannot mount /run/audio: {e}")))?;
    Ok(Shell {
        audio,
        signaller: machine.signaller(),
        machine: Rc::new(machine),
        input,
        output,
        notes,
    })
}

#[wasm_bindgen]
impl Shell {
    /// Runs the file at `path` with `args` (`args[0]` is its name) and `env` (`KEY=VALUE`) on
    /// top of a login's, with the console as its standard streams and controlling terminal,
    /// and resolves to its exit status. What it prints collects for [`Shell::take_output`].
    pub fn run(&self, path: String, args: Vec<String>, env: Vec<String>) -> Promise {
        let machine = self.machine.clone();
        let mut login = self.login_env();
        login.push("TERM=xterm-256color".into());
        let env = [login, env].concat();
        // Unused: the console takes descriptors 0, 1 and 2.
        let stdio = Stdio::from_fns(|_| {}, |_| {});
        let config = ProcessConfig { args, env, stdio };
        future_to_promise(async move {
            let status = machine
                .run_file(&Engine::default(), &path, config)
                .await
                .map_err(|e| JsError::new(&describe(e)))?;
            Ok(JsValue::from(status))
        })
    }

    /// The environment of a login, which [`Shell::run`] gives every program.
    pub fn login_env(&self) -> Vec<String> {
        self.machine.default_env()
    }

    /// What [`boot`] left out of `/bin`, and why.
    pub fn notes(&self) -> Vec<String> {
        self.notes.clone()
    }

    /// What the console showed since the last call.
    pub fn take_output(&self) -> Vec<u8> {
        std::mem::take(&mut *self.output.0.lock().unwrap())
    }

    /// Types `bytes` on the console, as a terminal's keyboard does: the kernel's line
    /// discipline echoes and edits them, and turns `^C` into SIGINT.
    pub fn type_input(&self, bytes: &[u8]) {
        self.input.push(bytes);
    }

    /// The audio inputs whose files something has open, which the page should capture.
    pub fn audio_wanted(&self) -> Vec<String> {
        self.audio.open_inputs()
    }

    /// Audio the page captured from input `name`: 16-bit little-endian mono samples at 48 kHz.
    pub fn push_audio(&self, name: &str, samples: &[u8]) -> Result<(), JsError> {
        if self.audio.push(name, samples) {
            Ok(())
        } else {
            Err(JsError::new(&format!("no audio input {name}")))
        }
    }

    /// The sound files written to `/run/audio/play` since the last call, for the page to play.
    pub fn take_played(&self) -> Vec<Uint8Array> {
        self.audio.take_played().iter().map(|s| Uint8Array::from(s.as_slice())).collect()
    }

    /// The terminal is now `rows` by `cols`; the console's foreground group gets SIGWINCH.
    pub fn resize(&self, rows: u16, cols: u16) {
        self.signaller.console_resize(window_size(rows, cols));
    }
}

/// `err`, saying what an errno is: wasm32-unknown-unknown's `io::Error` has no messages.
fn describe(err: RunError) -> String {
    let RunError::Execve { path, err } = err else {
        return err.to_string();
    };
    match err.raw_os_error() {
        Some(2) => format!("{path}: no such file or directory"),
        Some(8) => format!("{path}: not a program the machine runs"),
        Some(13) => format!("{path}: permission denied"),
        _ => format!("cannot execute {path}: {err:?}"),
    }
}

/// Compiles each program once: `/bin`'s files are the packages' buffers, so an image of one
/// is the same bytes at the same address each time it starts. Browsers compile a module over
/// 8 MB synchronously only in workers, where the machine runs. An entry holds its image's
/// bytes, so no other image gets its identity.
#[derive(Default)]
struct Cache(Mutex<HashMap<ImageId, Loaded>>);

type Loaded = (Engine, Module, Arc<dyn AsRef<[u8]> + Send + Sync>);

impl Loader for Cache {
    fn load<'a>(
        &'a self,
        engine: &'a Engine,
        image: &'a Image,
    ) -> LocalFuture<'a, Result<(Engine, Module), LoadError>> {
        Box::pin(async move {
            let id = image.identity();
            if let Some((engine, module, _)) =
                id.and_then(|id| self.0.lock().unwrap().get(&id).cloned())
            {
                return Ok((engine, module));
            }
            let module = wasixv2::load(engine, image.bytes())?;
            if let Some(id) = id {
                let loaded = (engine.clone(), module.clone(), image.keep_alive());
                self.0.lock().unwrap().insert(id, loaded);
            }
            Ok((engine.clone(), module))
        })
    }
}

fn window_size(rows: u16, cols: u16) -> WindowSize {
    WindowSize {
        rows,
        cols,
        ..WindowSize::default()
    }
}

/// What is typed on the console, until its input pump takes it. It never ends: an end would
/// hang the console up.
#[derive(Default)]
struct Input(Mutex<(VecDeque<u8>, Option<Waker>)>);

impl Input {
    fn push(&self, bytes: &[u8]) {
        let mut state = self.0.lock().unwrap();
        state.0.extend(bytes);
        if let Some(waker) = state.1.take() {
            waker.wake();
        }
    }
}

impl ByteSource for Input {
    fn poll_read(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let mut state = self.0.lock().unwrap();
        if state.0.is_empty() {
            state.1 = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let n = buf.len().min(state.0.len());
        for (slot, byte) in buf.iter_mut().zip(state.0.drain(..n)) {
            *slot = byte;
        }
        Poll::Ready(Ok(n))
    }
}

/// What the console shows, until the page takes it.
#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl ByteSink for Output {
    fn write<'a>(&'a self, data: &'a [u8]) -> LocalFuture<'a, io::Result<usize>> {
        self.0.lock().unwrap().extend_from_slice(data);
        Box::pin(async move { Ok(data.len()) })
    }
}
