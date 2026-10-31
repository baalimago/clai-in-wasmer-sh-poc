// Command heap keeps many small objects alive, forces collections while it grows, and checks
// after each one that every object still holds its pattern. It reports the first object that
// changed and the heap size at that moment, which is how a heap that something corrupts shows
// itself without a compiler in the way.
package main

import (
	"fmt"
	"os"
	"runtime"
	"strconv"
)

type obj struct {
	index uint64
	data  [96]byte
}

func fill(o *obj) {
	for i := range o.data {
		o.data[i] = byte(o.index + uint64(i))
	}
}

func intact(o *obj) bool {
	for i := range o.data {
		if o.data[i] != byte(o.index+uint64(i)) {
			return false
		}
	}
	return true
}

func main() {
	want, _ := strconv.Atoi(os.Args[1])
	kept := make([]*obj, 0, 1<<20)
	for len(kept) < want {
		for i := 0; i < 4096 && len(kept) < want; i++ {
			o := &obj{index: uint64(len(kept))}
			fill(o)
			kept = append(kept, o)
		}
		runtime.GC()
		for i, o := range kept {
			if !intact(o) {
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				fmt.Printf("object %d of %d changed, heap=%dMB\n", i, len(kept), m.HeapAlloc>>20)
				os.Exit(1)
			}
		}
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("kept=%d heap=%dMB gc=%d ok\n", len(kept), m.HeapAlloc>>20, m.NumGC)
}
