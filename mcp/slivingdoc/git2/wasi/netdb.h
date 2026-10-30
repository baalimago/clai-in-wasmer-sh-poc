/* WASI preview 1 resolves no names: getaddrinfo fails (wasi.c). libgit2 needs it only for
 * network transports, which slivingdoc never uses. */
#ifndef SLIVINGDOC_WASI_NETDB_H
#define SLIVINGDOC_WASI_NETDB_H
#include <sys/socket.h>
struct addrinfo {
	int ai_flags;
	int ai_family;
	int ai_socktype;
	int ai_protocol;
	socklen_t ai_addrlen;
	struct sockaddr *ai_addr;
	char *ai_canonname;
	struct addrinfo *ai_next;
};
#define EAI_FAIL (-4)
int getaddrinfo(const char *, const char *, const struct addrinfo *, struct addrinfo **);
void freeaddrinfo(struct addrinfo *);
const char *gai_strerror(int);
#endif
