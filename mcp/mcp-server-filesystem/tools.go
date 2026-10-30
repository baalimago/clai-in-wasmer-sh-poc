package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/baalimago/clai-in-wasmer-sh-poc/mcp/mcpserver"
)

const schemaDialect = "https://json-schema.org/draft/2020-12/schema"

func objectSchema(required []string, properties map[string]any) map[string]any {
	s := map[string]any{"$schema": schemaDialect, "type": "object", "properties": properties}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

var (
	str         = map[string]any{"type": "string"}
	stringArray = map[string]any{"type": "array", "items": str}
	textOutput  = map[string]any{
		"$schema": schemaDialect, "type": "object", "properties": map[string]any{"content": str},
		"required": []string{"content"}, "additionalProperties": false,
	}
	readOnly = map[string]any{"readOnlyHint": true, "openWorldHint": false}
)

func writes(idempotent, destructive bool) map[string]any {
	return map[string]any{"readOnlyHint": false, "idempotentHint": idempotent, "destructiveHint": destructive, "openWorldHint": false}
}

func text(s string) mcpserver.Result {
	r := mcpserver.Text(s)
	r.Structured = map[string]any{"content": s}
	return r
}

// call decodes a call's arguments into A, checks that the fields required names are present,
// and runs f. Its errors read as the original's.
func call[A any](tool string, required []string, f func(A) (mcpserver.Result, error)) func(context.Context, json.RawMessage) (mcpserver.Result, error) {
	return func(_ context.Context, raw json.RawMessage) (mcpserver.Result, error) {
		var present map[string]json.RawMessage
		if err := mcpserver.DecodeArguments(raw, &present); err != nil {
			return mcpserver.Result{}, err
		}
		for _, name := range required {
			if v, ok := present[name]; !ok || string(v) == "null" {
				return mcpserver.Result{}, fmt.Errorf("Input validation error: Invalid arguments for tool %s: %s: Invalid input: expected %s, received undefined", tool, name, requiredTypes[name])
			}
		}
		var args A
		if err := mcpserver.DecodeArguments(raw, &args); err != nil {
			return mcpserver.Result{}, fmt.Errorf("Input validation error: Invalid arguments for tool %s: %w", tool, err)
		}
		result, err := f(args)
		return result, nodeError(err)
	}
}

var requiredTypes = map[string]string{
	"path": "string", "content": "string", "source": "string", "destination": "string",
	"pattern": "string", "paths": "array", "edits": "array",
}

var mimeTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".flac": "audio/flac",
}

type pathArgs struct {
	Path string `json:"path"`
}

type readTextArgs struct {
	Path string `json:"path"`
	Head *int   `json:"head"`
	Tail *int   `json:"tail"`
}

func tools(dirs []string) []mcpserver.Tool {
	readText := func(tool string) func(context.Context, json.RawMessage) (mcpserver.Result, error) {
		return call(tool, []string{"path"}, func(a readTextArgs) (mcpserver.Result, error) {
			file, err := validatePath(a.Path, dirs)
			if err != nil {
				return mcpserver.Result{}, err
			}
			head, tail := a.Head != nil && *a.Head != 0, a.Tail != nil && *a.Tail != 0
			var content string
			switch {
			case head && tail:
				return mcpserver.Result{}, errors.New("Cannot specify both head and tail parameters simultaneously")
			case tail:
				content, err = tailFile(file, *a.Tail)
			case head:
				content, err = headFile(file, *a.Head)
			default:
				var data []byte
				data, err = os.ReadFile(file)
				content = string(data)
			}
			if err != nil {
				return mcpserver.Result{}, err
			}
			return text(content), nil
		})
	}
	readTextSchema := objectSchema([]string{"path"}, map[string]any{
		"path": str,
		"tail": map[string]any{"type": "number", "description": "If provided, returns only the last N lines of the file"},
		"head": map[string]any{"type": "number", "description": "If provided, returns only the first N lines of the file"},
	})
	pathSchema := objectSchema([]string{"path"}, map[string]any{"path": str})

	return []mcpserver.Tool{
		{
			Name:         "read_file",
			Title:        "Read File (Deprecated)",
			Description:  "Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead.",
			InputSchema:  readTextSchema,
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call:         readText("read_file"),
		},
		{
			Name:  "read_text_file",
			Title: "Read Text File",
			Description: "Read the complete contents of a file from the file system as text. " +
				"Handles various text encodings and provides detailed error messages " +
				"if the file cannot be read. Use this tool when you need to examine " +
				"the contents of a single file. Use the 'head' parameter to read only " +
				"the first N lines of a file, or the 'tail' parameter to read only " +
				"the last N lines of a file. Operates on the file as text regardless of extension. " +
				"Only works within allowed directories.",
			InputSchema:  readTextSchema,
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call:         readText("read_text_file"),
		},
		{
			Name:  "read_media_file",
			Title: "Read Media File",
			Description: "Read a file and return it as a base64-encoded content block with its MIME type. " +
				"Image and audio files are returned as image/audio content; any other file type is " +
				"returned as an embedded resource. Only works within allowed directories.",
			InputSchema: pathSchema,
			Annotations: readOnly,
			Call: call("read_media_file", []string{"path"}, func(a pathArgs) (mcpserver.Result, error) {
				file, err := validatePath(a.Path, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				raw, err := os.ReadFile(file)
				if err != nil {
					return mcpserver.Result{}, err
				}
				data := base64.StdEncoding.EncodeToString(raw)
				mime, ok := mimeTypes[strings.ToLower(filepath.Ext(file))]
				if !ok {
					mime = "application/octet-stream"
				}
				var item map[string]any
				switch {
				case strings.HasPrefix(mime, "image/"):
					item = map[string]any{"type": "image", "data": data, "mimeType": mime}
				case strings.HasPrefix(mime, "audio/"):
					item = map[string]any{"type": "audio", "data": data, "mimeType": mime}
				default:
					uri := url.URL{Scheme: "file", Path: file}
					item = map[string]any{"type": "resource", "resource": map[string]any{"uri": uri.String(), "mimeType": mime, "blob": data}}
				}
				return mcpserver.Result{Content: []any{item}, Structured: map[string]any{"content": []any{item}}}, nil
			}),
		},
		{
			Name:  "read_multiple_files",
			Title: "Read Multiple Files",
			Description: "Read the contents of multiple files simultaneously. This is more " +
				"efficient than reading files one by one when you need to analyze " +
				"or compare multiple files. Each file's content is returned with its " +
				"path as a reference. Failed reads for individual files won't stop " +
				"the entire operation. Only works within allowed directories.",
			InputSchema: objectSchema([]string{"paths"}, map[string]any{
				"paths": map[string]any{"type": "array", "items": str, "minItems": 1,
					"description": "Array of file paths to read. Each path must be a string pointing to a valid file within allowed directories."},
			}),
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call: call("read_multiple_files", []string{"paths"}, func(a struct {
				Paths []string `json:"paths"`
			},
			) (mcpserver.Result, error) {
				if len(a.Paths) == 0 {
					return mcpserver.Result{}, errors.New("Invalid arguments: paths must name at least one file")
				}
				results := make([]string, len(a.Paths))
				for i, p := range a.Paths {
					content, err := readValid(p, dirs)
					if err != nil {
						results[i] = fmt.Sprintf("%s: Error - %v", p, nodeError(err))
						continue
					}
					results[i] = fmt.Sprintf("%s:\n%s\n", p, content)
				}
				return text(strings.Join(results, "\n---\n")), nil
			}),
		},
		{
			Name:  "write_file",
			Title: "Write File",
			Description: "Create a new file or completely overwrite an existing file with new content. " +
				"Use with caution as it will overwrite existing files without warning. " +
				"Handles text content with proper encoding. Only works within allowed directories.",
			InputSchema:  objectSchema([]string{"path", "content"}, map[string]any{"path": str, "content": str}),
			OutputSchema: textOutput,
			Annotations:  writes(true, true),
			Call: call("write_file", []string{"path", "content"}, func(a struct {
				Path    string `json:"path"`
				Content string `json:"content"`
			},
			) (mcpserver.Result, error) {
				file, err := validatePath(a.Path, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				if err := writeFile(file, a.Content); err != nil {
					return mcpserver.Result{}, err
				}
				return text("Successfully wrote to " + a.Path), nil
			}),
		},
		{
			Name:  "edit_file",
			Title: "Edit File",
			Description: "Make line-based edits to a text file. Each edit replaces exact line sequences " +
				"with new content. Returns a git-style diff showing the changes made. " +
				"Only works within allowed directories.",
			InputSchema: objectSchema([]string{"path", "edits"}, map[string]any{
				"path": str,
				"edits": map[string]any{"type": "array", "items": map[string]any{
					"type":     "object",
					"required": []string{"oldText", "newText"},
					"properties": map[string]any{
						"oldText": map[string]any{"type": "string", "description": "Text to search for - must match exactly"},
						"newText": map[string]any{"type": "string", "description": "Text to replace with"},
					},
				}},
				"dryRun": map[string]any{"type": "boolean", "default": false, "description": "Preview changes using git-style diff format"},
			}),
			OutputSchema: textOutput,
			Annotations:  writes(false, true),
			Call: call("edit_file", []string{"path", "edits"}, func(a struct {
				Path   string `json:"path"`
				Edits  []edit `json:"edits"`
				DryRun bool   `json:"dryRun"`
			},
			) (mcpserver.Result, error) {
				file, err := validatePath(a.Path, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				diff, err := applyEdits(file, a.Edits, a.DryRun)
				if err != nil {
					return mcpserver.Result{}, err
				}
				return text(diff), nil
			}),
		},
		{
			Name:  "create_directory",
			Title: "Create Directory",
			Description: "Create a new directory or ensure a directory exists. Can create multiple " +
				"nested directories in one operation. If the directory already exists, " +
				"this operation will succeed silently. Perfect for setting up directory " +
				"structures for projects or ensuring required paths exist. Only works within allowed directories.",
			InputSchema:  pathSchema,
			OutputSchema: textOutput,
			Annotations:  writes(true, false),
			Call: call("create_directory", []string{"path"}, func(a pathArgs) (mcpserver.Result, error) {
				dir, err := validatePath(a.Path, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				if err := os.MkdirAll(dir, 0o755); err != nil {
					return mcpserver.Result{}, err
				}
				return text("Successfully created directory " + a.Path), nil
			}),
		},
		{
			Name:  "list_directory",
			Title: "List Directory",
			Description: "Get a detailed listing of all files and directories in a specified path. " +
				"Results clearly distinguish between files and directories with [FILE] and [DIR] " +
				"prefixes. This tool is essential for understanding directory structure and " +
				"finding specific files within a directory. Only works within allowed directories.",
			InputSchema:  pathSchema,
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call: call("list_directory", []string{"path"}, func(a pathArgs) (mcpserver.Result, error) {
				dir, err := validatePath(a.Path, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				entries, err := os.ReadDir(dir)
				if err != nil {
					return mcpserver.Result{}, err
				}
				lines := make([]string, len(entries))
				for i, e := range entries {
					lines[i] = kind(e.IsDir()) + " " + e.Name()
				}
				return text(strings.Join(lines, "\n")), nil
			}),
		},
		{
			Name:  "list_directory_with_sizes",
			Title: "List Directory with Sizes",
			Description: "Get a detailed listing of all files and directories in a specified path, including sizes. " +
				"Results clearly distinguish between files and directories with [FILE] and [DIR] " +
				"prefixes. This tool is useful for understanding directory structure and " +
				"finding specific files within a directory. Only works within allowed directories.",
			InputSchema: objectSchema([]string{"path"}, map[string]any{
				"path":   str,
				"sortBy": map[string]any{"type": "string", "enum": []string{"name", "size"}, "default": "name", "description": "Sort entries by name or size"},
			}),
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call: call("list_directory_with_sizes", []string{"path"}, func(a struct {
				Path   string `json:"path"`
				SortBy string `json:"sortBy"`
			},
			) (mcpserver.Result, error) {
				if a.SortBy != "" && a.SortBy != "name" && a.SortBy != "size" {
					return mcpserver.Result{}, fmt.Errorf("Invalid arguments: sortBy must be name or size, not %q", a.SortBy)
				}
				listing, err := listWithSizes(a.Path, a.SortBy, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				return text(listing), nil
			}),
		},
		{
			Name:  "directory_tree",
			Title: "Directory Tree",
			Description: "Get a recursive tree view of files and directories as a JSON structure. " +
				"Each entry includes 'name', 'type' (file/directory), and 'children' for directories. " +
				"Files have no children array, while directories always have a children array (which may be empty). " +
				"The output is formatted with 2-space indentation for readability. Only works within allowed directories.",
			InputSchema:  objectSchema([]string{"path"}, map[string]any{"path": str, "excludePatterns": withDefault(stringArray)}),
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call: call("directory_tree", []string{"path"}, func(a struct {
				Path            string   `json:"path"`
				ExcludePatterns []string `json:"excludePatterns"`
			},
			) (mcpserver.Result, error) {
				tree, err := directoryTree(a.Path, a.ExcludePatterns, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				out, err := json.MarshalIndent(tree, "", "  ")
				if err != nil {
					return mcpserver.Result{}, err
				}
				return text(string(out)), nil
			}),
		},
		{
			Name:  "move_file",
			Title: "Move File",
			Description: "Move or rename files and directories. Can move files between directories " +
				"and rename them in a single operation. If the destination exists, the " +
				"operation will fail. Works across different directories and can be used " +
				"for simple renaming within the same directory. Both source and destination must be within allowed directories.",
			InputSchema:  objectSchema([]string{"source", "destination"}, map[string]any{"source": str, "destination": str}),
			OutputSchema: textOutput,
			Annotations:  writes(false, true),
			Call: call("move_file", []string{"source", "destination"}, func(a struct {
				Source      string `json:"source"`
				Destination string `json:"destination"`
			},
			) (mcpserver.Result, error) {
				source, err := validatePath(a.Source, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				destination, err := validatePath(a.Destination, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				if err := moveFile(source, destination); err != nil {
					return mcpserver.Result{}, err
				}
				return text(fmt.Sprintf("Successfully moved %s to %s", a.Source, a.Destination)), nil
			}),
		},
		{
			Name:  "search_files",
			Title: "Search Files",
			Description: "Recursively search for files and directories matching a pattern. " +
				"The patterns should be glob-style patterns that match paths relative to the working directory. " +
				"Use pattern like '*.ext' to match files in current directory, and '**/*.ext' to match files in all subdirectories. " +
				"Returns full paths to all matching items. Great for finding files when you don't know their exact location. " +
				"Only searches within allowed directories.",
			InputSchema:  objectSchema([]string{"path", "pattern"}, map[string]any{"path": str, "pattern": str, "excludePatterns": withDefault(stringArray)}),
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call: call("search_files", []string{"path", "pattern"}, func(a struct {
				Path            string   `json:"path"`
				Pattern         string   `json:"pattern"`
				ExcludePatterns []string `json:"excludePatterns"`
			},
			) (mcpserver.Result, error) {
				root, err := validatePath(a.Path, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				found, err := searchFiles(root, a.Pattern, a.ExcludePatterns, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				if len(found) == 0 {
					return text("No matches found"), nil
				}
				return text(strings.Join(found, "\n")), nil
			}),
		},
		{
			Name:  "get_file_info",
			Title: "Get File Info",
			Description: "Retrieve detailed metadata about a file or directory. Returns comprehensive " +
				"information including size, creation time, last modified time, permissions, " +
				"type and hard-link count. This tool is perfect for understanding file characteristics " +
				"without reading the actual content. Only works within allowed directories.",
			InputSchema:  pathSchema,
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call: call("get_file_info", []string{"path"}, func(a pathArgs) (mcpserver.Result, error) {
				file, err := validatePath(a.Path, dirs)
				if err != nil {
					return mcpserver.Result{}, err
				}
				info, err := fileInfo(file)
				if err != nil {
					return mcpserver.Result{}, err
				}
				return text(info), nil
			}),
		},
		{
			Name:  "list_allowed_directories",
			Title: "List Allowed Directories",
			Description: "Returns the list of directories that this server is allowed to access. " +
				"Subdirectories within these allowed directories are also accessible. " +
				"Use this to understand which directories and their nested paths are available " +
				"before trying to access files.",
			InputSchema:  objectSchema(nil, map[string]any{}),
			OutputSchema: textOutput,
			Annotations:  readOnly,
			Call: call("list_allowed_directories", nil, func(struct{}) (mcpserver.Result, error) {
				return text("Allowed directories:\n" + strings.Join(dirs, "\n")), nil
			}),
		},
	}
}

func withDefault(schema map[string]any) map[string]any {
	out := map[string]any{"default": []string{}}
	for k, v := range schema {
		out[k] = v
	}
	return out
}

func kind(dir bool) string {
	if dir {
		return "[DIR]"
	}
	return "[FILE]"
}

func readValid(p string, dirs []string) (string, error) {
	file, err := validatePath(p, dirs)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(file)
	return string(data), err
}

func listWithSizes(p, sortBy string, dirs []string) (string, error) {
	dir, err := validatePath(p, dirs)
	if err != nil {
		return "", err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", err
	}
	type sized struct {
		name  string
		isDir bool
		size  int64
	}
	list := make([]sized, len(entries))
	for i, e := range entries {
		list[i] = sized{name: e.Name(), isDir: e.IsDir()}
		// A symlink whose target is outside the allowed directories is listed without a size.
		if valid, err := validatePath(filepath.Join(dir, e.Name()), dirs); err == nil {
			if info, err := os.Stat(valid); err == nil {
				list[i].size = info.Size()
			}
		}
	}
	sort.SliceStable(list, func(i, j int) bool {
		if sortBy == "size" {
			return list[i].size > list[j].size
		}
		return list[i].name < list[j].name
	})
	var lines []string
	var files, directories int
	var total int64
	for _, e := range list {
		size := ""
		if e.isDir {
			directories++
		} else {
			files++
			total += e.size
			size = fmt.Sprintf("%10s", formatSize(e.size))
		}
		lines = append(lines, fmt.Sprintf("%s %-30s %s", kind(e.isDir), e.name, size))
	}
	lines = append(lines, "", fmt.Sprintf("Total: %d files, %d directories", files, directories), "Combined size: "+formatSize(total))
	return strings.Join(lines, "\n"), nil
}
