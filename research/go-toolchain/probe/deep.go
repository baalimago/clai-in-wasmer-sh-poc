// Command deep makes a syscall at the bottom of a deep recursive call and checks, on the way
// back up, that every frame's locals still hold what the frame wrote. A kernel that resumes a
// suspended wasm stack wrongly shows up as a frame whose locals changed.
package main

import (
	"fmt"
	"os"
	"strconv"
)

var devNull *os.File

func rec(depth, max int) int {
	var x [8]uint64
	for i := range x {
		x[i] = uint64(depth)*0x100000001 + uint64(i)
	}
	n := depth
	if depth < max {
		n = rec(depth+1, max)
	}
	// A syscall in every frame, on the way back up.
	if _, err := devNull.Write([]byte("x")); err != nil {
		fmt.Println("write", depth, err)
		os.Exit(1)
	}
	for i, v := range x {
		if v != uint64(depth)*0x100000001+uint64(i) {
			fmt.Printf("frame %d local %d is %#x\n", depth, i, v)
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
