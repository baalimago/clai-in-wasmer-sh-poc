//! The machine's sockets. A browser has none, and all of the guest's HTTP leaves through the host
//! call ([`crate::host`]), so this backend only answers name lookups, with addresses the page
//! hands out ([`Names`]), and refuses every connection with the reason, which the page shows in
//! its terminal ([`PageNet::take_notes`]).

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use wasixv2_abi::Errno;
use wasixv2_vnet::{
    Backend, BackendDatagram, BackendStream, Domain, InboundSink, Lookup, LookupDone, Publication,
    WaitQueue,
};

use crate::names::Names;

/// The most notes kept between takes: a guest retrying a refused connection must not grow them
/// without bound while the page reads them.
const MAX_NOTES: usize = 100;

/// Clones share the names and the notes.
#[derive(Clone, Default)]
pub struct PageNet(Arc<Inner>);

#[derive(Default)]
struct Inner {
    names: Mutex<Names>,
    notes: Mutex<Vec<String>>,
}

impl PageNet {
    /// The name behind an address this backend handed out, for the page's view of what a
    /// process connected to.
    pub fn host_for(&self, addr: IpAddr) -> Option<String> {
        lock(&self.0.names).host_for(addr)
    }

    /// Each connection refused since the last call, and why.
    pub fn take_notes(&self) -> Vec<String> {
        std::mem::take(&mut *lock(&self.0.notes))
    }

    fn note(&self, text: String) {
        let mut notes = lock(&self.0.notes);
        if notes.len() >= MAX_NOTES {
            notes.remove(0);
        }
        notes.push(text);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl crate::observe::Hosts for PageNet {
    fn host_for(&self, addr: IpAddr) -> Option<String> {
        self.host_for(addr)
    }
}

impl Backend for PageNet {
    fn connect(&self, peer: SocketAddr, _: WaitQueue) -> Result<Arc<dyn BackendStream>, Errno> {
        let host = self.host_for(peer.ip()).unwrap_or_else(|| peer.ip().to_string());
        self.note(format!(
            "{host}:{}: a socket cannot leave the page; HTTP goes out through the host call (WASIX_HTTP=host)",
            peer.port()
        ));
        Err(Errno::ECONNREFUSED)
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
        done(lock(&self.0.names).lookup(&lookup));
    }
}
