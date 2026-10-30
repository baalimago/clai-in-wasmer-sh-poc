//go:build wasix

package main

import (
	"os"
	"syscall"
)

// blockingStdin is the os.Stdin the runtime made. It stays reachable: its finalizer closes
// descriptor 0, which the pollable os.Stdin below still reads, and a socket opened after the
// close would take that number.
var blockingStdin *os.File

// The wasix Go port runs every goroutine on one thread, so a blocking read of a piped stdin
// would stop the goroutine answering the MCP request it just read. A pipe or socket stdin goes
// in the netpoller instead; a terminal is left as it is, since its mode is shared with the
// shell.
func init() {
	var st syscall.Stat_t
	if syscall.Fstat(0, &st) != nil {
		return
	}
	if kind := st.Mode & syscall.S_IFMT; kind != syscall.S_IFIFO && kind != syscall.S_IFSOCK {
		return
	}
	if syscall.SetNonblock(0, true) == nil {
		blockingStdin = os.Stdin
		os.Stdin = os.NewFile(0, "/dev/stdin")
	}
}
