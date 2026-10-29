//go:build !unix

package main

import "os"

func pollableStdin() (*os.File, error) { return os.Stdin, nil }
