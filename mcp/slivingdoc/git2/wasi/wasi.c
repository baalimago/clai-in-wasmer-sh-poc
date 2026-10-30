/* The calls the compat headers declare, failing as a host without them would. */
#include <errno.h>
#include <netdb.h>
#include <pwd.h>
#include <signal.h>
#include <sys/wait.h>

int sigaction(int sig, const struct sigaction *act, struct sigaction *old) {
	(void)sig;
	(void)act;
	if (old)
		old->sa_handler = SIG_DFL;
	return 0;
}

int getpwuid_r(uid_t uid, struct passwd *pw, char *buf, size_t len, struct passwd **out) {
	(void)uid;
	(void)pw;
	(void)buf;
	(void)len;
	*out = 0;
	return ENOENT;
}

uid_t getuid(void) { return 0; }
uid_t geteuid(void) { return 0; }
gid_t getgid(void) { return 0; }

/* libgit2 seeds its random numbers with these, among others. */
pid_t getppid(void) { return 1; }
pid_t getpgid(pid_t pid) { return pid; }
pid_t getsid(pid_t pid) { return pid; }

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
	(void)node;
	(void)service;
	(void)hints;
	*res = 0;
	return EAI_FAIL;
}

void freeaddrinfo(struct addrinfo *ai) { (void)ai; }

const char *gai_strerror(int code) {
	(void)code;
	return "name resolution is not available";
}

static int nosys(void) {
	errno = ENOSYS;
	return -1;
}

pid_t waitpid(pid_t pid, int *status, int options) {
	(void)pid;
	(void)status;
	(void)options;
	return nosys();
}

pid_t fork(void) { return nosys(); }

int execve(const char *path, char *const argv[], char *const envp[]) {
	(void)path;
	(void)argv;
	(void)envp;
	return nosys();
}

int dup2(int from, int to) {
	(void)from;
	(void)to;
	return nosys();
}

int pipe(int fds[2]) {
	(void)fds;
	return nosys();
}
