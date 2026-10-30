/* slivingdoc-git2 runs slivingdoc's libgit2 operations for the wasix build of slivingdoc,
 * whose Go port has no cgo: the client in native_wasix.go starts it and sends it one request
 * at a time on stdin, and it answers each on stdout.
 *
 * A message is a little-endian u32 length and that many bytes. A request is an op byte and its
 * arguments; a response is a status byte, 0 with the results or 1 with the libgit2 return
 * code (i32), error class (i32) and message (bytes). Values are u8, u32, i64, an oid of 20
 * bytes, or bytes as a u32 length and the data. Repositories and object databases are handles,
 * u32 indices into this process's table. */
#include <git2.h>
#include <git2/sys/errors.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum op {
	OP_INIT = 1,
	OP_SHUTDOWN,
	OP_VERSION,
	OP_FEATURES,
	OP_CREATE_REPO,
	OP_OPEN_REPO,
	OP_REPO_ODB,
	OP_FREE,
	OP_ODB_WRITE,
	OP_ODB_READ,
	OP_ODB_EXISTS,
	OP_WRITE_TREE,
	OP_READ_TREE,
	OP_CREATE_COMMIT,
	OP_READ_COMMIT,
	OP_MERGE_TREES,
	OP_MERGE_FILE,
	OP_WRITE_PACK,
	OP_IMPORT_PACK,
	OP_REPO_PATH,
};

/* The fixed commit identity, as slivingdoc's internal/git declares it. */
#define AUTHOR_NAME "slivingdoc"
#define AUTHOR_EMAIL "slivingdoc@localhost"

typedef struct {
	unsigned char *data;
	size_t len, cap, pos;
	int bad; /* a read ran past the end */
} buf;

static void need(buf *b, size_t n) {
	if (b->len + n <= b->cap)
		return;
	size_t cap = b->cap ? b->cap : 256;
	while (cap < b->len + n)
		cap *= 2;
	b->data = realloc(b->data, cap);
	if (!b->data) {
		fputs("slivingdoc-git2: out of memory\n", stderr);
		exit(1);
	}
	b->cap = cap;
}

static void put(buf *b, const void *p, size_t n) {
	need(b, n);
	if (n)
		memcpy(b->data + b->len, p, n);
	b->len += n;
}

static void put_u8(buf *b, uint8_t v) { put(b, &v, 1); }

static void put_u32(buf *b, uint32_t v) {
	unsigned char le[4] = {v, v >> 8, v >> 16, v >> 24};
	put(b, le, 4);
}

static void put_bytes(buf *b, const void *p, size_t n) {
	put_u32(b, (uint32_t)n);
	put(b, p, n);
}

static void put_str(buf *b, const char *s) { put_bytes(b, s, s ? strlen(s) : 0); }

static void put_oid(buf *b, const git_oid *id) { put(b, id->id, 20); }

static const unsigned char *take(buf *b, size_t n) {
	if (b->bad || b->len - b->pos < n) {
		b->bad = 1;
		return NULL;
	}
	const unsigned char *p = b->data + b->pos;
	b->pos += n;
	return p;
}

static uint8_t get_u8(buf *b) {
	const unsigned char *p = take(b, 1);
	return p ? p[0] : 0;
}

static uint32_t get_u32(buf *b) {
	const unsigned char *p = take(b, 4);
	return p ? (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24 : 0;
}

static int64_t get_i64(buf *b) {
	uint64_t lo = get_u32(b);
	return (int64_t)(lo | (uint64_t)get_u32(b) << 32);
}

static const unsigned char *get_bytes(buf *b, size_t *n) {
	*n = get_u32(b);
	return take(b, *n);
}

/* get_str copies a string argument so that it ends in a NUL; the caller frees it. */
static char *get_str(buf *b) {
	size_t n;
	const unsigned char *p = get_bytes(b, &n);
	char *s = calloc(1, n + 1);
	if (p && s)
		memcpy(s, p, n);
	return s;
}

static void get_oid(buf *b, git_oid *id) {
	const unsigned char *p = take(b, 20);
	if (p)
		memcpy(id->id, p, 20);
	else
		memset(id->id, 0, 20);
}

static int read_full(int fd, void *p, size_t n) {
	unsigned char *c = p;
	while (n) {
		ssize_t r = read(fd, c, n);
		if (r <= 0)
			return -1;
		c += r;
		n -= (size_t)r;
	}
	return 0;
}

static int write_full(int fd, const void *p, size_t n) {
	const unsigned char *c = p;
	while (n) {
		ssize_t w = write(fd, c, n);
		if (w <= 0)
			return -1;
		c += w;
		n -= (size_t)w;
	}
	return 0;
}

enum kind { FREE_SLOT, REPO, ODB };

typedef struct {
	enum kind kind;
	void *ptr;
} handle;

static handle *handles;
static uint32_t nhandles;

static uint32_t add_handle(enum kind kind, void *ptr) {
	uint32_t i;
	for (i = 0; i < nhandles && handles[i].kind != FREE_SLOT; i++)
		;
	if (i == nhandles) {
		handles = realloc(handles, ++nhandles * sizeof *handles);
		if (!handles) {
			fputs("slivingdoc-git2: out of memory\n", stderr);
			exit(1);
		}
	}
	handles[i] = (handle){kind, ptr};
	return i;
}

static void *lookup_handle(uint32_t i, enum kind kind) {
	return i < nhandles && handles[i].kind == kind ? handles[i].ptr : NULL;
}

/* fail answers with libgit2's last error, or msg when there is none. */
static int fail(buf *out, int rc, const char *msg) {
	const git_error *e = git_error_last();
	out->len = 0;
	put_u8(out, 1);
	put_u32(out, (uint32_t)rc);
	put_u32(out, e ? (uint32_t)e->klass : 0);
	put_str(out, e && e->message && *e->message ? e->message : msg);
	return rc;
}

static int bad_handle(buf *out) {
	git_error_set_str(GIT_ERROR_INVALID, "unknown handle");
	return fail(out, GIT_EINVALID, "unknown handle");
}

static int create_commit(buf *in, buf *out, git_repository *repo) {
	git_oid tree_id, id;
	git_tree *tree = NULL;
	git_signature *sig = NULL;
	git_commit **parents = NULL;
	int rc;

	get_oid(in, &tree_id);
	int64_t when = get_i64(in);
	char *message = get_str(in);
	uint32_t n = get_u32(in);
	if (in->bad || n > in->len / 20) {
		free(message);
		return fail(out, GIT_EINVALID, "malformed request");
	}
	parents = calloc(n ? n : 1, sizeof *parents);
	if ((rc = git_tree_lookup(&tree, repo, &tree_id)) < 0) {
		fail(out, rc, "lookup commit tree");
		goto done;
	}
	if ((rc = git_signature_new(&sig, AUTHOR_NAME, AUTHOR_EMAIL, when, 0)) < 0) {
		fail(out, rc, "create signature");
		goto done;
	}
	for (uint32_t i = 0; i < n; i++) {
		git_oid pid;
		get_oid(in, &pid);
		if ((rc = git_commit_lookup(&parents[i], repo, &pid)) < 0) {
			fail(out, rc, "lookup parent commit");
			goto done;
		}
	}
	if ((rc = git_commit_create(&id, repo, NULL, sig, sig, NULL, message, tree, n, (const git_commit **)parents)) < 0) {
		fail(out, rc, "create commit");
		goto done;
	}
	put_oid(out, &id);
done:
	for (uint32_t i = 0; i < n; i++)
		git_commit_free(parents[i]);
	free(parents);
	git_signature_free(sig);
	git_tree_free(tree);
	free(message);
	return rc;
}

static int merge_trees(buf *in, buf *out, git_repository *repo) {
	git_oid ids[3];
	git_tree *trees[3] = {NULL, NULL, NULL};
	static const char *const what[3] = {"merge base tree", "merge local tree", "merge remote tree"};
	git_merge_options opts;
	git_index *idx = NULL;
	int rc = 0;

	for (int i = 0; i < 3; i++)
		get_oid(in, &ids[i]);
	for (int i = 0; i < 3; i++) {
		if ((rc = git_tree_lookup(&trees[i], repo, &ids[i])) < 0) {
			fail(out, rc, what[i]);
			goto done;
		}
	}
	if ((rc = git_merge_options_init(&opts, GIT_MERGE_OPTIONS_VERSION)) < 0) {
		fail(out, rc, "init merge options");
		goto done;
	}
	opts.flags = 0; /* no rename detection, no fail-on-conflict */
	if ((rc = git_merge_trees(&idx, repo, trees[0], trees[1], trees[2], &opts)) < 0) {
		fail(out, rc, "merge trees");
		goto done;
	}
	size_t count = git_index_entrycount(idx);
	int conflicted = 0;
	put_u32(out, (uint32_t)count);
	for (size_t i = 0; i < count; i++) {
		const git_index_entry *e = git_index_get_byindex(idx, i);
		int stage = git_index_entry_stage(e);
		conflicted |= stage != 0;
		put_str(out, e->path);
		put_u32(out, e->mode);
		put_oid(out, &e->id);
		put_u32(out, (uint32_t)stage);
	}
	if (conflicted) {
		put_u8(out, 0);
		goto done;
	}
	git_oid tree;
	if ((rc = git_index_write_tree_to(&tree, idx, repo)) < 0) {
		fail(out, rc, "write merged tree");
		goto done;
	}
	put_u8(out, 1);
	put_oid(out, &tree);
done:
	git_index_free(idx);
	for (int i = 0; i < 3; i++)
		git_tree_free(trees[i]);
	return rc;
}

static int merge_file(buf *in, buf *out) {
	git_merge_file_input sides[3];
	git_merge_file_options opts = GIT_MERGE_FILE_OPTIONS_INIT;
	git_merge_file_result result;

	for (int i = 0; i < 3; i++) {
		git_merge_file_input_init(&sides[i], GIT_MERGE_FILE_INPUT_VERSION);
		int exists = get_u8(in);
		size_t n;
		const unsigned char *p = get_bytes(in, &n);
		sides[i].ptr = exists ? (const char *)p : NULL;
		sides[i].size = exists ? n : 0;
		sides[i].mode = exists ? GIT_FILEMODE_BLOB : 0;
	}
	if (in->bad)
		return fail(out, GIT_EINVALID, "malformed request");
	opts.ancestor_label = "base";
	opts.our_label = "local";
	opts.their_label = "remote";
	int rc = git_merge_file(&result, &sides[0], &sides[1], &sides[2], &opts);
	if (rc < 0)
		return fail(out, rc, "merge file");
	put_u8(out, result.automergeable != 0);
	put_bytes(out, result.ptr, result.len);
	git_merge_file_result_free(&result);
	return 0;
}

static int write_pack(buf *in, buf *out, git_repository *repo) {
	git_packbuilder *pb = NULL;
	git_buf pack = GIT_BUF_INIT;
	int rc;

	uint32_t n = get_u32(in);
	if (in->bad || n > in->len / 20)
		return fail(out, GIT_EINVALID, "malformed request");
	if ((rc = git_packbuilder_new(&pb, repo)) < 0)
		return fail(out, rc, "create pack builder");
	for (uint32_t i = 0; i < n; i++) {
		git_oid id;
		get_oid(in, &id);
		if ((rc = git_packbuilder_insert(pb, &id, NULL)) < 0) {
			fail(out, rc, "insert pack object");
			goto done;
		}
	}
	size_t count = git_packbuilder_object_count(pb);
	if ((rc = git_packbuilder_write_buf(&pack, pb)) < 0) {
		fail(out, rc, "write pack");
		goto done;
	}
	put_u32(out, (uint32_t)count);
	put_bytes(out, pack.ptr, pack.size);
done:
	git_buf_dispose(&pack);
	git_packbuilder_free(pb);
	return rc;
}

static int import_pack(buf *in, buf *out, git_odb *odb) {
	git_odb_writepack *wp = NULL;
	git_indexer_progress stats = {0};
	size_t n;
	const unsigned char *p = get_bytes(in, &n);
	if (in->bad)
		return fail(out, GIT_EINVALID, "malformed request");
	int rc = git_odb_write_pack(&wp, odb, NULL, NULL);
	if (rc < 0)
		return fail(out, rc, "start pack import");
	if ((rc = wp->append(wp, p, n, &stats)) >= 0)
		rc = wp->commit(wp, &stats);
	wp->free(wp);
	return rc < 0 ? fail(out, rc, "import pack") : 0;
}

static int handle_request(buf *in, buf *out) {
	git_repository *repo;
	git_odb *odb;
	git_oid id;
	int rc;
	uint8_t op = get_u8(in);

	put_u8(out, 0);
	switch (op) {
	case OP_INIT:
		put_u32(out, (uint32_t)git_libgit2_init());
		return 0;
	case OP_SHUTDOWN:
		put_u32(out, (uint32_t)git_libgit2_shutdown());
		return 0;
	case OP_VERSION: {
		int maj, min, rev;
		git_libgit2_version(&maj, &min, &rev);
		put_u32(out, (uint32_t)maj);
		put_u32(out, (uint32_t)min);
		put_u32(out, (uint32_t)rev);
		return 0;
	}
	case OP_FEATURES:
		put_u32(out, (uint32_t)git_libgit2_features());
		return 0;
	case OP_CREATE_REPO:
	case OP_OPEN_REPO: {
		char *path = get_str(in);
		unsigned bare = op == OP_CREATE_REPO ? get_u8(in) : 0;
		if (in->bad)
			rc = fail(out, GIT_EINVALID, "malformed request");
		else if (op == OP_CREATE_REPO)
			rc = git_repository_init(&repo, path, bare);
		else
			rc = git_repository_open(&repo, path);
		free(path);
		if (rc < 0)
			return fail(out, rc, op == OP_CREATE_REPO ? "create repository" : "open repository");
		put_u32(out, add_handle(REPO, repo));
		return 0;
	}
	case OP_FREE: {
		uint32_t h = get_u32(in);
		if (h >= nhandles || handles[h].kind == FREE_SLOT)
			return bad_handle(out);
		if (handles[h].kind == REPO)
			git_repository_free(handles[h].ptr);
		else
			git_odb_free(handles[h].ptr);
		handles[h].kind = FREE_SLOT;
		return 0;
	}
	case OP_REPO_PATH:
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		put_str(out, git_repository_path(repo));
		return 0;
	case OP_REPO_ODB:
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		if ((rc = git_repository_odb(&odb, repo)) < 0)
			return fail(out, rc, "open object database");
		put_u32(out, add_handle(ODB, odb));
		return 0;
	case OP_ODB_WRITE: {
		if (!(odb = lookup_handle(get_u32(in), ODB)))
			return bad_handle(out);
		size_t n;
		const unsigned char *p = get_bytes(in, &n);
		if (in->bad)
			return fail(out, GIT_EINVALID, "malformed request");
		if ((rc = git_odb_write(&id, odb, p, n, GIT_OBJECT_BLOB)) < 0)
			return fail(out, rc, "write blob");
		put_oid(out, &id);
		return 0;
	}
	case OP_ODB_READ: {
		git_odb_object *obj;
		if (!(odb = lookup_handle(get_u32(in), ODB)))
			return bad_handle(out);
		get_oid(in, &id);
		if ((rc = git_odb_read(&obj, odb, &id)) < 0)
			return fail(out, rc, "read blob");
		put_bytes(out, git_odb_object_data(obj), git_odb_object_size(obj));
		git_odb_object_free(obj);
		return 0;
	}
	case OP_ODB_EXISTS:
		if (!(odb = lookup_handle(get_u32(in), ODB)))
			return bad_handle(out);
		get_oid(in, &id);
		put_u8(out, git_odb_exists(odb, &id) == 1);
		return 0;
	case OP_WRITE_TREE: {
		git_treebuilder *bld;
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		uint32_t n = get_u32(in);
		if ((rc = git_treebuilder_new(&bld, repo, NULL)) < 0)
			return fail(out, rc, "create tree builder");
		for (uint32_t i = 0; i < n && rc >= 0; i++) {
			char *name = get_str(in);
			git_filemode_t mode = get_u32(in);
			get_oid(in, &id);
			if (in->bad)
				rc = fail(out, GIT_EINVALID, "malformed request");
			else if ((rc = git_treebuilder_insert(NULL, bld, name, &id, mode)) < 0)
				fail(out, rc, "insert tree entry");
			free(name);
		}
		if (rc >= 0 && (rc = git_treebuilder_write(&id, bld)) < 0)
			fail(out, rc, "write tree");
		git_treebuilder_free(bld);
		if (rc >= 0)
			put_oid(out, &id);
		return rc;
	}
	case OP_READ_TREE: {
		git_tree *tree;
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		get_oid(in, &id);
		if ((rc = git_tree_lookup(&tree, repo, &id)) < 0)
			return fail(out, rc, "lookup tree");
		size_t count = git_tree_entrycount(tree);
		put_u32(out, (uint32_t)count);
		for (size_t i = 0; i < count; i++) {
			const git_tree_entry *e = git_tree_entry_byindex(tree, i);
			put_str(out, git_tree_entry_name(e));
			put_u32(out, git_tree_entry_filemode(e));
			put_oid(out, git_tree_entry_id(e));
		}
		git_tree_free(tree);
		return 0;
	}
	case OP_CREATE_COMMIT:
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		return create_commit(in, out, repo);
	case OP_READ_COMMIT: {
		git_commit *commit;
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		get_oid(in, &id);
		if ((rc = git_commit_lookup(&commit, repo, &id)) < 0)
			return fail(out, rc, "lookup commit");
		put_oid(out, git_commit_tree_id(commit));
		unsigned count = git_commit_parentcount(commit);
		put_u32(out, count);
		for (unsigned i = 0; i < count; i++)
			put_oid(out, git_commit_parent_id(commit, i));
		put_str(out, git_commit_message(commit));
		git_commit_free(commit);
		return 0;
	}
	case OP_MERGE_TREES:
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		return merge_trees(in, out, repo);
	case OP_MERGE_FILE:
		return merge_file(in, out);
	case OP_WRITE_PACK:
		if (!(repo = lookup_handle(get_u32(in), REPO)))
			return bad_handle(out);
		return write_pack(in, out, repo);
	case OP_IMPORT_PACK:
		if (!(odb = lookup_handle(get_u32(in), ODB)))
			return bad_handle(out);
		return import_pack(in, out, odb);
	default:
		git_error_set_str(GIT_ERROR_INVALID, "unknown operation");
		return fail(out, GIT_EINVALID, "unknown operation");
	}
}

int main(void) {
	buf in = {0}, out = {0};
	unsigned char len[4];

	while (read_full(0, len, 4) == 0) {
		size_t n = (size_t)len[0] | (size_t)len[1] << 8 | (size_t)len[2] << 16 | (size_t)len[3] << 24;
		in.len = in.pos = 0;
		in.bad = 0;
		need(&in, n);
		if (read_full(0, in.data, n) != 0) {
			fputs("slivingdoc-git2: truncated request\n", stderr);
			return 1;
		}
		in.len = n;
		out.len = 0;
		git_error_clear();
		handle_request(&in, &out);
		unsigned char le[4] = {out.len, out.len >> 8, out.len >> 16, out.len >> 24};
		if (write_full(1, le, 4) != 0 || write_full(1, out.data, out.len) != 0)
			return 1;
	}
	return 0;
}
