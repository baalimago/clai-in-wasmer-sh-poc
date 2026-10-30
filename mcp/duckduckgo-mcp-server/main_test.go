package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/baalimago/clai-in-wasmer-sh-poc/mcp/mcpserver"
)

func testConfig() config {
	cfg, _ := loadConfig(func(string) string { return "" }, &bytes.Buffer{})
	return cfg
}

// exchange sends requests to a server, one per line, and returns its responses by id.
func exchange(t *testing.T, s *mcpserver.Server, requests ...string) map[string]json.RawMessage {
	t.Helper()
	var out bytes.Buffer
	if err := s.Serve(context.Background(), strings.NewReader(strings.Join(requests, "\n")+"\n"), &out); err != nil {
		t.Fatalf("serve: %v", err)
	}
	got := map[string]json.RawMessage{}
	scanner := bufio.NewScanner(&out)
	for scanner.Scan() {
		var r struct {
			ID     json.RawMessage `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &r); err != nil {
			t.Fatalf("response %q: %v", scanner.Text(), err)
		}
		if r.Error != nil {
			got[string(r.ID)] = r.Error
		} else {
			got[string(r.ID)] = r.Result
		}
	}
	return got
}

func TestHandshakeAndToolList(t *testing.T) {
	got := exchange(t, newServer(testConfig()),
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"nope"}`,
		`{"jsonrpc":"2.0","id":4,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}`,
	)
	if len(got) != 4 {
		t.Fatalf("got %d responses, want 4 (the notification gets none): %v", len(got), got)
	}
	if !strings.Contains(string(got["1"]), `"protocolVersion":"2025-06-18"`) {
		t.Errorf("initialize: %s", got["1"])
	}
	if !strings.Contains(string(got["4"]), `"protocolVersion":"2025-06-18"`) {
		t.Errorf("an unknown version should get the newest: %s", got["4"])
	}
	var list struct {
		Tools []struct {
			Name        string         `json:"name"`
			InputSchema map[string]any `json:"inputSchema"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(got["2"], &list); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tl := range list.Tools {
		names = append(names, tl.Name)
		if tl.InputSchema["type"] != "object" {
			t.Errorf("%s: schema type %v", tl.Name, tl.InputSchema["type"])
		}
	}
	if strings.Join(names, ",") != "search,fetch_content,expand_link" {
		t.Errorf("tools %v", names)
	}
	if !strings.Contains(string(got["3"]), "-32601") {
		t.Errorf("unknown method: %s", got["3"])
	}
}

func TestToolCallErrors(t *testing.T) {
	got := exchange(t, newServer(testConfig()),
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"missing"}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"expand_link","arguments":{"token":"ref://abc"}}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"fetch_content","arguments":{"url":"x","max_length":"long"}}}`,
		`not json`,
	)
	if !strings.Contains(string(got["1"]), `"isError":true`) || !strings.Contains(string(got["1"]), "query") {
		t.Errorf("search without a query: %s", got["1"])
	}
	if !strings.Contains(string(got["2"]), "Unknown tool") {
		t.Errorf("unknown tool: %s", got["2"])
	}
	if !strings.Contains(string(got["3"]), "Unknown link reference 'ref://abc'") {
		t.Errorf("unknown ref: %s", got["3"])
	}
	if !strings.Contains(string(got["4"]), `"isError":true`) {
		t.Errorf("mistyped argument: %s", got["4"])
	}
	if !strings.Contains(string(got["null"]), "-32700") {
		t.Errorf("parse error: %s", got["null"])
	}
}

const resultsPage = `<html><body>
<div class="result results_links"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwasmer.io%2Fposts%3Fa%3D1&amp;rut=x">Wasmer <b>blog</b></a></h2>
<a class="result__snippet">Run <b>anything</b> anywhere</a></div>
<div class="result"><h2 class="result__title"><a href="https://duckduckgo.com/y.js?ad=1">Ad</a></h2></div>
<div class="result"><h2 class="result__title"><a href="https://example.com/2">Second</a></h2></div>
<div class="result"><h2 class="result__title"><a href="https://example.com/3">Third</a></h2></div>
</body></html>`

func TestParseResults(t *testing.T) {
	results, err := parseResults(resultsPage, 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []searchResult{
		{title: "Wasmerblog", link: "https://wasmer.io/posts?a=1", snippet: "Runanythinganywhere"},
		{title: "Second", link: "https://example.com/2"},
	}
	if fmt.Sprint(results) != fmt.Sprint(want) {
		t.Errorf("got %+v, want %+v", results, want)
	}
}

func TestParseLiteResults(t *testing.T) {
	page := `<table><tr><td><a class="result-link" href="https://a.example/">A</a></td></tr>
<tr><td class="result-snippet">about a</td></tr>
<tr><td><a class="result-link" href="https://b.example/">B</a></td></tr>
<tr><td class="result-snippet">about b</td></tr></table>`
	results, err := parseLiteResults(page, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0] != (searchResult{"A", "https://a.example/", "about a"}) {
		t.Errorf("got %+v", results)
	}
}

func TestFormat(t *testing.T) {
	s := &searcher{refURLThreshold: 30, links: newLinks(8)}
	out := s.format([]searchResult{{"T", "https://example.com/" + strings.Repeat("x", 40), "S"}})
	if !strings.HasPrefix(out, "Found 1 search results:\n\n1. T\n   URL: ref://") || !strings.HasSuffix(out, "   Summary: S\n") {
		t.Errorf("format: %q", out)
	}
	if !strings.HasPrefix(s.format(nil), "No results were found") {
		t.Errorf("empty: %q", s.format(nil))
	}
}

func TestSearchFallsBackToLiteWhenBlocked(t *testing.T) {
	var forms []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		forms = append(forms, r.URL.Path+"?"+r.PostForm.Encode())
		if r.URL.Path == "/html" {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		fmt.Fprint(w, `<a class="result-link" href="https://a.example/">A</a><td class="result-snippet">s</td>`)
	}))
	defer srv.Close()
	s := &searcher{
		client: srv.Client(), safeSearch: safeSearchModes["OFF"], limiter: newLimiter(5),
		links: newLinks(8), endpoints: [2]string{srv.URL + "/html", srv.URL + "/lite"},
	}
	results, err := s.search(context.Background(), "q", 5, "de-de")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].title != "A" {
		t.Errorf("results %+v", results)
	}
	if len(forms) != 2 || forms[0] != "/html?b=&kl=de-de&kp=-2&q=q" {
		t.Errorf("requests %v", forms)
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer failing.Close()
	s.endpoints = [2]string{failing.URL + "/html", failing.URL + "/lite"}
	if _, err := s.search(context.Background(), "q", 5, ""); err == nil || !strings.Contains(err.Error(), "HTTP 403") {
		t.Errorf("blocked twice: %v", err)
	}
}

const page = `<html><head><title>T</title><script>evil()</script></head><body>
<nav>Menu</nav><header>Head</header>
<article><h2>Title</h2><p>Some <b>bold</b> and <a href="https://x.example/a)b">a link</a>, long enough to count as main content.</p>
<ul><li>one</li><li>two</li></ul><pre>code
</pre></article><aside>Side</aside><footer>Foot</footer></body></html>`

// The expected texts are what duckduckgo-mcp-server 0.7.0 (BeautifulSoup) makes of page.
func TestHTMLToText(t *testing.T) {
	cases := map[string]string{
		"text": "T TitleSome bold and a link, long enough to count as main content. onetwocode Side",
		"main": "TitleSome bold and a link, long enough to count as main content. onetwocode",
		"markdown": "## Title\n\nSome **bold** and [a link](https://x.example/a%29b), long enough to count as main content.\n\n" +
			"- one\n- two\n\n```\ncode\n```",
	}
	for mode, want := range cases {
		got, err := htmlToText(page, mode)
		if err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Errorf("%s:\ngot  %q\nwant %q", mode, got, want)
		}
	}
	if _, err := htmlToText(page, "pdf"); err == nil {
		t.Error("an unknown mode should fail")
	}
}

func TestLinks(t *testing.T) {
	l := newLinks(2)
	a := l.shorten("https://a.example/")
	if a != l.shorten("https://a.example/") || len(a) != len(refScheme)+8 {
		t.Errorf("token %q is not stable", a)
	}
	if u, ok := l.resolve(strings.ToUpper(a[len(refScheme):])); !ok || u != "https://a.example/" {
		t.Errorf("resolve bare id: %q %v", u, ok)
	}
	l.shorten("https://b.example/")
	l.shorten("https://c.example/")
	if _, ok := l.resolve(a); ok {
		t.Error("the least recently used token should be evicted")
	}
}

func TestGuard(t *testing.T) {
	lookup := func(_ context.Context, host string) ([]netip.Addr, error) {
		switch host {
		case "public.example":
			return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
		case "cgnat.example":
			return []netip.Addr{netip.MustParseAddr("100.64.1.1")}, nil
		case "mapped.example":
			return []netip.Addr{netip.MustParseAddr("::ffff:127.0.0.1")}, nil
		}
		return nil, fmt.Errorf("no such host")
	}
	f := &fetcher{lookup: lookup}
	for raw, want := range map[string]string{
		"https://public.example/":  "",
		"ftp://public.example/":    "unsupported URL scheme",
		"http://localhost:8080/":   "loopback host",
		"http://cgnat.example/":    "non-public address 100.64.1.1",
		"http://mapped.example/":   "non-public address 127.0.0.1",
		"http://unknown.example/":  "could not resolve",
		"http:///nohost":           "no host",
		"http://public.example:x/": "invalid URL",
	} {
		err := f.guard(context.Background(), raw)
		if (want == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), want)) {
			t.Errorf("%s: got %v, want %q", raw, err, want)
		}
	}
}

func TestFetch(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/moved":
			http.Redirect(w, r, "/page", http.StatusFound)
		case "/page":
			hits++
			fmt.Fprint(w, page)
		case "/loop":
			http.Redirect(w, r, "/loop", http.StatusFound)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	registry := newLinks(8)
	f := &fetcher{
		client: client, allowPrivate: true, limiter: newLimiter(100), cache: newCache(time.Minute, 4),
		defaultParseMode: "text", links: registry, lookup: resolveHost,
	}
	ptr := func(n int) *int { return &n }

	got := f.fetch(context.Background(), fetchArgs{URL: registry.shorten(srv.URL + "/moved"), MaxLength: ptr(5)})
	if got != "T Tit\n\n---\n[Content info: Showing characters 0-5 of 82 total. Use start_index=5 to see more | cache=miss]" {
		t.Errorf("first page: %q", got)
	}
	got = f.fetch(context.Background(), fetchArgs{URL: srv.URL + "/moved", StartIndex: ptr(80)})
	if got != "de\n\n---\n[Content info: Showing characters 80-82 of 82 total | cache=hit]" {
		t.Errorf("second page: %q", got)
	}
	if hits != 1 {
		t.Errorf("downloaded %d times, want once", hits)
	}
	for args, want := range map[*fetchArgs]string{
		{URL: srv.URL + "/missing"}:          "Error: Could not access the webpage (client error '404 Not Found'",
		{URL: srv.URL + "/loop"}:             "too many redirects (>5)",
		{URL: "ref://00000000"}:              "Unknown link reference",
		{URL: srv.URL, Backend: new(string)}: "Unknown fetch backend ''",
	} {
		if got := f.fetch(context.Background(), *args); !strings.Contains(got, want) {
			t.Errorf("%+v: got %q, want %q", *args, got, want)
		}
	}
	f.allowPrivate = false
	if got := f.fetch(context.Background(), fetchArgs{URL: srv.URL + "/page"}); !strings.Contains(got, "Refusing to fetch") {
		t.Errorf("private: %q", got)
	}
}

func TestRunRejectsOtherTransports(t *testing.T) {
	var stderr bytes.Buffer
	err := run([]string{"--transport", "sse"}, func(string) string { return "" }, strings.NewReader(""), &bytes.Buffer{}, &stderr)
	if err == nil || !strings.Contains(err.Error(), "only stdio") {
		t.Errorf("got %v", err)
	}
	var stdout bytes.Buffer
	env := map[string]string{"DDG_SAFE_SEARCH": "bogus", "DDG_SEARCH_RPM": "0"}
	if err := run(nil, func(k string) string { return env[k] }, strings.NewReader(""), &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Invalid DDG_SAFE_SEARCH value 'BOGUS'", "DDG_SEARCH_RPM must be >= 1", "SafeSearch: MODERATE"} {
		if !strings.Contains(stderr.String(), want) {
			t.Errorf("stderr lacks %q:\n%s", want, stderr.String())
		}
	}
}
