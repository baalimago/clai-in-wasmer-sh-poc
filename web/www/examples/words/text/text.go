// Package text is the module's own package, one directory under main: go test ./... runs it.
package text

import "strings"

// Up shouts.
func Up(s string) string { return strings.ToUpper(s) }

// Title gives every word a capital first letter.
func Title(s string) string {
	fields := strings.Fields(s)
	for i, field := range fields {
		fields[i] = strings.ToUpper(field[:1]) + field[1:]
	}
	return strings.Join(fields, " ")
}