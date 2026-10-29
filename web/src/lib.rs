//! One WASIX v2 machine per page, with its network behind a WISP server and the page's terminal
//! as its console. The page runs programs on it one after another, so files they write (clai's
//! config in `~/.config`) stay between runs.

use std::collections::VecDeque;
use std::io;
use std::rc::Rc;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use js_sys::Promise;
use wasixv2::{
    ByteSink, ByteSource, Console, Engine, LocalFuture, Machine, MachineBuilder, OwnedBuffer,
    ProcessConfig, Signaller, Stdio, WebHost, WindowSize,
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

/// A program compiled once, to run as many times as the page likes.
#[wasm_bindgen]
pub struct Program(Rc<(Engine, Module)>);

/// Compiles `bytes` with the preemption points the kernel needs. Browsers compile a module
/// over 8 MB only asynchronously on the page's thread, which `Machine::run_process` does not.
#[wasm_bindgen]
pub async fn compile(bytes: Vec<u8>) -> Result<Program, JsError> {
    let engine = Engine::default();
    let module = match wasixv2::instrument(&bytes) {
        Ok(instrumented) => Module::new_async(&engine, instrumented).await,
        Err(err) => {
            wasixv2::warn_not_preemptible(&err);
            Module::new_async(&engine, bytes).await
        }
    }
    .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(Program(Rc::new((engine, module))))
}

#[wasm_bindgen]
pub struct Shell {
    machine: Rc<Machine>,
    signaller: Signaller,
    input: Arc<Input>,
    output: Output,
}

/// Boots the machine; its traffic leaves through the WISP server at `wisp_url`, its TLS
/// clients trust `ca_certificates`, a PEM bundle at `/etc/ssl/certs/ca-certificates.crt`, where
/// Debian keeps it and Go's `crypto/x509` looks first, and its console is a terminal of `rows`
/// by `cols` that [`Shell::type_input`] types into.
#[wasm_bindgen]
pub async fn boot(
    wisp_url: String,
    ca_certificates: Vec<u8>,
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
    let machine = MachineBuilder::new(Arc::new(WebHost::new()))
        .backend(Arc::new(backend))
        .console(console, [true; 3])
        .build();
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
    Ok(Shell {
        signaller: machine.signaller(),
        machine: Rc::new(machine),
        input,
        output,
    })
}

#[wasm_bindgen]
impl Shell {
    /// Runs `program` with `args` (`args[0]` is its name) and `env` (`KEY=VALUE`) on top of
    /// a login's, with the console as its standard streams and controlling terminal, and
    /// resolves to its exit status. What it prints collects for [`Shell::take_output`].
    pub fn run(&self, program: &Program, args: Vec<String>, env: Vec<String>) -> Promise {
        let (machine, program) = (self.machine.clone(), program.0.clone());
        let mut login = machine.default_env();
        login.push("TERM=xterm-256color".into());
        let env = [login, env].concat();
        // Unused: the console takes descriptors 0, 1 and 2.
        let stdio = Stdio::from_fns(|_| {}, |_| {});
        let config = ProcessConfig { args, env, stdio };
        future_to_promise(async move {
            let (engine, module) = &*program;
            let status = machine
                .run_module(engine, module, config)
                .await
                .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(JsValue::from(status))
        })
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

    /// The terminal is now `rows` by `cols`; the console's foreground group gets SIGWINCH.
    pub fn resize(&self, rows: u16, cols: u16) {
        self.signaller.console_resize(window_size(rows, cols));
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
