// Command readat reads a file twice: once at offsets through ReadAt in blocks, once through Read
// from the start, and compares the two digests. A pread that the kernel resolves to the wrong
// offset shows up as a mismatch.
package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"strconv"
)

func main() {
	name := os.Args[1]
	size, _ := strconv.Atoi(os.Args[2])

	f, err := os.Open(name)
	if err != nil {
		fmt.Println("open", err)
		os.Exit(1)
	}
	at := sha256.New()
	buf := make([]byte, size)
	for off := int64(0); ; {
		n, err := f.ReadAt(buf, off)
		at.Write(buf[:n])
		off += int64(n)
		if err == io.EOF || n == 0 {
			break
		}
		if err != nil {
			fmt.Println("readat", err)
			os.Exit(1)
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		fmt.Println("seek", err)
		os.Exit(1)
	}
	seq := sha256.New()
	if _, err := io.CopyBuffer(seq, f, buf); err != nil {
		fmt.Println("copy", err)
		os.Exit(1)
	}
	ok := bytes.Equal(at.Sum(nil), seq.Sum(nil))
	fmt.Printf("%s block=%d readat=%x seq=%x same=%v\n", name, size, at.Sum(nil), seq.Sum(nil), ok)
	if !ok {
		os.Exit(1)
	}
}
