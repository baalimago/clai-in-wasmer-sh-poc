//go:build unix

package main

import (
	"os"
	"syscall"
	"testing"
)

func TestPollableStdin(t *testing.T) {
	saved, err := syscall.Dup(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := syscall.Dup2(saved, 0); err != nil {
			t.Error(err)
		}
		syscall.Close(saved)
	})
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if err := syscall.Dup2(int(r.Fd()), 0); err != nil {
		t.Fatal(err)
	}
	r.Close()
	if err := syscall.SetNonblock(0, false); err != nil {
		t.Fatal(err)
	}
	f, err := pollableStdin()
	if err != nil {
		t.Fatal(err)
	}
	if f == os.Stdin {
		t.Error("a pipe should get a new, pollable file")
	}
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, 0, syscall.F_GETFL, 0)
	if errno != 0 || flags&syscall.O_NONBLOCK == 0 {
		t.Errorf("stdin is not non-blocking: flags %#x, errno %v", flags, errno)
	}
	if _, err := w.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1)
	if n, err := f.Read(buf); n != 1 || err != nil {
		t.Errorf("read %d, %v", n, err)
	}
}
