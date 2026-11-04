//! The machine's network without a proxy: the guest's plaintext HTTP/1.1 goes out as the page's
//! `fetch`, so a copy of this page served as files alone still reaches what a browser may reach.
//!
//! A browser has no sockets. Every connection must be a request its origin is allowed to make,
//! and the browser decides that by CORS, so this backend carries one request per connection and
//! closes the connection when the body ends, which is how the guest reads the body's end
//! ([`httpwire::response_head`] writes `Connection: close`). Only `http://` reaches it: a guest
//! that does its own TLS, as clai does for `https://`, sends a ClientHello this cannot read, and
//! the page says so (see [`FetchBackend::take_notes`]).

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};

use httpwire::{Call, RequestParser, Step};
use wasixv2_abi::Errno;
use wasixv2_vnet::{
    Backend, BackendDatagram, BackendStream, Domain, InboundSink, Lookup, LookupDone, PollMask,
    PollTable, Pollable, Publication, Shutdown, StreamState, WaitQueue,
};
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::spawn_local;

use crate::{jshttp, names::Names};

/// Request headers the browser sets itself, or that describe a connection a fetch does not have.
/// A request that carries one has it dropped rather than refused: they are hop-by-hop.
const HOP_BY_HOP: [&str; 10] = [
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "user-agent",
    "cookie",
    "te",
    "trailer",
    "upgrade",
    "keep-alive",
];

/// The most notes kept between takes: a guest retrying a refused request must not grow them
/// without bound while the page reads them.
const MAX_NOTES: usize = 100;

/// The machine's network as the page's `fetch` calls. Clones share the streams and the notes.
#[derive(Clone)]
pub struct FetchBackend(Arc<Inner>);

struct Inner {
    net: Mutex<Net>,
    notes: Mutex<Vec<String>>,
}

struct Net {
    names: Names,
    streams: HashMap<u32, Weak<Stream>>,
    next_id: u32,
}

impl FetchBackend {
    pub fn new() -> Self {
        Self(Arc::new(Inner {
            net: Mutex::new(Net {
                names: Names::default(),
                streams: HashMap::new(),
                next_id: 1,
            }),
            notes: Mutex::new(Vec::new()),
        }))
    }

    /// The name behind an address this backend handed out, for the page's view of what a
    /// process connected to.
    pub fn host_for(&self, addr: IpAddr) -> Option<String> {
        self.0.net().names.host_for(addr)
    }

    /// Why something could not be carried, once: what the browser refused, or a guest that
    /// wanted a socket this backend does not have. The page shows them in its terminal.
    pub fn take_notes(&self) -> Vec<String> {
        std::mem::take(&mut *self.0.notes())
    }

}

impl crate::observe::Hosts for FetchBackend {
    fn host_for(&self, addr: IpAddr) -> Option<String> {
        self.host_for(addr)
    }
}

impl Inner {
    fn net(&self) -> MutexGuard<'_, Net> {
        self.net.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn notes(&self) -> MutexGuard<'_, Vec<String>> {
        self.notes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn note(&self, text: String) {
        let mut notes = self.notes();
        if notes.len() >= MAX_NOTES {
            notes.remove(0);
        }
        notes.push(text);
    }
}

impl Backend for FetchBackend {
    fn connect(&self, peer: SocketAddr, wq: WaitQueue) -> Result<Arc<dyn BackendStream>, Errno> {
        let mut net = self.0.net();
        let host = net.names.host_for(peer.ip()).ok_or(Errno::EHOSTUNREACH)?;
        let id = net.next_id;
        net.next_id = id.wrapping_add(1).max(1);
        let stream = Stream::new(peer, host, wq, self.0.clone());
        let _ = stream.me.set(Arc::downgrade(&stream));
        net.streams.retain(|_, s| s.strong_count() > 0);
        net.streams.insert(id, Arc::downgrade(&stream));
        Ok(stream)
    }

    fn datagram(&self, _: Domain, _: WaitQueue) -> Result<Arc<dyn BackendDatagram>, Errno> {
        Err(Errno::EPERM)
    }

    fn publish(
        &self,
        _: SocketAddr,
        _: u32,
        _: Arc<dyn InboundSink>,
    ) -> Result<Box<dyn Publication>, io::Error> {
        Err(io::ErrorKind::Unsupported.into())
    }

    fn lookup(&self, lookup: Lookup, done: LookupDone) {
        done(self.0.net().names.lookup(&lookup));
    }
}

/// One connection, which carries one request.
struct Stream {
    peer: SocketAddr,
    /// The authority the guest connected to, which the request's `Host` usually repeats.
    host: String,
    wq: WaitQueue,
    inner: Arc<Inner>,
    conn: Mutex<Conn>,
    /// The stream as the network holds it, so the request it starts can outlive the write that
    /// completed it.
    me: OnceLock<Weak<Stream>>,
}

struct Conn {
    parser: RequestParser,
    started: bool,
    rx: VecDeque<u8>,
    eof: bool,
    err: Option<Errno>,
    closed: bool,
    rd_shut: bool,
    wr_shut: bool,
    /// Aborts the request when the guest closes before the response ends.
    abort: Option<JsValue>,
}

impl Stream {
    fn new(peer: SocketAddr, host: String, wq: WaitQueue, inner: Arc<Inner>) -> Arc<Self> {
        Arc::new(Self {
            peer,
            host,
            wq,
            inner,
            conn: Mutex::new(Conn {
                parser: RequestParser::default(),
                started: false,
                rx: VecDeque::new(),
                eof: false,
                err: None,
                closed: false,
                rd_shut: false,
                wr_shut: false,
                abort: None,
            }),
            me: OnceLock::new(),
        })
    }

    fn conn(&self) -> MutexGuard<'_, Conn> {
        self.conn.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn note(&self, text: String) {
        self.inner.note(text);
    }

    fn fail(&self, errno: Errno) {
        {
            let mut conn = self.conn();
            conn.closed = true;
            conn.err = Some(errno);
            conn.rx.clear();
        }
        self.wq
            .wake(PollMask::ERR | PollMask::HUP | PollMask::IN | PollMask::OUT);
    }

    fn received(&self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.conn().rx.extend(bytes);
        self.wq.wake(PollMask::IN | PollMask::RDNORM);
    }

    fn finish(&self) {
        self.conn().eof = true;
        self.wq
            .wake(PollMask::IN | PollMask::RDNORM | PollMask::RDHUP);
    }

    fn abort_handle(&self, abort: JsValue) {
        self.conn().abort = Some(abort);
    }

    /// The URL the request goes to: the authority the guest named, as https on the standard
    /// ports, which is what a browser makes requests to. Other ports stay as written, so a test
    /// server on this page's own host is reachable.
    fn url(&self, call: &Call) -> Option<String> {
        let authority = call.host().unwrap_or(self.host.as_str());
        let (host, port) = httpwire::authority(authority);
        let (scheme, authority) = if port == 80 || port == 443 {
            ("https", host.to_string())
        } else {
            ("http", format!("{host}:{port}"))
        };
        let target = if call.target.starts_with('/') {
            call.target.clone()
        } else {
            format!("/{}", call.target)
        };
        Some(format!("{scheme}://{authority}{target}"))
    }

    fn start(&self, call: Call) {
        let Some(url) = self.url(&call) else {
            self.note("a request named no Host, so a browser cannot make it".into());
            self.fail(Errno::EPROTO);
            return;
        };
        let Some(stream) = self.me.get().and_then(Weak::upgrade) else {
            return;
        };
        let headers: Vec<(String, String)> = call
            .headers
            .iter()
            .filter(|(name, _)| !HOP_BY_HOP.contains(&name.as_str()))
            .cloned()
            .collect();
        spawn_local(run(Arc::downgrade(&stream), call.method, url, headers, call.body));
    }
}

/// Carries one request through the page's `fetch`, then its body, into the guest's socket.
async fn run(
    stream: Weak<Stream>,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
) {
    let Some(stream) = stream.upgrade() else {
        return;
    };
    let exchange = match jshttp::open(&url, &method, &headers, &body).await {
        Ok(exchange) => exchange,
        Err(why) => {
            stream.note(format!("{method} {url}: {why}"));
            stream.fail(Errno::ECONNREFUSED);
            return;
        }
    };
    stream.abort_handle(exchange.controller.into());
    stream.received(&httpwire::response_head(exchange.status, &exchange.headers));
    if let Some(reader) = exchange.reader {
        loop {
            match jshttp::next(&reader).await {
                Ok(Some(chunk)) => stream.received(&chunk),
                Ok(None) => break,
                Err(why) => {
                    stream.note(format!("{method} {url}: the body stopped: {why}"));
                    stream.fail(Errno::ECONNRESET);
                    return;
                }
            }
        }
    }
    stream.finish();
}

impl Drop for Stream {
    fn drop(&mut self) {
        if let Some(abort) = self.conn().abort.take() {
            jshttp::abort(&abort);
        }
    }
}

impl Pollable for Stream {
    fn poll(&self, _: Option<&mut PollTable<'_>>) -> PollMask {
        let conn = self.conn();
        let mut m = PollMask::empty();
        if conn.err.is_some() {
            m |= PollMask::ERR;
        }
        if conn.closed {
            return m
                | PollMask::HUP
                | PollMask::IN
                | PollMask::RDNORM
                | PollMask::RDHUP
                | PollMask::OUT
                | PollMask::WRNORM;
        }
        let rcv_shut = conn.eof || conn.rd_shut;
        let snd_shut = conn.eof || conn.wr_shut;
        if rcv_shut && snd_shut {
            m |= PollMask::HUP;
        }
        if rcv_shut {
            m |= PollMask::IN | PollMask::RDNORM | PollMask::RDHUP;
        }
        if !conn.rx.is_empty() {
            m |= PollMask::IN | PollMask::RDNORM;
        }
        if !conn.started || snd_shut {
            m |= PollMask::OUT | PollMask::WRNORM;
        }
        m
    }
}

impl BackendStream for Stream {
    fn state(&self) -> StreamState {
        // A browser has no connect step: the request leaves on the guest's first write, so the
        // connection is as established as it will ever be (the kernel completes `connect` on
        // `Established`, and would otherwise wait for a handshake that never comes).
        match self.conn().closed {
            true => StreamState::Closed,
            false => StreamState::Established,
        }
    }

    fn read(&self, buf: &mut [u8], peek: bool) -> Result<usize, Errno> {
        let mut conn = self.conn();
        let n = buf.len().min(conn.rx.len());
        for (dst, src) in buf.iter_mut().zip(conn.rx.iter()) {
            *dst = *src;
        }
        if !peek {
            conn.rx.drain(..n);
        }
        if n > 0 || (buf.is_empty() && !conn.rx.is_empty()) {
            return Ok(n);
        }
        if conn.eof {
            return Ok(0);
        }
        if let Some(e) = conn.err.take() {
            return Err(e);
        }
        if conn.rd_shut || conn.closed {
            return Ok(0);
        }
        Err(Errno::EAGAIN)
    }

    fn write(&self, data: &[u8]) -> Result<usize, Errno> {
        if data.is_empty() {
            return Ok(0);
        }
        let step = {
            let mut conn = self.conn();
            if let Some(e) = conn.err.take() {
                return Err(e);
            }
            if conn.closed || conn.eof || conn.wr_shut {
                return Err(Errno::EPIPE);
            }
            if conn.started {
                return Err(Errno::EAGAIN);
            }
            let step = conn.parser.push(data);
            if matches!(step, Step::Ready(_)) {
                conn.started = true;
            }
            step
        };
        match step {
            Step::Incomplete => Ok(data.len()),
            Step::Bad(httpwire::Bad(why)) => {
                self.note(why.to_string());
                self.fail(Errno::EPROTO);
                Err(Errno::EPROTO)
            }
            Step::Ready(call) => {
                self.start(call);
                Ok(data.len())
            }
        }
    }

    /// The browser carries no urgent data: the byte goes inline, without a mark.
    fn write_urgent(&self, data: &[u8]) -> Result<usize, Errno> {
        self.write(data)
    }

    fn read_urgent(&self, _: bool) -> Result<u8, Errno> {
        Err(Errno::EINVAL)
    }

    fn at_mark(&self) -> bool {
        false
    }

    fn shutdown(&self, how: Shutdown) -> Result<(), Errno> {
        {
            let mut conn = self.conn();
            match how {
                Shutdown::Read => conn.rd_shut = true,
                Shutdown::Write => conn.wr_shut = true,
                Shutdown::Both => {
                    conn.rd_shut = true;
                    conn.wr_shut = true;
                }
            }
        }
        self.wq.wake(PollMask::IN | PollMask::OUT);
        Ok(())
    }

    fn take_error(&self) -> Option<Errno> {
        self.conn().err.take()
    }

    fn peer_addr(&self) -> SocketAddr {
        self.peer
    }

    fn input_len(&self) -> usize {
        self.conn().rx.len()
    }
}

