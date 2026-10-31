// Command mmap maps anonymous memory, fills it, then allocates a large heap slice and reports
// whether the mapping's addresses and the heap's overlap, and whether the mapping still holds
// its pattern. A kernel whose mmap hands out pages from the region the Go runtime's sbrk owns
// shows the heap at the same addresses as the mapping.
package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

func main() {
	const size = 8 << 20
	b, err := syscall.Mmap(-1, 0, size, syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_PRIVATE|syscall.MAP_ANON)
	if err != nil {
		fmt.Println("mmap", err)
		os.Exit(1)
	}
	for i := range b {
		b[i] = byte(i*13 + 5)
	}
	start := uintptr(unsafe.Pointer(&b[0]))

	h := make([]byte, 64<<20)
	for i := range h {
		h[i] = byte(i)
	}
	heap := uintptr(unsafe.Pointer(&h[0]))

	changed := 0
	for i := range b {
		if b[i] != byte(i*13+5) {
			changed++
		}
	}
	overlap := heap < start+size && start < heap+uintptr(len(h))
	fmt.Printf("mapping=[%#x,%#x) heap=[%#x,%#x) overlap=%v changed=%d\n",
		start, start+size, heap, heap+uintptr(len(h)), overlap, changed)
	if changed > 0 || overlap {
		os.Exit(1)
	}
}
