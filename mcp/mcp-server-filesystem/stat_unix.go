//go:build linux || wasix

package main

import (
	"io/fs"
	"syscall"
	"time"
)

type times struct {
	created, accessed time.Time
	links             uint64
}

// statTimes reads what fs.FileInfo leaves out. There is no birth time here, so created is
// the status change time.
func statTimes(info fs.FileInfo) times {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return times{created: info.ModTime(), accessed: info.ModTime(), links: 1}
	}
	return times{
		created:  time.Unix(st.Ctim.Unix()),
		accessed: time.Unix(st.Atim.Unix()),
		links:    uint64(st.Nlink),
	}
}
