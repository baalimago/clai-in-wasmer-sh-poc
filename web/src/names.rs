//! Names to addresses, as a fake-IP resolver hands them out: a name gets an address of its own in
//! 198.18.0.0/15, and a connection to that address leads back to the name. This is the scheme the
//! kernel's `vnet-wisp/src/names.rs` uses, so the kernel reads a name from an address the way it
//! expects; here the browser resolves the name, so no server is asked.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr};

use wasixv2_vnet::{Answer, Found, Lookup, LookupError};

/// 198.18.0.0/15, RFC 2544's benchmarking range.
const FIRST: u32 = u32::from_be_bytes([198, 18, 0, 1]);
const LAST: u32 = u32::from_be_bytes([198, 19, 255, 254]);
const TTL: u32 = 300;
const NEGATIVE_TTL: u32 = 5;

#[derive(Default)]
pub struct Names {
    by_name: HashMap<String, Ipv4Addr>,
    by_addr: HashMap<Ipv4Addr, String>,
}

impl Names {
    pub fn lookup(&mut self, lookup: &Lookup) -> Result<Found, LookupError> {
        let answer = match lookup {
            Lookup::Name(name) => Answer::Addrs {
                canonical: name.clone(),
                addrs: vec![IpAddr::V4(self.address_of(name)?)],
            },
            Lookup::Addr(IpAddr::V4(addr)) if is_fake(*addr) => Answer::Name(
                self.by_addr
                    .get(addr)
                    .cloned()
                    .ok_or(LookupError::NotFound { ttl: NEGATIVE_TTL })?,
            ),
            Lookup::Addr(_) => return Err(LookupError::NotFound { ttl: NEGATIVE_TTL }),
            Lookup::Forward(_) => return Err(LookupError::Failed),
        };
        Ok(Found { answer, ttl: TTL })
    }

    /// The host to ask the browser for: the name behind a fake address, the address itself
    /// otherwise.
    pub fn host_for(&self, addr: IpAddr) -> Option<String> {
        match addr {
            IpAddr::V4(v4) if is_fake(v4) => self.by_addr.get(&v4).cloned(),
            other => Some(other.to_string()),
        }
    }

    fn address_of(&mut self, name: &str) -> Result<Ipv4Addr, LookupError> {
        let name = name.to_ascii_lowercase();
        if let Some(addr) = self.by_name.get(&name) {
            return Ok(*addr);
        }
        let next = FIRST + self.by_name.len() as u32;
        if next > LAST {
            return Err(LookupError::Failed);
        }
        let addr = Ipv4Addr::from(next);
        self.by_name.insert(name.clone(), addr);
        self.by_addr.insert(addr, name);
        Ok(addr)
    }
}

fn is_fake(addr: Ipv4Addr) -> bool {
    (FIRST..=LAST).contains(&u32::from(addr))
}