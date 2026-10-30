/* What WASI preview 1 lacks that ffmpeg's audio tools call. */
#ifndef WASI_COMPAT_H
#define WASI_COMPAT_H
#include <stdio.h>
#include <unistd.h>
/* No dup: the pipe protocol's descriptors are used as they are. */
static inline int dup(int fd) { return fd; }
/* No temporary file names: only two-pass encoding logs want them. */
static inline char *tempnam(const char *dir, const char *prefix) { (void)dir; (void)prefix; return NULL; }
#endif
