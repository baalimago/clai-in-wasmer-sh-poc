package main

import (
	"errors"
	"fmt"
	"io/fs"
	"syscall"
)

var errnoCodes = map[syscall.Errno]string{
	syscall.ENOENT:    "ENOENT",
	syscall.EEXIST:    "EEXIST",
	syscall.EACCES:    "EACCES",
	syscall.EPERM:     "EPERM",
	syscall.ENOTDIR:   "ENOTDIR",
	syscall.EISDIR:    "EISDIR",
	syscall.ENOTEMPTY: "ENOTEMPTY",
	syscall.EXDEV:     "EXDEV",
	syscall.ELOOP:     "ELOOP",
}

var nodeOps = map[string]string{"stat": "stat", "lstat": "lstat", "readdirent": "scandir", "mkdir": "mkdir", "rename": "rename"}

// nodeError words a failed file operation as Node.js does, "ENOENT: no such file or directory,
// open '/x'", since that is what the original's callers see.
func nodeError(err error) error {
	var pathErr *fs.PathError
	var errno syscall.Errno
	if !errors.As(err, &pathErr) || !errors.As(err, &errno) {
		return err
	}
	code, ok := errnoCodes[errno]
	if !ok {
		return err
	}
	op, ok := nodeOps[pathErr.Op]
	if !ok {
		op = pathErr.Op
	}
	return fmt.Errorf("%s: %s, %s '%s'", code, errno.Error(), op, pathErr.Path)
}
