package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// allowedDirectories resolves the directories named on the command line, keeping both the
// spelling given and the one symlinks resolve to, and drops those that are not directories.
// It fails when none is left.
func allowedDirectories(args []string, stderr io.Writer) ([]string, error) {
	var candidates []string
	for _, arg := range args {
		abs, err := filepath.Abs(expandHome(arg))
		if err != nil {
			return nil, fmt.Errorf("resolve %s: %w", arg, err)
		}
		candidates = append(candidates, abs)
		if real, err := filepath.EvalSymlinks(abs); err == nil && real != abs {
			candidates = append(candidates, real)
		}
	}
	var dirs []string
	for _, dir := range candidates {
		info, err := os.Stat(dir)
		switch {
		case err != nil:
			fmt.Fprintf(stderr, "Warning: Cannot access directory %s, skipping\n", dir)
		case !info.IsDir():
			fmt.Fprintf(stderr, "Warning: %s is not a directory, skipping\n", dir)
		default:
			dirs = append(dirs, dir)
		}
	}
	if len(dirs) == 0 {
		return nil, errors.New("None of the specified directories are accessible")
	}
	return dirs, nil
}

func expandHome(p string) string {
	if p != "~" && !strings.HasPrefix(p, "~/") {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return p
	}
	return filepath.Join(home, p[1:])
}

func within(p string, dirs []string) bool {
	p = filepath.Clean(p)
	for _, dir := range dirs {
		if p == dir || strings.HasPrefix(p, strings.TrimSuffix(dir, string(filepath.Separator))+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func outside(p string, dirs []string) error {
	return fmt.Errorf("Access denied - path outside allowed directories: %s not in %s", p, strings.Join(dirs, ", "))
}

// validatePath turns a requested path into the real path a tool may use: a relative path is
// taken against the allowed directories, and the path and, for one that does not exist yet,
// its nearest existing ancestor must resolve, symlinks followed, inside them.
func validatePath(requested string, dirs []string) (string, error) {
	expanded := expandHome(requested)
	abs := filepath.Clean(expanded)
	if !filepath.IsAbs(expanded) {
		abs = filepath.Join(dirs[0], expanded)
		for _, dir := range dirs {
			if candidate := filepath.Join(dir, expanded); within(candidate, dirs) {
				abs = candidate
				break
			}
		}
	}
	if !within(abs, dirs) {
		return "", outside(abs, dirs)
	}
	real, err := filepath.EvalSymlinks(abs)
	if err == nil {
		if !within(real, dirs) {
			return "", fmt.Errorf("Access denied - symlink target outside allowed directories: %s not in %s", real, strings.Join(dirs, ", "))
		}
		return real, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	// Nothing below the nearest existing ancestor exists, so it is the last symlink to check.
	existing, missing := abs, []string{}
	for {
		parent := filepath.Dir(existing)
		missing = append([]string{filepath.Base(existing)}, missing...)
		existing = parent
		if _, err := os.Lstat(existing); err == nil || parent == filepath.Dir(parent) {
			break
		}
	}
	real, err = filepath.EvalSymlinks(existing)
	if err != nil {
		return "", fmt.Errorf("Parent directory does not exist: %s", filepath.Dir(abs))
	}
	if !within(real, dirs) {
		return "", fmt.Errorf("Access denied - symlink target outside allowed directories: %s not in %s", real, strings.Join(dirs, ", "))
	}
	return filepath.Join(append([]string{real}, missing...)...), nil
}
