package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// The MCP revisions this server speaks, newest first. A client asking for another gets the
// newest, as the specification says.
var protocolVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

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

// tool is one MCP tool: its listing and what a call runs. A call's text is its result; an
// error is a protocol error, for arguments the tool cannot take.
type tool struct {
	Name        string         `json:"name"`
	Title       string         `json:"title,omitempty"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	call        func(ctx context.Context, args json.RawMessage) (string, error)
}

type server struct {
	name, version string
	tools         []tool
}

// serve answers the requests read from in, one JSON-RPC message per line, on out, until in
// ends. Tool calls run concurrently, as a client may have several outstanding.
func (s *server) serve(ctx context.Context, in io.Reader, out io.Writer) error {
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

func (s *server) handle(ctx context.Context, req request) (any, *rpcError) {
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
			"serverInfo":      map[string]any{"name": s.name, "version": s.version},
		}, nil
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": s.tools}, nil
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return nil, &rpcError{codeInvalidParams, err.Error()}
		}
		for _, t := range s.tools {
			if t.Name != params.Name {
				continue
			}
			args := params.Arguments
			if len(args) == 0 || string(args) == "null" {
				args = json.RawMessage("{}")
			}
			text, err := t.call(ctx, args)
			if err != nil {
				return toolResult(fmt.Sprintf("Error executing tool %s: %v", t.Name, err), true), nil
			}
			return toolResult(text, false), nil
		}
		return nil, &rpcError{codeInvalidParams, fmt.Sprintf("Unknown tool: %s", params.Name)}
	default:
		return nil, &rpcError{codeMethodNotFound, fmt.Sprintf("Method not found: %s", req.Method)}
	}
}

func negotiate(asked string) string {
	for _, v := range protocolVersions {
		if v == asked {
			return v
		}
	}
	return protocolVersions[0]
}

func toolResult(text string, isError bool) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": isError,
	}
}

func decodeArguments(args json.RawMessage, v any) error {
	if err := json.Unmarshal(args, v); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}
