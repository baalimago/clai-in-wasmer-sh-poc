// Command args checks that a spawned process's argument and environment strings do not sit in
// the memory the Go heap hands out: it allocates, fills and verifies a large heap after reading
// its arguments, and prints how many there were.
package main

import (
	"fmt"
	"os"
)

func main() {
	pad := make([]byte, 64<<20)
	for i := range pad {
		pad[i] = byte(i*7 + 3)
	}
	runes := 0
	for _, a := range os.Args {
		runes += len(a)
		for _, c := range a {
			if c == 0 {
				fmt.Println("argument holds a zero byte")
				os.Exit(1)
			}
		}
	}
	bad := 0
	for i := range pad {
		if pad[i] != byte(i*7+3) {
			bad++
		}
	}
	fmt.Printf("args=%d bytes=%d environ=%d padbad=%d\n", len(os.Args), runes, len(os.Environ()), bad)
	if bad > 0 {
		os.Exit(1)
	}
}
