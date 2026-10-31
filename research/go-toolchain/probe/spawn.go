// Command spawn runs cmd/asm on the runtime's assembly the way cmd/go does, from a Go parent
// process that then checks its own heap, so that a corruption tied to the kernel's spawn shows
// up separately from one tied to the assembler.
package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func main() {
	args := []string{
		"-p", "runtime", "-I", "/work/work/", "-I", "/go/pkg/include",
		"-D", "GOOS_wasix", "-D", "GOARCH_wasm", "-gensymabis",
		"-o", "/work/work/symabis",
		"./asm.s", "./asm_wasm.s", "./ints.s", "./memclr_wasm.s", "./memmove_wasm.s",
		"./preempt_wasm.s", "./rt0_wasix_wasm.s", "./sys_wasm.s",
	}
	cmd := exec.Command("/go/pkg/tool/wasix_wasm/asm", args...)
	cmd.Dir = "/go/src/runtime"
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	fmt.Printf("asm: err=%v output=%q\n", err, strings.TrimSpace(out.String()))

	pad := make([]byte, 64<<20)
	for i := range pad {
		pad[i] = byte(i*11 + 1)
	}
	bad := 0
	for i := range pad {
		if pad[i] != byte(i*11+1) {
			bad++
		}
	}
	fmt.Printf("parent pad bad=%d\n", bad)
	if bad > 0 {
		os.Exit(1)
	}
}
