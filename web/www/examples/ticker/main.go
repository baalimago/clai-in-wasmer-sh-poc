// Goroutines on one thread: the kernel schedules them, so the order of the lines below varies.
package main

import (
	"fmt"
	"sync"
	"time"
)

func main() {
	var wg sync.WaitGroup
	for i := 1; i <= 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			time.Sleep(time.Duration(i) * 100 * time.Millisecond)
			fmt.Println("goroutine", i)
		}()
	}
	wg.Wait()
	fmt.Println("all done")
}