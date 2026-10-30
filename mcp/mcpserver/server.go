// Package mcpserver is the MCP stdio server the browser machine's MCP ports share: JSON-RPC
// over newline-delimited messages, initialize, ping, tools/list and tools/call.
package mcpserver

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// ProtocolVersions are the MCP revisions this server speaks, newest first. A client asking for
// another gets the newest, as the specification says.
var ProtocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

const (
	codeParse          = -32700
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
)

// Tool is one MCP tool: its listing and what a call runs. An error from Call is the tool's
// failure, which the client sees as a result with isError set.
type Tool struct {
	Name         string         `json:"name"`
	Title        string         `json:"title,omitempty"`
	Description  string         `json:"description"`
	InputSchema  map[string]any `json:"inputSchema"`
	OutputSchema map[string]any `json:"outputSchema,omitempty"`
	Annotations  map[string]any `json:"annotations,omitempty"`
	Call         func(ctx context.Context, args json.RawMessage) (Result, error) `json:"-"`
}

// Result is what a tool call returns: its content blocks and, for a tool with an output
// schema, the structured content.
type Result struct {
	Content    []any
	Structured any
}

// Text is a result of one text block.
func Text(text string) Result {
	return Result{Content: []any{map[string]any{"type": "text", "text": text}}}
}

// TextFunc adapts a tool whose result is plain text.
func TextFunc(call func(ctx context.Context, args json.RawMessage) (string, error)) func(context.Context, json.RawMessage) (Result, error) {
	return func(ctx context.Context, args json.RawMessage) (Result, error) {
		text, err := call(ctx, args)
		return Text(text), err
	}
}

type Server struct {
	Name, Version string
	Tools         []Tool
	// ErrorText is the text a failed call returns; the default is the error's message.
	ErrorText func(tool string, err error) string
}

// Serve answers the requests read from in, one JSON-RPC message per line, on out, until in
// ends. Tool calls run concurrently, as a client may have several outstanding.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	var mu sync.Mutex
	write := func(r response) error {
		line, err := json.Marshal(r)
		if err != nil {
			return fmt.Errorf("encode response: %w", err)
		}
		mu.Lock()
		defer mu.Unlock()
		if _, err := out.Write(append(line, '\n')); err != nil {
			return fmt.Errorf("write response: %w", err)
		}
		return nil
	}
	var wg sync.WaitGroup
	errs := make(chan error, 1)
	report := func(err error) {
		select {
		case errs <- err:
		default:
		}
	}
	defer wg.Wait()

	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		select {
		case err := <-errs:
			return err
		default:
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			if err := write(response{JSONRPC: "2.0", ID: json.RawMessage("null"), Error: &rpcError{codeParse, err.Error()}}); err != nil {
				return err
			}
			continue
		}
		if len(req.ID) == 0 {
			// A notification (initialized, cancelled) wants no answer.
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, rerr := s.handle(ctx, req)
			if err := write(response{JSONRPC: "2.0", ID: req.ID, Result: result, Error: rerr}); err != nil {
				report(err)
			}
		}()
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read requests: %w", err)
	}
	return nil
}

func (s *Server) handle(ctx context.Context, req request) (any, *rpcError) {
	switch req.Method {
	case "initialize":
		var params struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &params); err != nil {
				return nil, &rpcError{codeInvalidParams, err.Error()}
			}
		}
		return map[string]any{
			"protocolVersion": negotiate(params.ProtocolVersion),
			"capabilities":    map[string]any{"tools": map[string]any{"listChanged": false}},
			"serverInfo":      map[string]any{"name": s.Name, "version": s.Version},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": s.Tools}, nil
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &rpcError{codeInvalidParams, err.Error()}
		}
		for _, t := range s.Tools {
			if t.Name != params.Name {
				continue
			}
			args := params.Arguments
			if len(args) == 0 || string(args) == "null" {
				args = json.RawMessage("{}")
			}
			result, err := t.Call(ctx, args)
			if err != nil {
				return encode(Text(s.errorText(t.Name, err)), true), nil
			}
			return encode(result, false), nil
		}
		return nil, &rpcError{codeInvalidParams, fmt.Sprintf("Unknown tool: %s", params.Name)}
	default:
		return nil, &rpcError{codeMethodNotFound, fmt.Sprintf("Method not found: %s", req.Method)}
	}
}

func (s *Server) errorText(tool string, err error) string {
	if s.ErrorText != nil {
		return s.ErrorText(tool, err)
	}
	return err.Error()
}

func negotiate(asked string) string {
	for _, v := range ProtocolVersions {
		if v == asked {
			return v
		}
	}
	return ProtocolVersions[0]
}

func encode(r Result, isError bool) map[string]any {
	out := map[string]any{"content": r.Content, "isError": isError}
	if r.Structured != nil {
		out["structuredContent"] = r.Structured
	}
	return out
}

// DecodeArguments decodes a call's arguments into v.
func DecodeArguments(args json.RawMessage, v any) error {
	if err := json.Unmarshal(args, v); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}
