// Which file operations of the port survive the page: the browser's host bridges a guest's
// i64 argument to the kernel through JavaScript, and wasm-bindgen wants a BigInt there. Add it
// to the page's /bin as `seek` to run it in a tab.
package main

import (
	"fmt"
	"os"
)

func step(name string, run func() error) {
	if err := run(); err != nil {
		fmt.Printf("%s: %v\n", name, err)
		return
	}
	fmt.Printf("%s: ok\n", name)
}

func main() {
	const path = "/tmp/seek-probe"
	step("create", func() error {
		file, err := os.Create(path)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = file.WriteString("hello, world\n")
		return err
	})
	step("seek", func() error {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		offset, err := file.Seek(7, 0)
		if err != nil {
			return err
		}
		at := make([]byte, 5)
		n, err := file.Read(at)
		if err != nil {
			return err
		}
		fmt.Printf("  at %d: %q\n", offset, at[:n])
		return nil
	})
	step("readat", func() error {
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		defer file.Close()
		at := make([]byte, 5)
		if _, err := file.ReadAt(at, 7); err != nil {
			return err
		}
		fmt.Printf("  %q\n", at)
		return nil
	})
	step("readfile", func() error {
		at, err := os.ReadFile(path)
		fmt.Printf("  %q\n", at)
		return err
	})
}