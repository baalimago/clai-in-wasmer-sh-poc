package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/net/html"
)

const (
	searchURL     = "https://html.duckduckgo.com/html"
	liteSearchURL = "https://lite.duckduckgo.com/lite/"
)

// The browser the search posts as. Accept-Encoding is left to net/http, which then
// decompresses what it asked for.
var searchHeaders = map[string]string{
	"User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
	"Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"Accept-Language":           "en-US,en;q=0.9",
	"Sec-Fetch-Dest":            "document",
	"Sec-Fetch-Mode":            "navigate",
	"Sec-Fetch-Site":            "none",
	"Sec-Fetch-User":            "?1",
	"Sec-Ch-Ua":                 `"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"`,
	"Sec-Ch-Ua-Mobile":          "?0",
	"Sec-Ch-Ua-Platform":        `"Windows"`,
	"Upgrade-Insecure-Requests": "1",
}

type safeSearch struct{ name, kp string }

var safeSearchModes = map[string]safeSearch{
	"STRICT":   {"STRICT", "1"},
	"MODERATE": {"MODERATE", "-1"},
	"OFF":      {"OFF", "-2"},
}

type searchResult struct {
	title, link, snippet string
}

type searcher struct {
	client          *http.Client
	safeSearch      safeSearch
	region          string
	limiter         *limiter
	refURLThreshold int
	links           *links
	endpoints       [2]string // the HTML endpoint, then the lite one it falls back to
}

// errBlocked is DuckDuckGo refusing a search: a 202 or 403, or an empty page.
type errBlocked struct{ status int }

func (e errBlocked) Error() string {
	return fmt.Sprintf("DuckDuckGo refused the search (HTTP %d)", e.status)
}

func (s *searcher) search(ctx context.Context, query string, maxResults int, region string) ([]searchResult, error) {
	if err := s.limiter.acquire(ctx); err != nil {
		return nil, err
	}
	if region == "" {
		region = s.region
	}
	form := url.Values{"q": {query}, "b": {""}, "kl": {region}, "kp": {s.safeSearch.kp}}
	page, err := s.post(ctx, s.endpoints[0], form)
	if err == nil {
		return parseResults(page, maxResults)
	}
	if _, blocked := err.(errBlocked); !blocked {
		return nil, err
	}
	page, liteErr := s.post(ctx, s.endpoints[1], form)
	if liteErr != nil {
		return nil, fmt.Errorf("%w, and its lite endpoint too: %w", err, liteErr)
	}
	return parseLiteResults(page, maxResults)
}

func (s *searcher) post(ctx context.Context, endpoint string, form url.Values) (string, error) {
	do := func() (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
		if err != nil {
			return nil, fmt.Errorf("build search request: %w", err)
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		for k, v := range searchHeaders {
			req.Header.Set(k, v)
		}
		return s.client.Do(req)
	}
	resp, err := do()
	if err != nil {
		return "", fmt.Errorf("search request: %w", err)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		resp.Body.Close()
		if err := sleepRetryAfter(ctx, resp.Header); err != nil {
			return "", err
		}
		if resp, err = do(); err != nil {
			return "", fmt.Errorf("search request: %w", err)
		}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read search results: %w", err)
	}
	page := string(body)
	switch {
	case resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusForbidden:
		return "", errBlocked{resp.StatusCode}
	case resp.StatusCode == http.StatusOK && strings.TrimSpace(page) == "":
		return "", errBlocked{resp.StatusCode}
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return "", fmt.Errorf("search request: HTTP %d", resp.StatusCode)
	}
	return page, nil
}

func parseResults(page string, maxResults int) ([]searchResult, error) {
	doc, err := html.Parse(strings.NewReader(page))
	if err != nil {
		return nil, fmt.Errorf("parse search results: %w", err)
	}
	var results []searchResult
	for _, r := range selectAll(doc, ".result", 0) {
		title := selectOne(r, ".result__title")
		if title == nil {
			continue
		}
		a := selectOne(title, "a")
		if a == nil {
			continue
		}
		link := attr(a, "href")
		if strings.Contains(link, "y.js") {
			continue // an ad
		}
		snippet := ""
		if s := selectOne(r, ".result__snippet"); s != nil {
			snippet = text(s, "", true)
		}
		results = append(results, searchResult{title: text(a, "", true), link: cleanRedirect(link), snippet: snippet})
		if len(results) >= maxResults {
			break
		}
	}
	return results, nil
}

// parseLiteResults reads the lite endpoint's table: a result-link anchor per result, and
// the next result-snippet cell its summary.
func parseLiteResults(page string, maxResults int) ([]searchResult, error) {
	doc, err := html.Parse(strings.NewReader(page))
	if err != nil {
		return nil, fmt.Errorf("parse search results: %w", err)
	}
	var results []searchResult
	var walk func(*html.Node) bool
	walk = func(n *html.Node) bool {
		if n.Type == html.ElementNode {
			switch {
			case n.Data == "a" && hasClass(n, "result-link"):
				link := attr(n, "href")
				if !strings.Contains(link, "y.js") {
					results = append(results, searchResult{title: text(n, "", true), link: cleanRedirect(link)})
				}
			case hasClass(n, "result-snippet") && len(results) > 0 && results[len(results)-1].snippet == "":
				results[len(results)-1].snippet = text(n, "", true)
				if len(results) >= maxResults {
					return false
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if !walk(c) {
				return false
			}
		}
		return true
	}
	walk(doc)
	if len(results) > maxResults {
		results = results[:maxResults]
	}
	return results, nil
}

func cleanRedirect(link string) string {
	if strings.HasPrefix(link, "//duckduckgo.com/l/?uddg=") {
		_, rest, _ := strings.Cut(link, "uddg=")
		target, _, _ := strings.Cut(rest, "&")
		if unescaped, err := url.QueryUnescape(target); err == nil {
			return unescaped
		}
		return target
	}
	return link
}

func (s *searcher) format(results []searchResult) string {
	if len(results) == 0 {
		return "No results were found for your search query. This could be due to " +
			"DuckDuckGo's bot detection or the query returned no matches. Please try " +
			"rephrasing your search or try again in a few minutes."
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Found %d search results:\n\n", len(results))
	for i, r := range results {
		fmt.Fprintf(&b, "%d. %s\n   URL: %s\n   Summary: %s\n\n", i+1, r.title, s.displayURL(r.link), r.snippet)
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func (s *searcher) displayURL(link string) string {
	if s.refURLThreshold == 0 || len(link) <= s.refURLThreshold {
		return link
	}
	return s.links.shorten(link) + " (long URL shortened; pass to fetch_content as-is, or call expand_link to get the full URL)"
}
