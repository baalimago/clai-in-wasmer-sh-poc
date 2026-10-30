/* What libgit2's POSIX code names that wasi-libc leaves out, for code paths slivingdoc never
 * takes (network streams, child processes). Included before every libgit2 source. */
#ifndef SLIVINGDOC_WASI_COMPAT_H
#define SLIVINGDOC_WASI_COMPAT_H
#include <signal.h>
#ifndef SO_ERROR
#define SO_ERROR 4
#endif
#ifndef SO_KEEPALIVE
#define SO_KEEPALIVE 9
#endif
#ifndef POLLPRI
#define POLLPRI 0x002
#endif
struct sigaction {
	void (*sa_handler)(int);
	unsigned long sa_mask;
	int sa_flags;
};
int sigaction(int, const struct sigaction *, struct sigaction *);
#define sigemptyset(set) (*(set) = 0, 0)
#endif
