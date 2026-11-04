//! The page's `fetch`, as one exchange: a request out, a response head and its body in, chunk
//! by chunk while the body streams. The backend in [`crate::fetch`] turns those chunks into the
//! bytes a guest reads on its socket.

use js_sys::{Array, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    AbortController, ReadableStreamDefaultReader, Request, RequestCache, RequestCredentials,
    RequestInit, RequestMode, RequestRedirect, Response,
};

/// A request the browser is carrying: its status and headers at once, its body as it arrives.
pub struct Exchange {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// `None` for a response without a body (204, 304, HEAD).
    pub reader: Option<ReadableStreamDefaultReader>,
    /// Aborting it ends the request, for a guest that closes its socket first.
    pub controller: AbortController,
}

/// Starts the request. A rejected promise is the browser refusing it: no such host, or a CORS
/// refusal, which is an opaque `TypeError`. A 3xx is the response, as a guest's HTTP client
/// expects: `redirect: "manual"`. Across origins the browser hides that answer, and its status 0
/// is an error rather than a fabricated response ([one request per
/// handle](../../../research/http-host-call/PROMPT.md)).
pub async fn open(
    url: &str,
    method: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<Exchange, String> {
    let init = RequestInit::new();
    init.set_method(method);
    init.set_mode(RequestMode::Cors);
    init.set_credentials(RequestCredentials::Omit);
    init.set_cache(RequestCache::NoStore);
    init.set_redirect(RequestRedirect::Manual);
    let head = js_sys::Object::new();
    for (name, value) in headers {
        Reflect::set(&head, &JsValue::from_str(name), &JsValue::from_str(value))
            .map_err(describe)?;
    }
    init.set_headers(&head);
    if !body.is_empty() {
        init.set_body(&Uint8Array::from(body).into());
    }
    let controller = AbortController::new().map_err(describe)?;
    init.set_signal(Some(&controller.signal()));
    let request = Request::new_with_str_and_init(url, &init).map_err(describe)?;
    let response = JsFuture::from(fetch(&request)?).await.map_err(describe)?;
    let response = response
        .dyn_into::<Response>()
        .map_err(|_| format!("fetch {url} gave no response"))?;
    if response.status() == 0 {
        return Err(format!(
            "fetch {url}: a redirect across origins, which the browser does not show the page"
        ));
    }
    let headers = pairs(
        &response
            .headers()
            .dyn_into::<js_sys::Object>()
            .map_err(|head| describe(head.into()))?,
    );
    let reader = match response.body() {
        Some(stream) => Some(
            stream
                .get_reader()
                .dyn_into::<ReadableStreamDefaultReader>()
                .map_err(|reader| describe(reader.into()))?,
        ),
        None => None,
    };
    Ok(Exchange {
        status: response.status(),
        headers,
        reader,
        controller,
    })
}

/// The next bytes of a response body; `None` at its end.
pub async fn next(reader: &ReadableStreamDefaultReader) -> Result<Option<Vec<u8>>, String> {
    let read = reader.read();
    let result = JsFuture::from(read).await.map_err(describe)?;
    if field(&result, "done")?.as_bool().unwrap_or(true) {
        return Ok(None);
    }
    let value = field(&result, "value")?;
    let chunk = value
        .dyn_into::<Uint8Array>()
        .map_err(|_| "a body chunk was not bytes".to_string())?;
    Ok(Some(chunk.to_vec()))
}

/// Ends the request, for a socket the guest closed while its response still streamed.
pub fn abort(controller: &JsValue) {
    if let Some(controller) = controller.dyn_ref::<AbortController>() {
        controller.abort();
    }
}

fn fetch(request: &Request) -> Result<Promise, String> {
    let global = js_sys::global();
    let fetch = Reflect::get(&global, &JsValue::from_str("fetch"))
        .map_err(describe)?
        .dyn_into::<Function>()
        .map_err(|_| "the page has no fetch".to_string())?;
    fetch
        .call1(&global, request.as_ref())
        .map_err(describe)?
        .dyn_into::<Promise>()
        .map_err(describe)
}

/// The entries of a `Headers` object, both of its two shapes (iterable, or a plain object).
fn pairs(head: &js_sys::Object) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Ok(Some(entries)) = js_sys::try_iter(head.as_ref()) {
        for entry in entries.flatten() {
            let pair = Array::from(&entry);
            if let (Some(name), Some(value)) = (pair.get(0).as_string(), pair.get(1).as_string()) {
                out.push((name, value));
            }
        }
    }
    out
}

fn field(object: &JsValue, name: &str) -> Result<JsValue, String> {
    Reflect::get(object, &JsValue::from_str(name)).map_err(describe)
}

/// What the browser said, for the page's log and for the guest's error.
pub fn describe(error: JsValue) -> String {
    error
        .dyn_ref::<js_sys::Error>()
        .map(|error| String::from(error.message()))
        .or_else(|| error.as_string())
        .unwrap_or_else(|| format!("{error:?}"))
}