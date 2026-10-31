// Command readsha prints the SHA-256 and size of the files named on its command line, so that a
// read that the kernel mangles shows up as a digest that differs from the host's.
package main

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
)

func main() {
	for _, name := range os.Args[1:] {
		if err := one(name); err != nil {
			fmt.Printf("%s error %v\n", name, err)
		}
	}
}

func one(name string) error {
	f, err := os.Open(name)
	if err != nil {
		return err
	}
	defer f.Close()

	whole, err := io.ReadAll(f)
	if err != nil {
		return err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return err
	}
	chunked := sha256.New()
	buf := make([]byte, 32<<10)
	for {
		n, err := f.Read(buf)
		chunked.Write(buf[:n])
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
	}

	fmt.Printf("%s %d %x %x\n", name, len(whole), sha256.Sum256(whole), chunked.Sum(nil))
	return nil
}
