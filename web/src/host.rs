//! The page as the machine's host: [`WebHost`]'s clocks, entropy and executor, and the page's own
//! `fetch` for `http-open`, so a guest that cannot terminate TLS reaches an `https` URL anyway
//! ([`crate::jshttp`]). (2026-11-04 research/http-host-call/PROMPT.md)

use std::{
    collections::VecDeque,
    io,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
    time::Duration,
};

use wasixv2::{
    ByteSource, Executor, Host, HttpRequest, HttpResponse, LocalFuture, WebHost,
};
use wasm_bindgen_futures::spawn_local;
use web_sys::{AbortController, ReadableStreamDefaultReader};

use crate::jshttp;

/// What the page's `fetch` gives a guest that asks for one request as data.
pub struct PageHost(WebHost);

impl PageHost {
    pub fn new() -> Self {
        Self(WebHost::new())
    }
}

impl Host for PageHost {
    fn realtime(&self) -> Duration {
        self.0.realtime()
    }

    fn monotonic(&self) -> Duration {
        self.0.monotonic()
    }

    fn sleep(&self, duration: Duration) -> LocalFuture<'_, ()> {
        self.0.sleep(duration)
    }

    fn sleep_until(&self, deadline: Duration) -> LocalFuture<'_, ()> {
        self.0.sleep_until(deadline)
    }

    fn random(&self, buf: &mut [u8]) {
        self.0.random(buf)
    }

    fn executor(&self) -> &dyn Executor {
        self.0.executor()
    }

    fn report(&self, message: &str) {
        self.0.report(message)
    }

    fn http_open(&self, request: HttpRequest) -> LocalFuture<'_, io::Result<HttpResponse>> {
        Box::pin(async move {
            let exchange =
                jshttp::open(&request.url, &request.method, &request.headers, &request.body)
                    .await
                    .map_err(|why| io::Error::new(io::ErrorKind::ConnectionRefused, why))?;
            let jshttp::Exchange {
                status,
                headers,
                reader,
                controller,
            } = exchange;
            let body = Arc::new(Body::new(reader, controller));
            Ok(HttpResponse {
                status,
                headers,
                body,
            })
        })
    }
}

/// A response's body while it streams: a task pulls the browser's chunks into a buffer that the
/// kernel's reads take. The descriptor going away aborts the request, as `close` abandons a
/// socket's ([one request per handle](../../../research/http-host-call/PROMPT.md)).
struct Body {
    state: Arc<Mutex<State>>,
    controller: AbortController,
}

#[derive(Default)]
struct State {
    data: VecDeque<u8>,
    /// Set once, after the data: the end of the body, or why it stopped.
    end: Option<Result<(), String>>,
    /// The kernel's reader, woken as chunks arrive.
    waker: Option<Waker>,
}

impl Body {
    fn new(reader: Option<ReadableStreamDefaultReader>, controller: AbortController) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        match reader {
            Some(reader) => {
                let shared = state.clone();
                spawn_local(async move {
                    loop {
                        match jshttp::next(&reader).await {
                            Ok(Some(chunk)) => shared.lock().unwrap().push(chunk),
                            Ok(None) => return shared.lock().unwrap().finish(Ok(())),
                            Err(why) => return shared.lock().unwrap().finish(Err(why)),
                        }
                    }
                });
            }
            None => state.lock().unwrap().finish(Ok(())),
        }
        Self { state, controller }
    }
}

impl State {
    fn push(&mut self, chunk: Vec<u8>) {
        self.data.extend(chunk);
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }

    fn finish(&mut self, end: Result<(), String>) {
        self.end = Some(end);
        if let Some(waker) = self.waker.take() {
            waker.wake();
        }
    }
}

impl ByteSource for Body {
    fn poll_read(&self, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<io::Result<usize>> {
        let mut state = self.state.lock().unwrap();
        let n = buf.len().min(state.data.len());
        for (dst, src) in buf.iter_mut().zip(state.data.drain(..n)) {
            *dst = src;
        }
        if n > 0 {
            return Poll::Ready(Ok(n));
        }
        match &state.end {
            Some(Ok(())) => Poll::Ready(Ok(0)),
            Some(Err(why)) => Poll::Ready(Err(io::Error::new(
                io::ErrorKind::ConnectionReset,
                why.clone(),
            ))),
            None => {
                state.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl Drop for Body {
    fn drop(&mut self) {
        self.controller.abort();
    }
}