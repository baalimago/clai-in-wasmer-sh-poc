//! What the machine's processes do, for the page's "under the hood" view: the kernel's trace
//! layer reports each event ([`wasixv2::Event`]), and [`Recorder`] keeps them until the page takes
//! them as JSON. Bytes moved through a descriptor add up between takes, so a process that writes
//! a file in small pieces is one entry, not thousands. A connection to an address the machine
//! handed out for a name carries that name.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::net::IpAddr;
use std::sync::Mutex;

use wasixv2::{Direction, End, Event, Observer};

/// The most events kept between takes; later ones are counted and dropped, oldest kept.
const MAX_EVENTS: usize = 20_000;

/// Names the host behind an address the guest connects to.
pub trait Hosts: Send + Sync {
    fn host_for(&self, addr: IpAddr) -> Option<String>;
}

impl Hosts for wasixv2_vnet_wisp::WispBackend {
    fn host_for(&self, addr: IpAddr) -> Option<String> {
        wasixv2_vnet_wisp::WispBackend::host_for(self, addr)
    }
}

pub struct Recorder<H> {
    hosts: H,
    clock: fn() -> f64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    events: Vec<(f64, Event, Option<String>)>,
    moved: HashMap<(i32, i32, bool), u64>,
    dropped: u64,
}

impl State {
    fn push(&mut self, at: f64, event: Event, host: Option<String>) {
        if self.events.len() >= MAX_EVENTS {
            self.dropped += 1;
            return;
        }
        self.events.push((at, event, host));
    }

    // The bytes moved so far, as one transfer per descriptor and direction, so that what
    // happens to a descriptor next comes after them.
    fn settle(&mut self, at: f64) {
        let mut moved: Vec<_> = self.moved.drain().collect();
        moved.sort();
        for ((pid, fd, out), bytes) in moved {
            let direction = if out { Direction::Out } else { Direction::In };
            self.push(at, Event::Transfer { pid, fd, direction, bytes }, None);
        }
    }
}

impl<H: Hosts> Recorder<H> {
    pub fn new(hosts: H, clock: fn() -> f64) -> Self {
        Self {
            hosts,
            clock,
            state: Mutex::default(),
        }
    }

    /// The events since the last call, as a JSON array, oldest first, with the bytes a
    /// descriptor moved between two other events as one `io` entry, and a `dropped` entry if
    /// the buffer filled.
    pub fn take(&self) -> String {
        let now = (self.clock)();
        let state = {
            let mut state = self.state.lock().unwrap();
            state.settle(now);
            std::mem::take(&mut *state)
        };
        let mut out = String::from("[");
        let mut first = true;
        let mut push = |out: &mut String, entry: String| {
            if !std::mem::take(&mut first) {
                out.push(',');
            }
            out.push_str(&entry);
        };
        for (at, event, host) in &state.events {
            push(&mut out, entry(*at, event, host.as_deref()));
        }
        if state.dropped > 0 {
            push(&mut out, format!(r#"{{"t":{now},"type":"dropped","count":{}}}"#, state.dropped));
        }
        out.push(']');
        out
    }
}

impl<H: Hosts> Observer for Recorder<H> {
    fn observe(&self, event: Event) {
        if let Event::Transfer {
            pid,
            fd,
            direction,
            bytes,
        } = event
        {
            let key = (pid, fd, direction == Direction::Out);
            *self.state.lock().unwrap().moved.entry(key).or_default() += bytes;
            return;
        }
        let host = match &event {
            Event::Connect { addr, .. } => self
                .hosts
                .host_for(addr.ip())
                .filter(|host| *host != addr.ip().to_string()),
            _ => None,
        };
        let at = (self.clock)();
        let mut state = self.state.lock().unwrap();
        state.settle(at);
        state.push(at, event, host);
    }
}

fn entry(at: f64, event: &Event, host: Option<&str>) -> String {
    let mut out = format!(r#"{{"t":{at},"#);
    match event {
        Event::Exec {
            pid,
            ppid,
            path,
            argv,
        } => {
            let argv: Vec<_> = argv.iter().map(|a| quote(a)).collect();
            let _ = write!(
                out,
                r#""type":"exec","pid":{pid},"ppid":{ppid},"path":{},"argv":[{}]"#,
                quote(path),
                argv.join(",")
            );
        }
        Event::Exit { pid, code } => {
            let _ = write!(out, r#""type":"exit","pid":{pid},"code":{code}"#);
        }
        Event::Reaped { pid, child, end } => {
            let (how, n) = match end {
                End::Exited(code) => ("exited", code),
                End::Killed(signal) => ("killed", signal),
            };
            let _ = write!(
                out,
                r#""type":"reaped","pid":{pid},"child":{child},"end":"{how}","n":{n}"#
            );
        }
        Event::Open {
            pid,
            fd,
            path,
            write,
        } => {
            let _ = write!(
                out,
                r#""type":"open","pid":{pid},"fd":{fd},"path":{},"write":{write}"#,
                quote(path)
            );
        }
        Event::Connect { pid, fd, addr } => {
            let host = host.map_or_else(|| addr.ip().to_string(), str::to_owned);
            let _ = write!(
                out,
                r#""type":"connect","pid":{pid},"fd":{fd},"host":{},"port":{}"#,
                quote(&host),
                addr.port()
            );
        }
        Event::Close { pid, fd } => {
            let _ = write!(out, r#""type":"close","pid":{pid},"fd":{fd}"#);
        }
        Event::Unlink { pid, path } => {
            let _ = write!(out, r#""type":"unlink","pid":{pid},"path":{}"#, quote(path));
        }
        Event::Mkdir { pid, path } => {
            let _ = write!(out, r#""type":"mkdir","pid":{pid},"path":{}"#, quote(path));
        }
        Event::Rename { pid, from, to } => {
            let _ = write!(
                out,
                r#""type":"rename","pid":{pid},"from":{},"to":{}"#,
                quote(from),
                quote(to)
            );
        }
        Event::Dup { pid, from, to } => {
            let _ = write!(out, r#""type":"dup","pid":{pid},"from":{from},"to":{to}"#);
        }
        Event::Transfer {
            pid,
            fd,
            direction,
            bytes,
        } => {
            let dir = match direction {
                Direction::In => "in",
                Direction::Out => "out",
            };
            let _ = write!(
                out,
                r#""type":"io","pid":{pid},"fd":{fd},"dir":"{dir}","bytes":{bytes}"#
            );
        }
    }
    out.push('}');
    out
}

/// `s` as a JSON string.
fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Names;

    impl Hosts for Names {
        fn host_for(&self, addr: IpAddr) -> Option<String> {
            Some(match addr.to_string().as_str() {
                "198.18.0.1" => "api.openai.com".into(),
                other => other.into(),
            })
        }
    }

    fn recorder() -> Recorder<Names> {
        Recorder::new(Names, || 5.0)
    }

    #[test]
    fn events_come_out_as_json_in_order() {
        let r = recorder();
        r.observe(Event::Exec {
            pid: 4,
            ppid: 1,
            path: "/bin/bash".into(),
            argv: vec!["bash".into(), "-c".into(), "echo \"hi\"\n".into()],
        });
        r.observe(Event::Exit { pid: 4, code: 0 });

        assert_eq!(
            r.take(),
            r#"[{"t":5,"type":"exec","pid":4,"ppid":1,"path":"/bin/bash","argv":["bash","-c","echo \"hi\"\n"]},{"t":5,"type":"exit","pid":4,"code":0}]"#
        );
        assert_eq!(r.take(), "[]");
    }

    #[test]
    fn connections_name_their_host() {
        let r = recorder();
        r.observe(Event::Connect {
            pid: 4,
            fd: 3,
            addr: "198.18.0.1:443".parse().unwrap(),
        });
        r.observe(Event::Connect {
            pid: 4,
            fd: 5,
            addr: "10.0.2.2:80".parse().unwrap(),
        });

        assert_eq!(
            r.take(),
            r#"[{"t":5,"type":"connect","pid":4,"fd":3,"host":"api.openai.com","port":443},{"t":5,"type":"connect","pid":4,"fd":5,"host":"10.0.2.2","port":80}]"#
        );
    }

    #[test]
    fn bytes_add_up_per_descriptor_and_direction() {
        let r = recorder();
        for bytes in [10, 20] {
            r.observe(Event::Transfer {
                pid: 4,
                fd: 3,
                direction: Direction::Out,
                bytes,
            });
        }
        r.observe(Event::Transfer {
            pid: 4,
            fd: 3,
            direction: Direction::In,
            bytes: 7,
        });

        assert_eq!(
            r.take(),
            r#"[{"t":5,"type":"io","pid":4,"fd":3,"dir":"in","bytes":7},{"t":5,"type":"io","pid":4,"fd":3,"dir":"out","bytes":30}]"#
        );
    }

    #[test]
    fn bytes_come_before_the_event_that_ends_their_descriptor() {
        let r = recorder();
        r.observe(Event::Dup { pid: 4, from: 3, to: 1 });
        for bytes in [2, 3] {
            r.observe(Event::Transfer {
                pid: 4,
                fd: 1,
                direction: Direction::Out,
                bytes,
            });
        }
        r.observe(Event::Close { pid: 4, fd: 1 });

        assert_eq!(
            r.take(),
            r#"[{"t":5,"type":"dup","pid":4,"from":3,"to":1},{"t":5,"type":"io","pid":4,"fd":1,"dir":"out","bytes":5},{"t":5,"type":"close","pid":4,"fd":1}]"#
        );
    }

    #[test]
    fn a_full_buffer_counts_what_it_dropped() {
        let r = recorder();
        for _ in 0..MAX_EVENTS + 2 {
            r.observe(Event::Close { pid: 1, fd: 1 });
        }

        assert!(r.take().ends_with(r#"{"t":5,"type":"dropped","count":2}]"#));
    }
}
