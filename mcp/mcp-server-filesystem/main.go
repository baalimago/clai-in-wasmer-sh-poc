// A Go port of @modelcontextprotocol/server-filesystem 2.1.0
// (https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) for the browser
// machine, which has no Node.js: the same tools, arguments and output, confined to the
// directories named on the command line, over stdio. `npx -y @modelcontextprotocol/server-filesystem
// DIR...` starts it. The client's MCP Roots do not change the directories here.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/baalimago/clai-in-wasmer-sh-poc/mcp/mcpserver"
)

const version = "2.1.0"

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "Usage: mcp-server-filesystem [allowed-directory] [additional-directories...]")
		return errors.New("no allowed directories: this port takes them only from the command line")
	}
	dirs, err := allowedDirectories(args, stderr)
	if err != nil {
		return err
	}
	s := newServer(dirs)
	fmt.Fprintln(stderr, "Secure MCP Filesystem Server running on stdio")
	return s.Serve(context.Background(), stdin, stdout)
}

func newServer(dirs []string) *mcpserver.Server {
	return &mcpserver.Server{Name: "secure-filesystem-server", Version: version, Tools: tools(dirs)}
}
