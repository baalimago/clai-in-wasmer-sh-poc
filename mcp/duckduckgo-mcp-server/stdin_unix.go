//go:build unix

package main

import (
	"fmt"
	"os"
	"syscall"
)

// pollableStdin returns stdin in the netpoller when it is a pipe or a socket. The browser
// machine's Go port runs every goroutine on one thread, so a blocking read of stdin would
// stop the goroutine answering the request it just read; a client waits for that answer
// before it writes again, so neither would ever move. A terminal is left as it is, since its
// mode is shared with the shell.
func pollableStdin() (*os.File, error) {
	var st syscall.Stat_t
	if err := syscall.Fstat(0, &st); err != nil {
		return nil, fmt.Errorf("stat stdin: %w", err)
	}
	if kind := st.Mode & syscall.S_IFMT; kind != syscall.S_IFIFO && kind != syscall.S_IFSOCK {
		return os.Stdin, nil
	}
	if err := syscall.SetNonblock(0, true); err != nil {
		return nil, fmt.Errorf("make stdin non-blocking: %w", err)
	}
	// os.NewFile puts a non-blocking descriptor in the netpoller.
	return os.NewFile(0, "/dev/stdin"), nil
}
