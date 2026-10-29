package main

import (
	"container/list"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
)

const refScheme = "ref://"

// links maps short ref:// tokens to the long URLs search output replaced with them, for the
// life of the process, evicting the least recently used past maxEntries.
type links struct {
	mu         sync.Mutex
	maxEntries int
	order      *list.List // keys, most recently used last
	urls       map[string]*list.Element
	values     map[string]string
}

func newLinks(maxEntries int) *links {
	return &links{
		maxEntries: max(1, maxEntries),
		order:      list.New(),
		urls:       map[string]*list.Element{},
		values:     map[string]string{},
	}
}

// shorten registers url and returns its token: the first 8 hex digits of its SHA-256,
// lengthened only while a different URL holds the shorter one.
func (l *links) shorten(url string) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	sum := sha256.Sum256([]byte(url))
	digest := hex.EncodeToString(sum[:])
	key := digest[:8]
	for n := 8; n <= len(digest); n++ {
		key = digest[:n]
		if existing, ok := l.values[key]; !ok || existing == url {
			break
		}
	}
	if el, ok := l.urls[key]; ok {
		l.order.MoveToBack(el)
	} else {
		l.urls[key] = l.order.PushBack(key)
		l.values[key] = url
		for l.order.Len() > l.maxEntries {
			oldest := l.order.Remove(l.order.Front()).(string)
			delete(l.urls, oldest)
			delete(l.values, oldest)
		}
	}
	return refScheme + key
}

// resolve returns the URL of a token, with or without its scheme.
func (l *links) resolve(token string) (string, bool) {
	key := strings.TrimSpace(token)
	if strings.HasPrefix(strings.ToLower(key), refScheme) {
		key = key[len(refScheme):]
	}
	key = strings.ToLower(strings.Trim(key, "/"))
	l.mu.Lock()
	defer l.mu.Unlock()
	el, ok := l.urls[key]
	if !ok {
		return "", false
	}
	l.order.MoveToBack(el)
	return l.values[key], true
}

func isRefToken(value string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), refScheme)
}

func unknownRefError(token string) string {
	return fmt.Sprintf("Error: Unknown link reference '%s'. Only ref:// tokens "+
		"returned by this server's search results can be expanded, and they are "+
		"forgotten when the server restarts. Run the search again to get a fresh token.",
		strings.TrimSpace(token))
}
