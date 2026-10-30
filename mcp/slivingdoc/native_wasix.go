//go:build wasix || git2helper

package git2

// The wasix Go port has no cgo, so on wasix this package runs libgit2 in a helper process,
// slivingdoc-git2 (helper.c beside this file in clai-in-wasmer-sh-poc), and calls it over its
// stdin and stdout. The helper is the same pinned libgit2 compiled to WASI; the seam functions
// below are native.go's, one request each.

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"github.com/baalimago/slivingdoc/internal/git"
)

const helperProgram = "slivingdoc-git2"

const (
	opInit byte = iota + 1
	opShutdown
	opVersion
	opFeatures
	opCreateRepo
	opOpenRepo
	opRepoODB
	opFree
	opODBWrite
	opODBRead
	opODBExists
	opWriteTree
	opReadTree
	opCreateCommit
	opReadCommit
	opMergeTrees
	opMergeFile
	opWritePack
	opImportPack
	opRepoPath
)

// libgit2's GIT_ENOTFOUND.
const errNotFound = -3

var (
	initFn         = func() int32 { return helperInit() }
	shutdownFn     = func() int32 { return helperShutdown() }
	versionFn      = libgit2Version
	featuresFn     = libgit2Features
	errorLastFn    = libgit2ErrorLast
	createRepoFn   = libgit2CreateRepo
	openRepoFn     = libgit2OpenRepo
	repoODBFn      = libgit2RepoODB
	odbWriteFn     = libgit2ODBWrite
	odbReadFn      = libgit2ODBRead
	odbExistsFn    = libgit2ODBExists
	writeTreeFn    = libgit2WriteTree
	readTreeFn     = libgit2ReadTree
	createCommitFn = libgit2CreateCommit
	readCommitFn   = libgit2ReadCommit
	mergeTreesFn   = libgit2MergeTrees
	mergeFileFn    = libgit2MergeFile
	writePackFn    = libgit2WritePack
	importPackFn   = libgit2ImportPack
	markShallowFn  = libgit2MarkShallow
)

// helperError is a failed request: libgit2's return code, error class and message, or a
// broken helper (rc 0, class 0).
type helperError struct {
	rc      int
	class   int
	message string
}

type helperProcess struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	out  *bufio.Reader
	last helperError
	refs int
}

// The helper mirrors libgit2's process-wide state: one per slivingdoc process, started by
// the first init and stopped by the last shutdown.
var (
	helperMu sync.Mutex
	helper   *helperProcess
)

func startHelper() (*helperProcess, error) {
	cmd := exec.Command(helperProgram)
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", helperProgram, err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", helperProgram, err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", helperProgram, err)
	}
	return &helperProcess{cmd: cmd, in: in, out: bufio.NewReader(out)}, nil
}

func (h *helperProcess) stop() error {
	h.in.Close()
	return h.cmd.Wait()
}

// call sends one request and returns the response's results, or the helper's error.
func call(op byte, args *encoder) (*decoder, error) {
	helperMu.Lock()
	defer helperMu.Unlock()
	if helper == nil {
		return nil, &git.NativeError{Op: "libgit2", Message: "libgit2 is not initialized"}
	}
	return helper.call(op, args)
}

func (h *helperProcess) call(op byte, args *encoder) (*decoder, error) {
	body := append([]byte{op}, args.buf...)
	msg := binary.LittleEndian.AppendUint32(nil, uint32(len(body)))
	if _, err := h.in.Write(append(msg, body...)); err != nil {
		return nil, h.broken(fmt.Errorf("send request: %w", err))
	}
	var size [4]byte
	if _, err := io.ReadFull(h.out, size[:]); err != nil {
		return nil, h.broken(fmt.Errorf("read response: %w", err))
	}
	resp := make([]byte, binary.LittleEndian.Uint32(size[:]))
	if _, err := io.ReadFull(h.out, resp); err != nil {
		return nil, h.broken(fmt.Errorf("read response: %w", err))
	}
	d := &decoder{buf: resp}
	if d.u8() == 0 {
		return d, d.err
	}
	h.last = helperError{rc: int(int32(d.u32())), class: int(int32(d.u32())), message: string(d.bytes())}
	if d.err != nil {
		return nil, h.broken(d.err)
	}
	return nil, h.last
}

func (h *helperProcess) broken(err error) error {
	h.last = helperError{message: fmt.Sprintf("%s: %v", helperProgram, err)}
	return h.last
}

func (e helperError) Error() string { return e.message }

func helperInit() int32 {
	helperMu.Lock()
	defer helperMu.Unlock()
	if helper == nil {
		h, err := startHelper()
		if err != nil {
			fmt.Fprintf(os.Stderr, "slivingdoc: %v\n", err)
			return -1
		}
		helper = h
	}
	d, err := helper.call(opInit, &encoder{})
	if err != nil {
		return -1
	}
	helper.refs++
	return int32(d.u32())
}

func helperShutdown() int32 {
	helperMu.Lock()
	defer helperMu.Unlock()
	if helper == nil {
		return -1
	}
	d, err := helper.call(opShutdown, &encoder{})
	if err != nil {
		return -1
	}
	rc := int32(d.u32())
	if helper.refs--; helper.refs == 0 {
		helper.stop()
		helper = nil
	}
	return rc
}

type repoHandle struct{ id uint32 }

func (h *repoHandle) free() { freeHandle(h.id) }

type odbHandle struct{ id uint32 }

func (h *odbHandle) free() { freeHandle(h.id) }

func freeHandle(id uint32) {
	call(opFree, new(encoder).u32(id))
}

func libgit2Version() (major, minor, rev int) {
	d, err := call(opVersion, &encoder{})
	if err != nil {
		return 0, 0, 0
	}
	return int(d.u32()), int(d.u32()), int(d.u32())
}

func libgit2Features() int {
	d, err := call(opFeatures, &encoder{})
	if err != nil {
		return 0
	}
	return int(d.u32())
}

func libgit2ErrorLast() (class int, message string) {
	helperMu.Lock()
	defer helperMu.Unlock()
	if helper == nil {
		return 0, ""
	}
	return helper.last.class, helper.last.message
}

func libgit2CreateRepo(path string, bare bool) (*repoHandle, error) {
	flag := byte(0)
	if bare {
		flag = 1
	}
	d, err := call(opCreateRepo, new(encoder).str(path).u8(flag))
	if err != nil {
		return nil, nativeError("create repository")
	}
	return &repoHandle{id: d.u32()}, d.err
}

func libgit2OpenRepo(path string) (*repoHandle, error) {
	d, err := call(opOpenRepo, new(encoder).str(path))
	if err != nil {
		return nil, nativeError("open repository")
	}
	return &repoHandle{id: d.u32()}, d.err
}

func libgit2RepoODB(repo *repoHandle) (*odbHandle, error) {
	d, err := call(opRepoODB, new(encoder).u32(repo.id))
	if err != nil {
		return nil, nativeError("open object database")
	}
	return &odbHandle{id: d.u32()}, d.err
}

func libgit2ODBWrite(odb *odbHandle, data []byte) (git.OID, error) {
	d, err := call(opODBWrite, new(encoder).u32(odb.id).bytes(data))
	if err != nil {
		return git.OID{}, nativeError("write blob")
	}
	return d.oid(), d.err
}

func libgit2ODBRead(odb *odbHandle, id git.OID) ([]byte, error) {
	d, err := call(opODBRead, new(encoder).u32(odb.id).oid(id))
	if err != nil {
		return nil, nativeLookupError("read blob", err)
	}
	return bytes.Clone(d.bytes()), d.err
}

func libgit2ODBExists(odb *odbHandle, id git.OID) bool {
	d, err := call(opODBExists, new(encoder).u32(odb.id).oid(id))
	return err == nil && d.u8() == 1
}

func libgit2WriteTree(repo *repoHandle, entries []git.TreeEntry) (git.OID, error) {
	args := new(encoder).u32(repo.id).u32(uint32(len(entries)))
	for _, e := range entries {
		switch e.Mode {
		case git.ModeBlob, git.ModeTree:
		default:
			return git.OID{}, &git.NativeError{
				Op:      "write tree",
				Message: fmt.Sprintf("unsupported file mode %o for %q", e.Mode, e.Name),
			}
		}
		args.str(e.Name).u32(uint32(e.Mode)).oid(e.ID)
	}
	d, err := call(opWriteTree, args)
	if err != nil {
		return git.OID{}, nativeError("write tree")
	}
	return d.oid(), d.err
}

func libgit2ReadTree(repo *repoHandle, id git.OID) ([]git.TreeEntry, error) {
	d, err := call(opReadTree, new(encoder).u32(repo.id).oid(id))
	if err != nil {
		return nil, nativeLookupError("lookup tree", err)
	}
	count := d.u32()
	entries := make([]git.TreeEntry, 0, min(count, 1<<16))
	for i := uint32(0); i < count && d.err == nil; i++ {
		entries = append(entries, git.TreeEntry{Name: string(d.bytes()), Mode: git.FileMode(d.u32()), ID: d.oid()})
	}
	return entries, d.err
}

func libgit2CreateCommit(repo *repoHandle, spec git.CommitSpec) (git.OID, error) {
	args := new(encoder).u32(repo.id).oid(spec.Tree).u64(uint64(spec.Time.Unix())).str(spec.Message).u32(uint32(len(spec.Parents)))
	for _, p := range spec.Parents {
		args.oid(p)
	}
	d, err := call(opCreateCommit, args)
	if err != nil {
		return git.OID{}, nativeLookupError("create commit", err)
	}
	return d.oid(), d.err
}

func libgit2ReadCommit(repo *repoHandle, id git.OID) (git.Commit, error) {
	d, err := call(opReadCommit, new(encoder).u32(repo.id).oid(id))
	if err != nil {
		return git.Commit{}, nativeLookupError("lookup commit", err)
	}
	c := git.Commit{Tree: d.oid()}
	count := d.u32()
	c.Parents = make([]git.OID, 0, min(count, 1<<16))
	for i := uint32(0); i < count && d.err == nil; i++ {
		c.Parents = append(c.Parents, d.oid())
	}
	c.Message = string(d.bytes())
	return c, d.err
}

func libgit2MergeTrees(repo *repoHandle, base, local, remote git.OID) (git.MergeIndex, error) {
	d, err := call(opMergeTrees, new(encoder).u32(repo.id).oid(base).oid(local).oid(remote))
	if err != nil {
		return git.MergeIndex{}, nativeLookupError("merge trees", err)
	}
	merged := git.MergeIndex{}
	count := d.u32()
	for i := uint32(0); i < count && d.err == nil; i++ {
		merged.Entries = append(merged.Entries, git.IndexEntry{
			Path:  string(d.bytes()),
			Mode:  git.FileMode(d.u32()),
			ID:    d.oid(),
			Stage: int(d.u32()),
		})
	}
	if d.u8() == 1 {
		merged.Tree = d.oid()
	}
	return merged, d.err
}

func libgit2MergeFile(base, local, remote []byte) (git.MergeFileResult, error) {
	args := new(encoder)
	for _, side := range [][]byte{base, local, remote} {
		present := byte(0)
		if side != nil {
			present = 1
		}
		args.u8(present).bytes(side)
	}
	d, err := call(opMergeFile, args)
	if err != nil {
		return git.MergeFileResult{}, nativeError("merge file")
	}
	out := git.MergeFileResult{Automergeable: d.u8() == 1}
	if content := d.bytes(); len(content) > 0 {
		out.Content = bytes.Clone(content)
	}
	return out, d.err
}

func libgit2WritePack(repo *repoHandle, objects []git.OID, w io.Writer) (int, error) {
	args := new(encoder).u32(repo.id).u32(uint32(len(objects)))
	for _, oid := range objects {
		args.oid(oid)
	}
	d, err := call(opWritePack, args)
	if err != nil {
		return 0, nativeError("write pack")
	}
	count, pack := int(d.u32()), d.bytes()
	if d.err != nil {
		return 0, d.err
	}
	if _, err := w.Write(pack); err != nil {
		return 0, fmt.Errorf("write pack bytes: %w", err)
	}
	return count, nil
}

func libgit2ImportPack(odb *odbHandle, data []byte) error {
	if _, err := call(opImportPack, new(encoder).u32(odb.id).bytes(data)); err != nil {
		return nativeError("import pack")
	}
	return nil
}

func libgit2RepoPath(repo *repoHandle) (string, error) {
	d, err := call(opRepoPath, new(encoder).u32(repo.id))
	if err != nil {
		return "", nativeError("repository path")
	}
	path := string(d.bytes())
	if d.err == nil && path == "" {
		return "", &git.NativeError{Op: "repository path", Message: "repository has no git directory"}
	}
	return path, d.err
}

type shallowRecord uint8

const (
	shallowUnchanged shallowRecord = iota
	shallowRecorded
)

func libgit2MarkShallow(repo *repoHandle, oid git.OID) (shallowRecord, error) {
	dir, err := libgit2RepoPath(repo)
	if err != nil {
		return shallowUnchanged, fmt.Errorf("locate git directory: %w", err)
	}
	path := filepath.Join(dir, "shallow")
	line := oid.String() + "\n"

	switch existing, err := os.ReadFile(path); {
	case err == nil:
		if bytes.Contains(existing, []byte(line)) {
			return shallowUnchanged, nil
		}
	case !errors.Is(err, fs.ErrNotExist):
		return shallowUnchanged, fmt.Errorf("read shallow file: %w", err)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return shallowUnchanged, fmt.Errorf("open shallow file: %w", err)
	}
	if _, err := f.WriteString(line); err != nil {
		f.Close()
		return shallowUnchanged, fmt.Errorf("write shallow file: %w", err)
	}
	if err := f.Close(); err != nil {
		return shallowUnchanged, fmt.Errorf("close shallow file: %w", err)
	}
	return shallowRecorded, nil
}

func readShallowBoundaries(repo *repoHandle) (map[git.OID]struct{}, error) {
	dir, err := libgit2RepoPath(repo)
	if err != nil {
		return nil, fmt.Errorf("locate git directory: %w", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "shallow"))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return map[git.OID]struct{}{}, nil
		}
		return nil, fmt.Errorf("read shallow file: %w", err)
	}
	set := map[git.OID]struct{}{}
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		id, err := git.ParseOID(string(line))
		if err != nil {
			return nil, fmt.Errorf("shallow file: %w", err)
		}
		set[id] = struct{}{}
	}
	return set, nil
}

func nativeLookupError(op string, err error) error {
	native := nativeError(op)
	var h helperError
	if errors.As(err, &h) && h.rc == errNotFound {
		return fmt.Errorf("%w: %w", git.ErrObjectMissing, native)
	}
	return native
}

func nativeError(op string) error {
	class, message := errorLastFn()
	return &git.NativeError{Op: op, Class: class, Message: message}
}

type encoder struct{ buf []byte }

func (e *encoder) u8(v byte) *encoder { e.buf = append(e.buf, v); return e }

func (e *encoder) u32(v uint32) *encoder {
	e.buf = binary.LittleEndian.AppendUint32(e.buf, v)
	return e
}

func (e *encoder) u64(v uint64) *encoder {
	e.buf = binary.LittleEndian.AppendUint64(e.buf, v)
	return e
}

func (e *encoder) bytes(b []byte) *encoder {
	e.u32(uint32(len(b)))
	e.buf = append(e.buf, b...)
	return e
}

func (e *encoder) str(s string) *encoder { return e.bytes([]byte(s)) }

func (e *encoder) oid(id git.OID) *encoder { e.buf = append(e.buf, id[:]...); return e }

// decoder reads a response; a read past its end sets err and yields zero values.
type decoder struct {
	buf []byte
	err error
}

func (d *decoder) take(n int) []byte {
	if d.err != nil || len(d.buf) < n {
		if d.err == nil {
			d.err = &git.NativeError{Op: "libgit2", Message: helperProgram + ": truncated response"}
		}
		return make([]byte, n)
	}
	p := d.buf[:n]
	d.buf = d.buf[n:]
	return p
}

func (d *decoder) u8() byte { return d.take(1)[0] }

func (d *decoder) u32() uint32 { return binary.LittleEndian.Uint32(d.take(4)) }

func (d *decoder) bytes() []byte {
	n := d.u32()
	if uint64(n) > uint64(len(d.buf)) {
		return d.take(len(d.buf) + 1)[:0]
	}
	return d.take(int(n))
}

func (d *decoder) oid() git.OID { return git.OID(d.take(len(git.OID{}))) }
