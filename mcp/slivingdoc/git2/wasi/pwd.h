/* WASI has no user database: lookups fail with ENOENT (wasi.c). */
#ifndef SLIVINGDOC_WASI_PWD_H
#define SLIVINGDOC_WASI_PWD_H
#include <sys/types.h>
struct passwd {
	char *pw_name;
	char *pw_passwd;
	uid_t pw_uid;
	gid_t pw_gid;
	char *pw_gecos;
	char *pw_dir;
	char *pw_shell;
};
int getpwuid_r(uid_t, struct passwd *, char *, size_t, struct passwd **);
uid_t getuid(void);
uid_t geteuid(void);
#endif
