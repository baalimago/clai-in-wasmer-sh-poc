package mcpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestCallResults(t *testing.T) {
	s := &Server{Name: "t", Version: "1", Tools: []Tool{
		{Name: "ok", InputSchema: map[string]any{"type": "object"}, Call: func(context.Context, json.RawMessage) (Result, error) {
			r := Text("fine")
			r.Structured = map[string]any{"content": "fine"}
			return r, nil
		}},
		{Name: "fails", InputSchema: map[string]any{"type": "object"}, Call: func(context.Context, json.RawMessage) (Result, error) {
			return Result{}, errors.New("broken")
		}},
		{Name: "args", InputSchema: map[string]any{"type": "object"}, Call: TextFunc(func(_ context.Context, raw json.RawMessage) (string, error) {
			return string(raw), nil
		})},
	}}
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ok"}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fails"}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"args","arguments":null}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"missing"}}`,
		`{"jsonrpc":"2.0","id":5,"method":"ping"}`,
		`not json`,
	}, "\n") + "\n"
	var out bytes.Buffer
	if err := s.Serve(context.Background(), strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{
		`"id":1,"result":{"content":[{"text":"fine","type":"text"}],"isError":false,"structuredContent":{"content":"fine"}}`,
		`"id":2,"result":{"content":[{"text":"broken","type":"text"}],"isError":true}`,
		`"id":3,"result":{"content":[{"text":"{}","type":"text"}],"isError":false}`,
		`"id":4,"error":{"code":-32602,"message":"Unknown tool: missing"}`,
		`"id":5,"result":{}`,
		`"id":null,"error":{"code":-32700`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s in\n%s", want, got)
		}
	}
	s.ErrorText = func(tool string, err error) string { return tool + ": " + err.Error() }
	out.Reset()
	if err := s.Serve(context.Background(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fails"}}`+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), `"text":"fails: broken"`) {
		t.Errorf("ErrorText: %s", out.String())
	}
}
