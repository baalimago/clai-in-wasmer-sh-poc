package main

import (
	"path"
	"strings"
)

// matchGlob reports whether the slash-separated relative path name matches pattern as
// minimatch matches it with dot set: `**` as a whole segment matches any number of segments,
// `{a,b}` alternatives, and *, ? and [...] within a segment.
func matchGlob(pattern, name string) bool {
	for _, p := range expandBraces(pattern) {
		if matchSegments(strings.Split(p, "/"), strings.Split(name, "/")) {
			return true
		}
	}
	return false
}

func matchSegments(pattern, name []string) bool {
	for len(pattern) > 0 {
		if pattern[0] == "**" {
			for i := 0; i <= len(name); i++ {
				if matchSegments(pattern[1:], name[i:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		if ok, err := path.Match(pattern[0], name[0]); err != nil || !ok {
			return false
		}
		pattern, name = pattern[1:], name[1:]
	}
	return len(name) == 0
}

// expandBraces expands the first {a,b} group of pattern, recursively, so "*.{md,txt}" is
// "*.md" and "*.txt". A pattern without a complete group is itself.
func expandBraces(pattern string) []string {
	open := strings.IndexByte(pattern, '{')
	if open < 0 {
		return []string{pattern}
	}
	depth, close := 0, -1
	var commas []int
	for i := open; i < len(pattern) && close < 0; i++ {
		switch pattern[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				close = i
			}
		case ',':
			if depth == 1 {
				commas = append(commas, i)
			}
		}
	}
	if close < 0 || len(commas) == 0 {
		return []string{pattern}
	}
	var out []string
	start := open + 1
	for _, end := range append(commas, close) {
		for _, rest := range expandBraces(pattern[close+1:]) {
			for _, alt := range expandBraces(pattern[start:end]) {
				out = append(out, pattern[:open]+alt+rest)
			}
		}
		start = end + 1
	}
	return out
}
