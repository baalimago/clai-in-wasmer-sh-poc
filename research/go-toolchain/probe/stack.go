// Command stack recurses with a large frame so that the goroutine's stack has to grow many
// times, writes a pattern into each frame, makes a syscall, and checks the pattern after the
// stack has been copied. A stack copy that misses bytes shows up as a frame that changed.
package main

import (
	"fmt"
	"os"
	"strconv"
)

var devNull *os.File

func rec(depth, max int) int {
	var frame [2048]uint64
	for i := range frame {
		frame[i] = uint64(depth)*0x100000001 + uint64(i)
	}
	n := depth
	if depth < max {
		n = rec(depth+1, max)
	}
	if _, err := devNull.Write([]byte("x")); err != nil {
		fmt.Println("write", depth, err)
		os.Exit(1)
	}
	for i, v := range frame {
		if v != uint64(depth)*0x100000001+uint64(i) {
			fmt.Printf("frame %d slot %d is %#x\n", depth, i, v)
			os.Exit(1)
		}
	}
	return n + 1
}

func main() {
	max, _ := strconv.Atoi(os.Args[1])
	f, err := os.OpenFile("/dev/null", os.O_WRONLY, 0)
	if err != nil {
		fmt.Println("open", err)
		os.Exit(1)
	}
	devNull = f
	fmt.Printf("depth=%d frames=%d\n", max, rec(0, max))
}
