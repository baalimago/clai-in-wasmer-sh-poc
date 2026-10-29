package main

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"time"
)

// limiter allows at most perMinute acquisitions in any 60 seconds, as the Python server's
// default sliding window does.
type limiter struct {
	mu        sync.Mutex
	perMinute int
	recent    []time.Time
	now       func() time.Time
}

func newLimiter(perMinute int) *limiter {
	return &limiter{perMinute: max(1, perMinute), now: time.Now}
}

func (l *limiter) acquire(ctx context.Context) error {
	for {
		l.mu.Lock()
		now := l.now()
		kept := l.recent[:0]
		for _, t := range l.recent {
			if now.Sub(t) < time.Minute {
				kept = append(kept, t)
			}
		}
		l.recent = kept
		if len(l.recent) < l.perMinute {
			l.recent = append(l.recent, now)
			l.mu.Unlock()
			return nil
		}
		wait := time.Minute - now.Sub(l.recent[0])
		l.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
}

// hostLimiters gives each host its own limiter, so fetches cannot spend the whole quota on
// one site.
type hostLimiters struct {
	mu        sync.Mutex
	perMinute int
	hosts     map[string]*limiter
}

func (h *hostLimiters) acquire(ctx context.Context, rawURL string) error {
	host := "unknown"
	if u, err := url.Parse(rawURL); err == nil && u.Hostname() != "" {
		host = strings.ToLower(u.Hostname())
	}
	h.mu.Lock()
	l, ok := h.hosts[host]
	if !ok {
		l = newLimiter(h.perMinute)
		h.hosts[host] = l
	}
	h.mu.Unlock()
	return l.acquire(ctx)
}

// cache keeps fetched pages' text for a while, evicting the oldest past maxEntries, so
// paginated reads of one page download it once.
type cache struct {
	mu         sync.Mutex
	ttl        time.Duration
	maxEntries int
	entries    map[string]cacheEntry
	order      []string
	now        func() time.Time
}

type cacheEntry struct {
	expires time.Time
	text    string
}

func newCache(ttl time.Duration, maxEntries int) *cache {
	return &cache{ttl: ttl, maxEntries: maxEntries, entries: map[string]cacheEntry{}, now: time.Now}
}

func (c *cache) enabled() bool { return c.ttl > 0 && c.maxEntries > 0 }

func (c *cache) get(key string) (string, bool) {
	if !c.enabled() {
		return "", false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return "", false
	}
	if !c.now().Before(e.expires) {
		c.remove(key)
		return "", false
	}
	c.touch(key)
	return e.text, true
}

func (c *cache) set(key, text string) {
	if !c.enabled() {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	for k, e := range c.entries {
		if !now.Before(e.expires) {
			c.remove(k)
		}
	}
	if _, ok := c.entries[key]; ok {
		c.remove(key)
	} else if len(c.entries) >= c.maxEntries {
		c.remove(c.order[0])
	}
	c.entries[key] = cacheEntry{expires: now.Add(c.ttl), text: text}
	c.order = append(c.order, key)
}

func (c *cache) remove(key string) {
	delete(c.entries, key)
	c.unlist(key)
}

func (c *cache) touch(key string) {
	c.unlist(key)
	c.order = append(c.order, key)
}

func (c *cache) unlist(key string) {
	for i, k := range c.order {
		if k == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			return
		}
	}
}
