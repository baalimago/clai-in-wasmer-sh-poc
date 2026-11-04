//! The HTTP/1.1 a fetch backend carries on the guest's side of a connection: the client's
//! request as it arrives in pieces, and the response head the backend synthesizes from a
//! `fetch` Response. A crate of its own, without wasm dependencies, so it tests on the host.

/// What a push of request bytes yields.
pub enum Step {
    /// More bytes are needed before the request is complete.
    Incomplete,
    /// The request is complete: the call can start.
    Ready(Call),
    /// These bytes are not an HTTP request this backend can carry.
    Bad(Bad),
}

/// Why the bytes are not carried, in words the page can show.
pub struct Bad(pub &'static str);

/// One complete request, as the guest wrote it.
pub struct Call {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Call {
    /// The `Host` header, which names the authority the request is for.
    pub fn host(&self) -> Option<&str> {
        self.headers.iter().find(|(name, _)| name == "host").map(|(_, value)| value.as_str())
    }
}

/// The largest request head accepted; a client that sends more is not speaking HTTP at us.
const MAX_HEAD: usize = 32 * 1024;

/// A client's first request, accumulated from the writes the guest makes.
#[derive(Default)]
pub struct RequestParser {
    buf: Vec<u8>,
}

impl RequestParser {
    pub fn push(&mut self, data: &[u8]) -> Step {
        self.buf.extend_from_slice(data);
        if let Some(bad) = refused(&self.buf) {
            return Step::Bad(bad);
        }
        let Some(body_at) = head_end(&self.buf) else {
            return Step::Incomplete;
        };
        let head = match parse_head(&self.buf[..body_at]) {
            Ok(head) => head,
            Err(bad) => return Step::Bad(bad),
        };
        let have = self.buf.len() - body_at;
        if have < head.content_length {
            return Step::Incomplete;
        }
        if have > head.content_length {
            return Step::Bad(Bad("a second request came on one connection"));
        }
        Step::Ready(Call {
            method: head.method,
            target: head.target,
            headers: head.headers,
            body: self.buf[body_at..].to_vec(),
        })
    }
}

/// The bytes that are not HTTP at all: a TLS ClientHello, or a head too long to be one.
fn refused(buf: &[u8]) -> Option<Bad> {
    if buf.first() == Some(&0x16) {
        return Some(Bad("the connection carries TLS: a socket cannot, and WASIX_HTTP=host carries it"));
    }
    if buf.len() > MAX_HEAD {
        return Some(Bad("the request head is over 32 KB"));
    }
    None
}

/// Where the request body starts, once the blank line that ends the head has arrived.
fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|at| at + 4)
}

struct Head {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    content_length: usize,
}

fn parse_head(bytes: &[u8]) -> Result<Head, Bad> {
    let text = std::str::from_utf8(bytes).map_err(|_| Bad("the request head is not ASCII"))?;
    let mut lines = text.split("\r\n");
    let request = lines.next().ok_or(Bad("the request line is missing"))?;
    let mut parts = request.split(' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) => (m, t, v),
        _ => return Err(Bad("the request line is not METHOD TARGET HTTP/1.x")),
    };
    if method.is_empty() || target.is_empty() {
        return Err(Bad("the request line is not METHOD TARGET HTTP/1.x"));
    }
    if !version.starts_with("HTTP/1.") {
        return Err(Bad("the request is not HTTP/1.x"));
    }
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut content_length: Option<usize> = None;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let (name, value) = line.split_once(':').ok_or(Bad("a header line has no colon"))?;
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            return Err(Bad("a header line has no name"));
        }
        let value = value.trim().to_string();
        match name.as_str() {
            "transfer-encoding" => return Err(Bad("chunked request bodies are not carried")),
            "content-length" => {
                let n = value.parse().map_err(|_| Bad("Content-Length is not a number"))?;
                if content_length.replace(n).is_some() {
                    return Err(Bad("two Content-Length headers"));
                }
            }
            _ => headers.push((name, value)),
        }
    }
    Ok(Head {
        method: method.to_string(),
        target: target.to_string(),
        headers,
        content_length: content_length.unwrap_or(0),
    })
}

/// The response head for a `fetch` response: its status and headers, with framing replaced by
/// the end of the connection, which is what the guest reads to as the body ends.
pub fn response_head(status: u16, headers: &[(String, String)]) -> Vec<u8> {
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status)).into_bytes();
    for (name, value) in headers {
        if hop_by_hop(name) || !header_safe(name) || !header_safe(value) {
            continue;
        }
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out
}

/// Headers that describe the connection or the body's framing, which this backend owns.
fn hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-connection"
            | "transfer-encoding"
            | "content-length"
            | "content-encoding"
            | "te"
            | "trailer"
            | "upgrade"
    )
}

/// An authority's host and port, with 80 for one that names no port. An IPv6 literal keeps its
/// brackets, so it can go back into a URL unchanged.
pub fn authority(authority: &str) -> (&str, u16) {
    match authority.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') || host.ends_with(']') => match port.parse() {
            Ok(port) => (host, port),
            Err(_) => (authority, 80),
        },
        _ => (authority, 80),
    }
}

/// A header a synthesized head can carry: no control characters, so nothing can be injected.
fn header_safe(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| (0x20..0x7f).contains(&b) || b == b'\t')
}

fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        422 => "Unprocessable Entity",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        _ => "OK",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(step: Step) -> Call {
        match step {
            Step::Ready(call) => call,
            Step::Incomplete => panic!("incomplete"),
            Step::Bad(Bad(why)) => panic!("bad: {why}"),
        }
    }

    fn bad(step: Step) -> &'static str {
        match step {
            Step::Bad(Bad(why)) => why,
            _ => panic!("not bad"),
        }
    }

    #[test]
    fn a_get_arriving_in_pieces_is_ready_at_its_head() {
        let mut parser = RequestParser::default();
        assert!(matches!(parser.push(b"GET /v1/models HTT"), Step::Incomplete));
        let call = ready(parser.push(b"P/1.1\r\nHost: example.com\r\nAccept: */*\r\n\r\n"));
        assert_eq!(call.method, "GET");
        assert_eq!(call.target, "/v1/models");
        assert_eq!(call.host(), Some("example.com"));
        assert!(call.body.is_empty());
    }

    #[test]
    fn a_post_waits_for_its_content_length() {
        let mut parser = RequestParser::default();
        assert!(matches!(
            parser.push(b"POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\n\r\nhe"),
            Step::Incomplete
        ));
        let call = ready(parser.push(b"llo"));
        assert_eq!(call.body, b"hello");
        assert_eq!(call.headers.iter().filter(|(n, _)| n == "content-length").count(), 0);
    }

    #[test]
    fn what_this_backend_cannot_carry_says_why() {
        let mut chunked = RequestParser::default();
        assert_eq!(
            bad(chunked.push(b"POST /x HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n")),
            "chunked request bodies are not carried"
        );
        let mut tls = RequestParser::default();
        assert_eq!(
            bad(tls.push(&[0x16, 0x03, 0x01, 0x00, 0x2b])),
            "the connection carries TLS: a socket cannot, and WASIX_HTTP=host carries it"
        );
        let mut pipelined = RequestParser::default();
        assert_eq!(
            bad(pipelined.push(b"GET / HTTP/1.1\r\nHost: h\r\n\r\nGET / HTTP/1.1\r\nHost: h\r\n\r\n")),
            "a second request came on one connection"
        );
        let mut long = RequestParser::default();
        assert_eq!(bad(long.push(&vec![b'A'; MAX_HEAD + 1])), "the request head is over 32 KB");
    }

    #[test]
    fn the_response_head_keeps_what_the_guest_reads_and_owns_the_framing() {
        let head = response_head(
            200,
            &[
                ("content-type".into(), "text/event-stream".into()),
                ("content-length".into(), "12".into()),
                ("content-encoding".into(), "gzip".into()),
                ("x-request-id".into(), "abc".into()),
                ("bad".into(), "two\r\nwords".into()),
            ],
        );
        let text = String::from_utf8(head).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(text.contains("content-type: text/event-stream\r\n"));
        assert!(text.contains("x-request-id: abc\r\n"));
        assert!(!text.contains("content-length"));
        assert!(!text.contains("content-encoding"));
        assert!(!text.contains("two"));
        assert!(text.ends_with("Connection: close\r\n\r\n"));
    }

    #[test]
    fn an_unknown_status_still_reads_as_a_status_line() {
        assert!(String::from_utf8(response_head(418, &[])).unwrap().starts_with("HTTP/1.1 418 OK\r\n"));
    }

    #[test]
    fn an_authority_names_its_port_when_it_has_one() {
        assert_eq!(authority("api.openai.com"), ("api.openai.com", 80));
        assert_eq!(authority("api.openai.com:443"), ("api.openai.com", 443));
        assert_eq!(authority("fetch.test:5001"), ("fetch.test", 5001));
        assert_eq!(authority("[::1]:5001"), ("[::1]", 5001));
        assert_eq!(authority("[::1]"), ("[::1]", 80));
        assert_eq!(authority("host:notaport"), ("host:notaport", 80));
    }
}