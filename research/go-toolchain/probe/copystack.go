// Holds a map, a slice, a string and an interface in stack slots across many stack
// growths, and checks every one of them after the growths.
package main

import (
	"fmt"
	"os"
)

type big [4096]byte

type errStr string

func (e errStr) Error() string { return string(e) }

//go:noinline
func deep(n int, m map[int]int, s []int, str string, e error) int {
	var pad big
	pad[0] = 1
	pad[n%len(pad)] = byte(n)
	total := int(pad[0]) + int(pad[len(pad)-1])
	if n == 0 {
		for i := 0; i < 8; i++ {
			if m[i] != i*10 {
				fmt.Fprintln(os.Stderr, "map lost value", i, m[i])
				os.Exit(1)
			}
		}
		if len(s) != 8 || s[7] != 70 {
			fmt.Fprintln(os.Stderr, "slice lost", len(s))
			os.Exit(1)
		}
		if str != "0123456789abcdef" {
			fmt.Fprintln(os.Stderr, "string lost", str)
			os.Exit(1)
		}
		if e == nil || e.Error() != "boom" {
			fmt.Fprintln(os.Stderr, "interface lost")
			os.Exit(1)
		}
		return total
	}
	return deep(n-1, m, s, str, e) + total
}

func main() {
	m := map[int]int{}
	for i := 0; i < 8; i++ {
		m[i] = i * 10
	}
	s := make([]int, 8)
	for i := range s {
		s[i] = i * 10
	}
	for _, n := range []int{100, 1000, 5000, 20000} {
		if deep(n, m, s, "0123456789abcdef", errStr("boom")) == 0 {
			fmt.Fprintln(os.Stderr, "empty result at", n)
			os.Exit(1)
		}
		fmt.Println(n, "frames: every slot intact")
	}
}
