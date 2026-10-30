package main

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// maxWalkEntries bounds the entries a recursive walk visits, as the original does.
const maxWalkEntries = 100_000

// writeFile creates file, or, when it exists, overwrites it in place, so its inode, mode and
// links survive; a symlink or other non-regular file in its place is refused.
func writeFile(file, content string) error {
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, fs.ErrExist) {
		return overwrite(file, content)
	}
	if err != nil {
		return err
	}
	_, err = f.WriteString(content)
	return errors.Join(err, f.Close())
}

func overwrite(file, content string) error {
	info, err := os.Lstat(file)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("Refusing to write: not a regular file: %s", file)
	}
	f, err := os.OpenFile(file, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return err
	}
	_, err = f.WriteString(content)
	return errors.Join(err, f.Close())
}

func moveFile(source, destination string) error {
	if _, err := os.Lstat(destination); err == nil {
		return fmt.Errorf("Destination already exists: %s", destination)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Rename(source, destination)
}

func headFile(file string, n int) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	lines := strings.SplitAfter(string(data), "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	lines = lines[:min(n, len(lines))]
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(strings.TrimSuffix(l, "\n"), "\r")
	}
	return strings.Join(lines, "\n"), nil
}

func tailFile(file string, n int) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", err
	}
	text := strings.TrimSuffix(normalizeLineEndings(string(data)), "\n")
	if text == "" {
		return "", nil
	}
	lines := strings.Split(text, "\n")
	return strings.Join(lines[max(0, len(lines)-n):], "\n"), nil
}

func formatSize(bytes int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB"}
	if bytes <= 0 {
		return "0 B"
	}
	i := int(math.Floor(math.Log(float64(bytes)) / math.Log(1024)))
	if i <= 0 {
		return fmt.Sprintf("%d %s", bytes, units[0])
	}
	i = min(i, len(units)-1)
	return fmt.Sprintf("%.2f %s", float64(bytes)/math.Pow(1024, float64(i)), units[i])
}

// jsDate formats t as JavaScript's Date.prototype.toString does.
func jsDate(t time.Time) string {
	zone, _ := t.Zone()
	if zone == "UTC" {
		zone = "Coordinated Universal Time"
	}
	return t.Format("Mon Jan 02 2006 15:04:05 GMT-0700") + " (" + zone + ")"
}

func fileInfo(file string) (string, error) {
	info, err := os.Stat(file)
	if err != nil {
		return "", err
	}
	t := statTimes(info)
	lines := []string{
		fmt.Sprintf("size: %d", info.Size()),
		"created: " + jsDate(t.created),
		"modified: " + jsDate(info.ModTime()),
		"accessed: " + jsDate(t.accessed),
		fmt.Sprintf("isDirectory: %t", info.IsDir()),
		fmt.Sprintf("isFile: %t", info.Mode().IsRegular()),
		fmt.Sprintf("permissions: %03o", info.Mode().Perm()),
		fmt.Sprintf("hardLinks: %d", t.links),
	}
	return strings.Join(lines, "\n"), nil
}

type walkBudget struct {
	operation, root string
	visited         int
}

func (b *walkBudget) visit() error {
	b.visited++
	if b.visited > maxWalkEntries {
		return fmt.Errorf("%s stopped after visiting %d entries under %s, without finishing. Narrow the path, or add excludePatterns for large subtrees.", b.operation, maxWalkEntries, b.root)
	}
	return nil
}

type treeEntry struct {
	Name     string       `json:"name"`
	Type     string       `json:"type"`
	Children *[]treeEntry `json:"children,omitempty"`
}

func directoryTree(root string, excludes []string, dirs []string) ([]treeEntry, error) {
	budget := &walkBudget{operation: "directory_tree", root: root}
	var build func(current string) ([]treeEntry, error)
	build = func(current string) ([]treeEntry, error) {
		valid, err := validatePath(current, dirs)
		if err != nil {
			return nil, err
		}
		entries, err := os.ReadDir(valid)
		if err != nil {
			return nil, err
		}
		result := []treeEntry{}
		for _, entry := range entries {
			rel, err := filepath.Rel(root, filepath.Join(current, entry.Name()))
			if err != nil {
				return nil, err
			}
			rel = filepath.ToSlash(rel)
			if excludedFromTree(rel, excludes) {
				continue
			}
			if err := budget.visit(); err != nil {
				return nil, err
			}
			e := treeEntry{Name: entry.Name(), Type: "file"}
			if entry.IsDir() {
				e.Type = "directory"
				children, err := build(filepath.Join(current, entry.Name()))
				if err != nil {
					return nil, err
				}
				e.Children = &children
			}
			result = append(result, e)
		}
		return result, nil
	}
	return build(root)
}

func excludedFromTree(rel string, excludes []string) bool {
	for _, p := range excludes {
		if strings.Contains(p, "*") {
			if matchGlob(p, rel) {
				return true
			}
			continue
		}
		if matchGlob(p, rel) || matchGlob("**/"+p, rel) || matchGlob("**/"+p+"/**", rel) {
			return true
		}
	}
	return false
}

// searchFiles returns the paths under root whose path relative to root matches pattern,
// skipping excluded entries and entries that resolve outside the allowed directories.
func searchFiles(root, pattern string, excludes, dirs []string) ([]string, error) {
	budget := &walkBudget{operation: "search_files", root: root}
	var results []string
	var search func(current string) error
	search = func(current string) error {
		entries, err := os.ReadDir(current)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			full := filepath.Join(current, entry.Name())
			rel, err := filepath.Rel(root, full)
			if err != nil {
				return err
			}
			rel = filepath.ToSlash(rel)
			if anyGlob(excludes, rel) {
				continue
			}
			if err := budget.visit(); err != nil {
				return err
			}
			if _, err := validatePath(full, dirs); err != nil {
				continue
			}
			if matchGlob(pattern, rel) {
				results = append(results, full)
			}
			if entry.IsDir() {
				if err := search(full); err != nil {
					if _, ok := err.(*fs.PathError); ok {
						continue
					}
					return err
				}
			}
		}
		return nil
	}
	if err := search(root); err != nil {
		return nil, err
	}
	return results, nil
}

func anyGlob(patterns []string, rel string) bool {
	for _, p := range patterns {
		if matchGlob(p, rel) {
			return true
		}
	}
	return false
}
