//! One WASIX v2 machine per page, with its network behind a WISP server. The page runs programs
//! on it one after another, so files they write (clai's config in `~/.config`) stay between runs.

use std::rc::Rc;
use std::sync::{Arc, Mutex};

use js_sys::Promise;
use wasixv2::{Engine, Machine, MachineBuilder, OwnedBuffer, ProcessConfig, Stdio, WebHost};
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
    output: Output,
}

/// Boots the machine; its traffic leaves through the WISP server at `wisp_url`, and its TLS
/// clients trust `ca_certificates`, a PEM bundle at `/etc/ssl/certs/ca-certificates.crt`, where
/// Debian keeps it and Go's `crypto/x509` looks first.
#[wasm_bindgen]
pub async fn boot(wisp_url: String, ca_certificates: Vec<u8>) -> Result<Shell, JsError> {
    let backend = wasixv2_vnet_wisp::web::connect(&wisp_url)
        .map_err(|e| JsError::new(&format!("cannot open {wisp_url}: {e:?}")))?;
    let machine = MachineBuilder::new(Arc::new(WebHost::new()))
        .backend(Arc::new(backend))
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
        machine: Rc::new(machine),
        output: Output::default(),
    })
}

#[wasm_bindgen]
impl Shell {
    /// Runs `program` with `args` (`args[0]` is its name) and `env` (`KEY=VALUE`) on top of
    /// a login's, and resolves to its exit status. What it prints collects for
    /// [`Shell::take_output`].
    pub fn run(&self, program: &Program, args: Vec<String>, env: Vec<String>) -> Promise {
        let (machine, program) = (self.machine.clone(), program.0.clone());
        let mut login = machine.default_env();
        login.push("TERM=xterm-256color".into());
        let env = [login, env].concat();
        let stdio = Stdio::from_fns(self.output.sink(), self.output.sink());
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

    /// What programs printed, stdout and stderr interleaved, since the last call.
    pub fn take_output(&self) -> Vec<u8> {
        std::mem::take(&mut *self.output.0.lock().unwrap())
    }
}

#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl Output {
    fn sink(&self) -> impl Fn(&[u8]) + Send + Sync + 'static {
        let bytes = self.0.clone();
        move |data| bytes.lock().unwrap().extend_from_slice(data)
    }
}
