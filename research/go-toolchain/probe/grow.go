// Reports how far linear memory grows: 64 MiB slices, each page touched, kept.
package main

import (
	"fmt"
	"os"
)

func main() {
	const chunk = 64 << 20
	var keep [][]byte
	for i := 1; i <= 96; i++ {
		b := make([]byte, chunk)
		for j := 0; j < len(b); j += 4096 {
			b[j] = byte(i)
		}
		keep = append(keep, b)
		if i%8 == 0 {
			fmt.Printf("%d MiB\n", i*64)
			os.Stdout.Sync()
		}
	}
	fmt.Printf("done: %d MiB\n", len(keep)*64)
}
