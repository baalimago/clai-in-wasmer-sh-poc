package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxRedirects = 5

// Ranges that are not public even where netip calls them global unicast, after Python's
// ipaddress.is_global.
var nonPublic = func() []netip.Prefix {
	var prefixes []netip.Prefix
	for _, p := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15",
		"198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "255.255.255.255/32",
		"64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16",
	} {
		prefixes = append(prefixes, netip.MustParsePrefix(p))
	}
	return prefixes
}()

// errBlockedURL is a fetch target that is not a public http(s) destination.
type errBlockedURL struct{ reason string }

func (e errBlockedURL) Error() string { return e.reason }

type fetcher struct {
	client           *http.Client
	allowPrivate     bool
	limiter          *limiter
	hosts            *hostLimiters // nil: no per-host limit
	cache            *cache
	defaultParseMode string
	links            *links
	lookup           func(ctx context.Context, host string) ([]netip.Addr, error)
}

func publicAddr(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return false
	}
	for _, p := range nonPublic {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// guard refuses a URL that is not http(s) or whose host resolves to a non-public address.
func (f *fetcher) guard(ctx context.Context, raw string) error {
	if f.allowPrivate {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errBlockedURL{fmt.Sprintf("invalid URL: %v", err)}
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return errBlockedURL{fmt.Sprintf("unsupported URL scheme '%s://' (only http and https are allowed)", u.Scheme)}
	}
	host := u.Hostname()
	if host == "" {
		return errBlockedURL{"URL has no host"}
	}
	lowered := strings.ToLower(host)
	if lowered == "localhost" || strings.HasSuffix(lowered, ".localhost") {
		return errBlockedURL{fmt.Sprintf("refusing to fetch loopback host '%s'", host)}
	}
	if port := u.Port(); port != "" {
		if n, err := strconv.Atoi(port); err != nil || n < 0 || n > 65535 {
			return errBlockedURL{fmt.Sprintf("invalid port in URL '%s'", raw)}
		}
	}
	addrs, err := f.lookup(ctx, host)
	if err != nil {
		return errBlockedURL{fmt.Sprintf("could not resolve host '%s': %v", host, err)}
	}
	for _, ip := range addrs {
		if !publicAddr(ip) {
			return errBlockedURL{fmt.Sprintf("refusing to fetch '%s' — it resolves to non-public address %s", host, ip.Unmap())}
		}
	}
	return nil
}

func resolveHost(ctx context.Context, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{ip}, nil
	}
	return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
}

// get downloads a page, following redirects itself so that each hop is guarded.
func (f *fetcher) get(ctx context.Context, target string) (string, error) {
	current := target
	for range maxRedirects + 1 {
		if err := f.guard(ctx, current); err != nil {
			return "", err
		}
		resp, err := f.request(ctx, current)
		if err != nil {
			return "", err
		}
		if resp.StatusCode == http.StatusTooManyRequests {
			resp.Body.Close()
			if err := sleepRetryAfter(ctx, resp.Header); err != nil {
				return "", err
			}
			if resp, err = f.request(ctx, current); err != nil {
				return "", err
			}
		}
		location := resp.Header.Get("Location")
		switch resp.StatusCode {
		case 301, 302, 303, 307, 308:
			resp.Body.Close()
			if location != "" {
				base, err := url.Parse(current)
				if err != nil {
					return "", fmt.Errorf("redirect from %s: %w", current, err)
				}
				next, err := base.Parse(location)
				if err != nil {
					return "", fmt.Errorf("redirect to %s: %w", location, err)
				}
				current = next.String()
				continue
			}
		}
		defer resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return "", fmt.Errorf("client error '%d %s' for url '%s'", resp.StatusCode, http.StatusText(resp.StatusCode), current)
		}
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return "", fmt.Errorf("read %s: %w", current, err)
		}
		return string(body), nil
	}
	return "", fmt.Errorf("too many redirects (>%d)", maxRedirects)
}

func (f *fetcher) request(ctx context.Context, target string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, fmt.Errorf("build request for %s: %w", target, err)
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
	return f.client.Do(req)
}

type fetchArgs struct {
	URL        string  `json:"url"`
	StartIndex *int    `json:"start_index"`
	MaxLength  *int    `json:"max_length"`
	Backend    *string `json:"backend"`
	ParseMode  *string `json:"parse_mode"`
}

// fetch is the fetch_content tool. Its failures are its text, as the Python server's are.
func (f *fetcher) fetch(ctx context.Context, args fetchArgs) string {
	target := args.URL
	if isRefToken(target) {
		resolved, ok := f.links.resolve(target)
		if !ok {
			return unknownRefError(target)
		}
		target = resolved
	}
	start, length := 0, 8000
	if args.StartIndex != nil {
		start = max(0, *args.StartIndex)
	}
	if args.MaxLength != nil {
		length = max(0, *args.MaxLength)
	}
	backend := "httpx"
	if args.Backend != nil {
		backend = *args.Backend
	}
	if !contains([]string{"httpx", "curl", "auto"}, backend) {
		return fmt.Sprintf("Error: Unknown fetch backend '%s'. Supported: ('httpx', 'curl', 'auto')", backend)
	}
	mode := f.defaultParseMode
	if args.ParseMode != nil {
		mode = strings.ToLower(*args.ParseMode)
	}
	if !contains(parseModes, mode) {
		return fmt.Sprintf("Error: Unknown parse_mode '%s'. Supported: ('text', 'main', 'markdown')", mode)
	}

	key := cacheKey(target, mode)
	page, hit := f.cache.get(key)
	if !hit {
		if f.hosts != nil {
			if err := f.hosts.acquire(ctx, target); err != nil {
				return fmt.Sprintf("Error: %v", err)
			}
		}
		if err := f.limiter.acquire(ctx); err != nil {
			return fmt.Sprintf("Error: %v", err)
		}
		raw, err := f.get(ctx, target)
		if err != nil {
			var blocked errBlockedURL
			switch {
			case errors.As(err, &blocked):
				return fmt.Sprintf("Error: Refusing to fetch %s (%v). This server blocks requests to "+
					"private/internal addresses to prevent SSRF. If this is a trusted local "+
					"deployment, set DDG_ALLOW_PRIVATE_URLS=1 (or pass --allow-private-urls).", target, err)
			case errors.Is(err, context.DeadlineExceeded) || isTimeout(err):
				return "Error: The request timed out while trying to fetch the webpage."
			default:
				return fmt.Sprintf("Error: Could not access the webpage (%v)", err)
			}
		}
		if page, err = htmlToText(raw, mode); err != nil {
			return fmt.Sprintf("Error: An unexpected error occurred while fetching the webpage (%v)", err)
		}
		f.cache.set(key, page)
	}

	runes := []rune(page)
	total := len(runes)
	from := min(start, total)
	to := min(start+length, total)
	shown := string(runes[from:to])
	meta := fmt.Sprintf("\n\n---\n[Content info: Showing characters %d-%d of %d total", start, start+(to-from), total)
	if start+length < total {
		meta += fmt.Sprintf(". Use start_index=%d to see more", start+length)
	}
	if f.cache.enabled() {
		meta += " | cache=" + map[bool]string{true: "hit", false: "miss"}[hit]
	}
	if mode != "text" {
		meta += " | parse=" + mode
	}
	return shown + meta + "]"
}

func isTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func cacheKey(raw, mode string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw + "\x00" + mode
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme == "" {
		scheme = "http"
	}
	host := strings.ToLower(u.Hostname())
	if port := u.Port(); port != "" && !(scheme == "http" && port == "80") && !(scheme == "https" && port == "443") {
		host += ":" + port
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	normal := url.URL{Scheme: scheme, Host: host, Opaque: "", RawPath: path, Path: u.Path, RawQuery: u.RawQuery}
	if normal.Path == "" {
		normal.Path = "/"
	}
	return normal.String() + "\x00" + mode
}

// sleepRetryAfter waits as long as a 429's Retry-After asks, up to 30 seconds, or 2 seconds
// when it does not say.
func sleepRetryAfter(ctx context.Context, header http.Header) error {
	wait := 2 * time.Second
	if raw := strings.TrimSpace(header.Get("Retry-After")); raw != "" {
		if secs, err := strconv.ParseFloat(raw, 64); err == nil {
			wait = time.Duration(max(0, secs) * float64(time.Second))
		}
	}
	wait = min(wait, 30*time.Second)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(wait):
		return nil
	}
}
