// Command churn allocates, retains and drops objects from several goroutines and checks that
// what it retains still holds the bytes it wrote, so that a heap that something scribbles over
// reports the first object that changed.
package main

import (
	"fmt"
	"os"
	"runtime"
	"sync"
	"time"
)

type block struct {
	tag  byte
	data []byte
}

func fill(b *block, n int) {
	b.data = make([]byte, n)
	for i := range b.data {
		b.data[i] = b.tag
	}
}

func intact(b *block) bool {
	for _, v := range b.data {
		if v != b.tag {
			return false
		}
	}
	return true
}

func main() {
	rounds := 200
	var wg sync.WaitGroup
	var mu sync.Mutex
	var kept []*block
	broken := 0

	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			local := make([]*block, 0, 256)
			for r := 0; r < rounds; r++ {
				b := &block{tag: byte('a' + w)}
				fill(b, 1<<uint(r%12))
				local = append(local, b)
				if len(local) > 64 {
					local = local[1:]
				}
				if r%32 == 0 {
					runtime.GC()
				}
			}
			mu.Lock()
			kept = append(kept, local...)
			mu.Unlock()
		}(w)
	}
	wg.Wait()

	for _, b := range kept {
		if !intact(b) {
			broken++
		}
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	fmt.Printf("rounds=%d kept=%d broken=%d heap=%dMB gc=%d\n",
		rounds, len(kept), broken, m.HeapAlloc>>20, m.NumGC)
	if broken > 0 {
		os.Exit(1)
	}
	_ = time.Now
}
