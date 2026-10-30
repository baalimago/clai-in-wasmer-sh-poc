package main

import (
	"fmt"
	"strings"
)

// diffContext is the context lines jsdiff's createTwoFilesPatch gives each hunk.
const diffContext = 4

// maxDiffCells bounds the table the line diff fills: a change too big for it is one hunk
// replacing everything between the common head and tail.
const maxDiffCells = 4_000_000

type diffLine struct {
	op   byte // ' ', '-' or '+'
	text string
	// The line is the last of its file and has no newline after it.
	noEOL bool
}

// unifiedDiff renders the change from a to b as jsdiff's createTwoFilesPatch does, with
// "original" and "modified" as the headers.
func unifiedDiff(name, a, b string) string {
	var out strings.Builder
	out.WriteString("Index: " + name + "\n")
	out.WriteString(strings.Repeat("=", 67) + "\n")
	fmt.Fprintf(&out, "--- %s\toriginal\n+++ %s\tmodified\n", name, name)
	lines := diffLines(splitLines(a), splitLines(b))
	for _, h := range hunks(lines) {
		oldStart, newStart, oldCount, newCount := h.oldStart, h.newStart, 0, 0
		for _, l := range lines[h.from:h.to] {
			if l.op != '+' {
				oldCount++
			}
			if l.op != '-' {
				newCount++
			}
		}
		if oldCount == 0 {
			oldStart--
		}
		if newCount == 0 {
			newStart--
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", oldStart, oldCount, newStart, newCount)
		for _, l := range lines[h.from:h.to] {
			out.WriteString(string(l.op) + l.text + "\n")
			if l.noEOL {
				out.WriteString("\\ No newline at end of file\n")
			}
		}
	}
	return out.String()
}

type textLine struct {
	text  string
	noEOL bool
}

func splitLines(s string) []textLine {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "\n")
	noEOL := parts[len(parts)-1] != ""
	if !noEOL {
		parts = parts[:len(parts)-1]
	}
	lines := make([]textLine, len(parts))
	for i, p := range parts {
		lines[i] = textLine{text: p}
	}
	lines[len(lines)-1].noEOL = noEOL
	return lines
}

// diffLines aligns a and b on a longest common subsequence of lines.
func diffLines(a, b []textLine) []diffLine {
	head := 0
	for head < len(a) && head < len(b) && a[head] == b[head] {
		head++
	}
	tail := 0
	for tail < len(a)-head && tail < len(b)-head && a[len(a)-1-tail] == b[len(b)-1-tail] {
		tail++
	}
	var out []diffLine
	for _, l := range a[:head] {
		out = append(out, diffLine{' ', l.text, l.noEOL})
	}
	out = append(out, diffMiddle(a[head:len(a)-tail], b[head:len(b)-tail])...)
	for _, l := range a[len(a)-tail:] {
		out = append(out, diffLine{' ', l.text, l.noEOL})
	}
	return out
}

func diffMiddle(a, b []textLine) []diffLine {
	var out []diffLine
	if len(a)*len(b) > maxDiffCells {
		for _, l := range a {
			out = append(out, diffLine{'-', l.text, l.noEOL})
		}
		for _, l := range b {
			out = append(out, diffLine{'+', l.text, l.noEOL})
		}
		return out
	}
	// lcs[i][j] is the common subsequence length of a[i:] and b[j:].
	lcs := make([][]int32, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int32, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	i, j := 0, 0
	for i < len(a) || j < len(b) {
		switch {
		case i < len(a) && j < len(b) && a[i] == b[j]:
			out = append(out, diffLine{' ', a[i].text, a[i].noEOL})
			i++
			j++
		case j == len(b) || (i < len(a) && lcs[i+1][j] >= lcs[i][j+1]):
			out = append(out, diffLine{'-', a[i].text, a[i].noEOL})
			i++
		default:
			out = append(out, diffLine{'+', b[j].text, b[j].noEOL})
			j++
		}
	}
	return out
}

type hunk struct {
	from, to           int
	oldStart, newStart int
}

// hunks groups the changed lines with diffContext lines around them, merging groups whose
// context touches.
func hunks(lines []diffLine) []hunk {
	var out []hunk
	oldLine, newLine := 1, 1
	starts := make([][2]int, len(lines))
	for i, l := range lines {
		starts[i] = [2]int{oldLine, newLine}
		if l.op != '+' {
			oldLine++
		}
		if l.op != '-' {
			newLine++
		}
	}
	for i := 0; i < len(lines); {
		if lines[i].op == ' ' {
			i++
			continue
		}
		from := max(0, i-diffContext)
		end := i
		for {
			for end < len(lines) && lines[end].op != ' ' {
				end++
			}
			next := end
			for next < len(lines) && lines[next].op == ' ' {
				next++
			}
			if next < len(lines) && next-end <= 2*diffContext {
				end = next
				continue
			}
			break
		}
		to := min(len(lines), end+diffContext)
		out = append(out, hunk{from: from, to: to, oldStart: starts[from][0], newStart: starts[from][1]})
		i = to
	}
	return out
}
