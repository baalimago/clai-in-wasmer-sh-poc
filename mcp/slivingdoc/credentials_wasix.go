//go:build unix

package credentials

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// In place of platform_unix.go: the machine in a browser tab has one user, and the page puts a
// login the browser kept back into the credentials file with bash, a WASIX v1 program, which
// cannot set a file's mode (WASI has no umask or chmod), so the file is 0644. Load checks no
// owners or permission bits here, as on a platform without them; it still opens the file
// without following a final symbolic link.
const openFlags = os.O_RDONLY | unix.O_NOFOLLOW | unix.O_NONBLOCK

const hasOwners = false

var errNoOwners = errors.New("the machine checks no file owners")

func fileOwner(*os.File) (int, error) { return 0, errNoOwners }

func pathOwner(string) (int, error) { return 0, errNoOwners }
