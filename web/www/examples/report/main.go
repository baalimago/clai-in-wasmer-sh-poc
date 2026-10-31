// Imports three standard library packages, so the first build of this one is the slow one.
package main

import (
	"encoding/json"
	"fmt"
	"sort"
)

type meeting struct {
	Title    string   `json:"title"`
	Speakers []string `json:"speakers"`
}

func main() {
	const raw = `[{"title":"Design review","speakers":["Ada","Grace"]},
		{"title":"Standup","speakers":["Ada"]}]`
	var meetings []meeting
	if err := json.Unmarshal([]byte(raw), &meetings); err != nil {
		panic(err)
	}
	seen := map[string]bool{}
	for _, m := range meetings {
		for _, speaker := range m.Speakers {
			seen[speaker] = true
		}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	fmt.Printf("%d meetings, %d speakers: %v\n", len(meetings), len(names), names)
}