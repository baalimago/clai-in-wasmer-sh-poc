package main

import (
	"fmt"
	"os"
	"strings"

	"words/text"
)

func main() {
	line := "hello from the tab"
	if len(os.Args) > 1 {
		line = strings.Join(os.Args[1:], " ")
	}
	fmt.Println(text.Title(line))
}