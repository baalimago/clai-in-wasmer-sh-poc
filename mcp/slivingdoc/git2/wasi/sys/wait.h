/* WASI preview 1 starts no processes: fork and waitpid fail with ENOSYS (wasi.c). */
#ifndef SLIVINGDOC_WASI_SYS_WAIT_H
#define SLIVINGDOC_WASI_SYS_WAIT_H
#include <sys/types.h>
#define WNOHANG 1
#define WIFEXITED(s) (((s) & 0x7f) == 0)
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WIFSIGNALED(s) (((s) & 0x7f) != 0 && ((s) & 0x7f) != 0x7f)
#define WTERMSIG(s) ((s) & 0x7f)
pid_t waitpid(pid_t, int *, int);
pid_t fork(void);
int execve(const char *, char *const[], char *const[]);
int dup2(int, int);
int pipe(int[2]);
#endif
