package text

import "testing"

func TestTitle(t *testing.T) {
	if got := Title("hello from the tab"); got != "Hello From The Tab" {
		t.Fatalf("Title = %q", got)
	}
}