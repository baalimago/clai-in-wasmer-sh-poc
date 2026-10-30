//go:build !linux && !wasix

package main

import (
	"io/fs"
	"time"
)

type times struct {
	created, accessed time.Time
	links             uint64
}

func statTimes(info fs.FileInfo) times {
	return times{created: info.ModTime(), accessed: info.ModTime(), links: 1}
}
