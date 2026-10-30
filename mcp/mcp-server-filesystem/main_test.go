package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture lays out a directory like the one the expected outputs below were taken from with
// @modelcontextprotocol/server-filesystem 2.1.0 itself, and returns it with its symlinks
// resolved.
func fixture(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"a.md":                "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\nline11\nline12\n",
		"notes/b.txt":         "hello\r\nworld\r\n",
		"notes/sub/c.md":      "    if (x) {\n        y();\n    }\n",
		"noeol.txt":           "one\ntwo",
		"node_modules/x/i.js": "x",
		"img.png":             "PNGDATA",
	}
	for name, content := range files {
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	outsideDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outsideDir, "secret"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	return root
}

type callResult struct {
	Content []struct {
		Type     string `json:"type"`
		Text     string `json:"text"`
		Data     string `json:"data"`
		MimeType string `json:"mimeType"`
	} `json:"content"`
	Structured map[string]any `json:"structuredContent"`
	IsError    bool           `json:"isError"`
}

// callTool runs one tools/call against a server confined to dirs.
func callTool(t *testing.T, dirs []string, name string, args any) callResult {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": args}})
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := newServer(dirs).Serve(context.Background(), bytes.NewReader(append(raw, '\n')), &out); err != nil {
		t.Fatalf("serve: %v", err)
	}
	var resp struct {
		Result callResult      `json:"result"`
		Error  json.RawMessage `json:"error"`
	}
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("response %q: %v", out.String(), err)
	}
	if resp.Error != nil {
		t.Fatalf("%s: protocol error %s", name, resp.Error)
	}
	return resp.Result
}

func TestToolsAnswerAsTheOriginal(t *testing.T) {
	root := fixture(t)
	dirs := []string{root}
	diffHeader := func(file string) string {
		file = filepath.Join(root, file)
		return "```diff\nIndex: " + file + "\n" + strings.Repeat("=", 67) + "\n--- " + file + "\toriginal\n+++ " + file + "\tmodified\n"
	}
	steps := []struct {
		tool    string
		args    map[string]any
		want    string
		isError bool
	}{
		{"list_allowed_directories", map[string]any{}, "Allowed directories:\n" + root, false},
		{"list_directory", map[string]any{"path": root}, "[FILE] a.md\n[FILE] escape\n[FILE] img.png\n[DIR] node_modules\n[FILE] noeol.txt\n[DIR] notes", false},
		{"list_directory_with_sizes", map[string]any{"path": root, "sortBy": "size"}, "[DIR] node_modules                   \n[DIR] notes                          \n[FILE] a.md                                 75 B\n[FILE] img.png                               7 B\n[FILE] noeol.txt                             7 B\n[FILE] escape                                0 B\n\nTotal: 4 files, 2 directories\nCombined size: 89 B", false},
		{"read_text_file", map[string]any{"path": root + "/a.md", "head": 3}, "line1\nline2\nline3", false},
		{"read_text_file", map[string]any{"path": root + "/a.md", "tail": 2}, "line11\nline12", false},
		{"read_text_file", map[string]any{"path": root + "/notes/b.txt", "tail": 1}, "world", false},
		{"read_file", map[string]any{"path": "a.md", "head": 1}, "line1", false},
		{"read_text_file", map[string]any{"path": root + "/a.md", "head": 1, "tail": 1}, "Cannot specify both head and tail parameters simultaneously", true},
		{"read_text_file", map[string]any{"path": "/etc/passwd"}, "Access denied - path outside allowed directories: /etc/passwd not in " + root, true},
		{"read_text_file", map[string]any{"path": root + "/missing.txt"}, "ENOENT: no such file or directory, open '" + root + "/missing.txt'", true},
		{"read_text_file", map[string]any{}, "Input validation error: Invalid arguments for tool read_text_file: path: Invalid input: expected string, received undefined", true},
		{"read_multiple_files", map[string]any{"paths": []string{root + "/noeol.txt", root + "/nope"}}, root + "/noeol.txt:\none\ntwo\n\n---\n" + root + "/nope: Error - ENOENT: no such file or directory, open '" + root + "/nope'", false},
		{"write_file", map[string]any{"path": root + "/w.md", "content": "first\n"}, "Successfully wrote to " + root + "/w.md", false},
		{"write_file", map[string]any{"path": root + "/w.md", "content": "second\n"}, "Successfully wrote to " + root + "/w.md", false},
		{"read_text_file", map[string]any{"path": root + "/w.md"}, "second\n", false},
		{"edit_file", map[string]any{"path": root + "/a.md", "dryRun": true, "edits": []map[string]string{{"oldText": "line2", "newText": "LINE2"}, {"oldText": "line11\n", "newText": ""}}},
			diffHeader("a.md") + "@@ -1,12 +1,11 @@\n line1\n-line2\n+LINE2\n line3\n line4\n line5\n line6\n line7\n line8\n line9\n line10\n-line11\n line12\n```\n\n", false},
		{"edit_file", map[string]any{"path": root + "/a.md", "edits": []map[string]string{{"oldText": "line6\nline7", "newText": "six\nseven\nextra"}}},
			diffHeader("a.md") + "@@ -2,10 +2,11 @@\n line2\n line3\n line4\n line5\n-line6\n-line7\n+six\n+seven\n+extra\n line8\n line9\n line10\n line11\n```\n\n", false},
		{"edit_file", map[string]any{"path": root + "/notes/sub/c.md", "edits": []map[string]string{{"oldText": "if (x) {\n    y();\n}", "newText": "if (x) {\n    y();\n    z();\n}"}}},
			diffHeader("notes/sub/c.md") + "@@ -1,3 +1,4 @@\n     if (x) {\n         y();\n+        z();\n     }\n```\n\n", false},
		{"read_text_file", map[string]any{"path": root + "/notes/sub/c.md"}, "    if (x) {\n        y();\n        z();\n    }\n", false},
		{"edit_file", map[string]any{"path": root + "/notes/b.txt", "edits": []map[string]string{{"oldText": "world", "newText": "there"}}},
			diffHeader("notes/b.txt") + "@@ -1,2 +1,2 @@\n hello\n-world\n+there\n```\n\n", false},
		{"read_text_file", map[string]any{"path": root + "/notes/b.txt"}, "hello\r\nthere\r\n", false},
		{"edit_file", map[string]any{"path": root + "/noeol.txt", "edits": []map[string]string{{"oldText": "two", "newText": "2"}}},
			diffHeader("noeol.txt") + "@@ -1,2 +1,2 @@\n one\n-two\n\\ No newline at end of file\n+2\n\\ No newline at end of file\n```\n\n", false},
		{"edit_file", map[string]any{"path": root + "/a.md", "edits": []map[string]string{{"oldText": "nothing", "newText": "x"}}}, "Could not find exact match for edit:\nnothing", true},
		{"create_directory", map[string]any{"path": "made/deeper"}, "Successfully created directory made/deeper", false},
		{"move_file", map[string]any{"source": root + "/w.md", "destination": root + "/a.md"}, "Destination already exists: " + root + "/a.md", true},
		{"move_file", map[string]any{"source": root + "/w.md", "destination": root + "/moved.md"}, "Successfully moved " + root + "/w.md to " + root + "/moved.md", false},
		{"search_files", map[string]any{"path": root, "pattern": "**/*.md"}, root + "/a.md\n" + root + "/moved.md\n" + root + "/notes/sub/c.md", false},
		{"search_files", map[string]any{"path": root, "pattern": "*.md"}, root + "/a.md\n" + root + "/moved.md", false},
		{"search_files", map[string]any{"path": root, "pattern": "**/*.{md,txt}", "excludePatterns": []string{"notes/**"}}, root + "/a.md\n" + root + "/moved.md\n" + root + "/noeol.txt", false},
		{"search_files", map[string]any{"path": root, "pattern": "zzz"}, "No matches found", false},
		{"directory_tree", map[string]any{"path": root + "/notes"}, `[
  {
    "name": "b.txt",
    "type": "file"
  },
  {
    "name": "sub",
    "type": "directory",
    "children": [
      {
        "name": "c.md",
        "type": "file"
      }
    ]
  }
]`, false},
		{"directory_tree", map[string]any{"path": root + "/made"}, `[
  {
    "name": "deeper",
    "type": "directory",
    "children": []
  }
]`, false},
	}
	for _, s := range steps {
		got := callTool(t, dirs, s.tool, s.args)
		if len(got.Content) != 1 || got.Content[0].Text != s.want || got.IsError != s.isError {
			t.Errorf("%s %v:\ngot  %+v\nwant %q (isError %t)", s.tool, s.args, got, s.want, s.isError)
			continue
		}
		if !s.isError && got.Structured["content"] != s.want {
			t.Errorf("%s: structured content %v", s.tool, got.Structured)
		}
	}
}

func TestSymlinkOutOfTheDirectoriesIsRefused(t *testing.T) {
	root := fixture(t)
	for _, tool := range []string{"read_text_file", "write_file"} {
		got := callTool(t, []string{root}, tool, map[string]any{"path": root + "/escape/secret", "content": "x"})
		if !got.IsError || !strings.HasPrefix(got.Content[0].Text, "Access denied - symlink target outside allowed directories: ") {
			t.Errorf("%s through a symlink out: %+v", tool, got)
		}
	}
	got := callTool(t, []string{root}, "write_file", map[string]any{"path": root + "/escape/new", "content": "x"})
	if !got.IsError || !strings.HasPrefix(got.Content[0].Text, "Access denied - symlink target outside allowed directories: ") {
		t.Errorf("a new file through a symlink out: %+v", got)
	}
}

func TestOtherTools(t *testing.T) {
	root := fixture(t)
	dirs := []string{root}
	media := callTool(t, dirs, "read_media_file", map[string]any{"path": root + "/img.png"})
	if c := media.Content[0]; c.Type != "image" || c.Data != "UE5HREFUQQ==" || c.MimeType != "image/png" {
		t.Errorf("read_media_file: %+v", media)
	}
	other := callTool(t, dirs, "read_media_file", map[string]any{"path": root + "/a.md"})
	if other.Content[0].Type != "resource" {
		t.Errorf("read_media_file of text: %+v", other)
	}
	info := callTool(t, dirs, "get_file_info", map[string]any{"path": root + "/notes"})
	for _, want := range []string{"isDirectory: true", "isFile: false", "permissions: 755", "created: ", "GMT"} {
		if !strings.Contains(info.Content[0].Text, want) {
			t.Errorf("get_file_info lacks %q: %s", want, info.Content[0].Text)
		}
	}
	tree := callTool(t, dirs, "directory_tree", map[string]any{"path": root, "excludePatterns": []string{"node_modules", "escape", "notes"}})
	if strings.Contains(tree.Content[0].Text, "i.js") || strings.Contains(tree.Content[0].Text, "b.txt") || !strings.Contains(tree.Content[0].Text, "a.md") {
		t.Errorf("directory_tree with excludes: %s", tree.Content[0].Text)
	}
	bad := callTool(t, dirs, "list_directory_with_sizes", map[string]any{"path": root, "sortBy": "date"})
	if !bad.IsError {
		t.Errorf("sortBy date: %+v", bad)
	}
}

func TestRunNeedsADirectory(t *testing.T) {
	if err := run(nil, strings.NewReader(""), io.Discard, io.Discard); err == nil {
		t.Error("no directories: no error")
	}
	file := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(file, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	if err := run([]string{file, "/does/not/exist"}, strings.NewReader(""), io.Discard, &stderr); err == nil {
		t.Error("no usable directories: no error")
	}
	if !strings.Contains(stderr.String(), "is not a directory, skipping") || !strings.Contains(stderr.String(), "Cannot access directory /does/not/exist") {
		t.Errorf("warnings: %s", stderr.String())
	}
	var out bytes.Buffer
	in := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}` + "\n"
	if err := run([]string{t.TempDir()}, strings.NewReader(in), &out, io.Discard); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"name":"secure-filesystem-server"`) {
		t.Errorf("initialize: %s", out.String())
	}
}

func TestGlob(t *testing.T) {
	cases := []struct {
		pattern, name string
		want          bool
	}{
		{"*.md", "a.md", true},
		{"*.md", "x/a.md", false},
		{"**/*.md", "a.md", true},
		{"**/*.md", "x/y/a.md", true},
		{"**", "x/y", true},
		{"x/**", "x", true},
		{"*.{md,txt}", "a.txt", true},
		{"*.{md,txt}", "a.go", false},
		{"{a,b}/{c,d}.md", "b/d.md", true},
		{"*", ".hidden", true},
		{"[ab].md", "c.md", false},
		{"{unclosed", "{unclosed", true},
	}
	for _, c := range cases {
		if got := matchGlob(c.pattern, c.name); got != c.want {
			t.Errorf("matchGlob(%q, %q) = %t", c.pattern, c.name, got)
		}
	}
}

func TestDiffSplitsDistantChanges(t *testing.T) {
	var a, b []string
	for i := range 30 {
		line := strings.Repeat("x", i)
		a = append(a, line)
		if i == 2 || i == 25 {
			line = "changed"
		}
		b = append(b, line)
	}
	diff := unifiedDiff("f", strings.Join(a, "\n")+"\n", strings.Join(b, "\n")+"\n")
	if !strings.Contains(diff, "@@ -1,7 +1,7 @@") || !strings.Contains(diff, "@@ -22,9 +22,9 @@") {
		t.Errorf("hunks:\n%s", diff)
	}
	if got := unifiedDiff("f", "", "new\n"); !strings.Contains(got, "@@ -0,0 +1,1 @@\n+new\n") {
		t.Errorf("from empty:\n%s", got)
	}
}

func TestEditReindentsAcrossTabsAndSpaces(t *testing.T) {
	file := filepath.Join(t.TempDir(), "f.go")
	if err := os.WriteFile(file, []byte("func f() {\n\tif x {\n\t\ty()\n\t}\n}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := applyEdits(file, []edit{{OldText: "if x {\n    y()\n}", NewText: "if x {\n    y()\n    z()\n}"}}, false); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if want := "func f() {\n\tif x {\n\t\ty()\n\t\tz()\n\t}\n}\n"; string(got) != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestFormatSize(t *testing.T) {
	for in, want := range map[int64]string{0: "0 B", 1023: "1023 B", 1024: "1.00 KB", 1536: "1.50 KB", 5 << 40: "5.00 TB", 5 << 50: "5120.00 TB"} {
		if got := formatSize(in); got != want {
			t.Errorf("formatSize(%d) = %q, want %q", in, got, want)
		}
	}
}
