// Command readhigh pads the heap to a given size, then reads a file into a buffer allocated
// after the pad, and reports the address, the digest and whether canaries around the buffer
// survived. A kernel that writes file bytes to a truncated guest address shows up here.
package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"strconv"
	"unsafe"
)

const canary = 0xa5

func main() {
	padMB, _ := strconv.Atoi(os.Args[1])
	name := os.Args[2]

	pad := make([]byte, padMB<<20)
	for i := 0; i < len(pad); i += 4096 {
		pad[i] = byte(i / 4096)
	}

	const guard = 4096
	raw := make([]byte, guard+1<<20+guard)
	for i := range raw {
		raw[i] = canary
	}
	buf := raw[guard : len(raw)-guard]

	f, err := os.Open(name)
	if err != nil {
		fmt.Println("open", err)
		os.Exit(1)
	}
	n, err := f.Read(buf)
	if err != nil {
		fmt.Println("read", err)
		os.Exit(1)
	}
	before, after := true, true
	for _, v := range raw[:guard] {
		before = before && v == canary
	}
	for _, v := range raw[len(raw)-guard:] {
		after = after && v == canary
	}
	bad := 0
	for i := 0; i < len(pad); i += 4096 {
		if pad[i] != byte(i/4096) {
			bad++
		}
	}
	fmt.Printf("pad=%dMB buf=%#x n=%d sum=%x guard=%v/%v padbad=%d\n",
		padMB, uintptr(unsafe.Pointer(&buf[0])), n, sha256.Sum256(buf[:n]), before, after, bad)
}
