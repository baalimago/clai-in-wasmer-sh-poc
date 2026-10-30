package main

import (
	"fmt"
	"os"
	"strings"
	"unicode"
)

type edit struct {
	OldText string `json:"oldText"`
	NewText string `json:"newText"`
}

// applyEdits applies edits to the file in order and returns the change as a fenced unified
// diff; dryRun leaves the file as it is. An edit matches exactly, or else line by line
// ignoring each line's surrounding whitespace, and its new lines then take the matched lines'
// indentation. The file keeps its predominant line ending.
func applyEdits(file string, edits []edit, dryRun bool) (string, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	eol := detectLineEnding(string(raw))
	content := normalizeLineEndings(string(raw))
	modified := content
	for _, e := range edits {
		oldText, newText := normalizeLineEndings(e.OldText), normalizeLineEndings(e.NewText)
		if strings.Contains(modified, oldText) {
			modified = strings.Replace(modified, oldText, newText, 1)
			continue
		}
		var ok bool
		if modified, ok = replaceLoosely(modified, oldText, newText); !ok {
			return "", fmt.Errorf("Could not find exact match for edit:\n%s", e.OldText)
		}
	}
	diff := unifiedDiff(file, content, modified)
	if eol == "\r\n" {
		modified = strings.ReplaceAll(modified, "\n", "\r\n")
	}
	fence := "```"
	for strings.Contains(diff, fence) {
		fence += "`"
	}
	if !dryRun {
		if err := overwrite(file, modified); err != nil {
			return "", err
		}
	}
	return fence + "diff\n" + diff + fence + "\n\n", nil
}

func replaceLoosely(content, oldText, newText string) (string, bool) {
	oldLines := strings.Split(oldText, "\n")
	lines := strings.Split(content, "\n")
	for i := 0; i+len(oldLines) <= len(lines); i++ {
		match := lines[i : i+len(oldLines)]
		same := true
		for j, l := range oldLines {
			if strings.TrimSpace(l) != strings.TrimSpace(match[j]) {
				same = false
				break
			}
		}
		if !same {
			continue
		}
		newLines := strings.Split(newText, "\n")
		editUnit := indentUnit(append(append([]string{}, oldLines...), newLines...))
		fileUnit := indentUnit(lines)
		for j, l := range newLines {
			k := min(j, len(oldLines)-1)
			newLines[j] = reindent(l, match[k], oldLines[k], editUnit, fileUnit)
		}
		out := append(append(append([]string{}, lines[:i]...), newLines...), lines[i+len(oldLines):]...)
		return strings.Join(out, "\n"), true
	}
	return content, false
}

func normalizeLineEndings(s string) string { return strings.ReplaceAll(s, "\r\n", "\n") }

func detectLineEnding(s string) string {
	crlf := strings.Count(s, "\r\n")
	if crlf > strings.Count(s, "\n")-crlf {
		return "\r\n"
	}
	return "\n"
}

func leadingWhitespace(line string) string {
	return line[:len(line)-len(strings.TrimLeftFunc(line, unicode.IsSpace))]
}

// indentUnit is a tab when an indented line starts with one, else the narrowest indentation
// of spaces, or "" when no line is indented.
func indentUnit(lines []string) string {
	narrowest := -1
	for _, l := range lines {
		indent := leadingWhitespace(l)
		if indent == "" || strings.TrimSpace(l) == "" {
			continue
		}
		if strings.Contains(indent, "\t") {
			return "\t"
		}
		if narrowest < 0 || len(indent) < narrowest {
			narrowest = len(indent)
		}
	}
	if narrowest < 0 {
		return ""
	}
	return strings.Repeat(" ", narrowest)
}

// reindent gives line the indentation of fileLine, the file line it replaces, shifted by how
// much it is indented relative to oldLine, the edit line that matched fileLine; counted in
// indent levels when the edit and the file indent with different characters.
func reindent(line, fileLine, oldLine, editUnit, fileUnit string) string {
	body := strings.TrimLeftFunc(line, unicode.IsSpace)
	if body == "" {
		return line
	}
	fileIndent := leadingWhitespace(fileLine)
	newIndent := leadingWhitespace(line)
	delta := len(newIndent) - len(leadingWhitespace(oldLine))
	if editUnit != "" && fileUnit != "" && (editUnit == "\t") != (fileUnit == "\t") {
		levels := delta / len(editUnit)
		if levels >= 0 {
			return fileIndent + strings.Repeat(fileUnit, levels) + body
		}
		return fileIndent[:max(0, len(fileIndent)+levels*len(fileUnit))] + body
	}
	if delta >= 0 {
		return fileIndent + newIndent[len(newIndent)-delta:] + body
	}
	return fileIndent[:max(0, len(fileIndent)+delta)] + body
}
