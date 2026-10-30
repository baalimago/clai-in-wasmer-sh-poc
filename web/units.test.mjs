// The page's logic that needs no browser: the under-the-hood model the kernel's events build,
// and how Minutes reads the notebook and the agent's reply.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Machine, describe, mask } from "./www/hood.js";
import { describeFile, parseNote, replyText } from "./www/minutes.js";

const exec = (pid, ppid, path, argv, t = 1) => ({ t, type: "exec", pid, ppid, path, argv });

test("a line's processes carry the tag of the bash that ran it", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "cd -- '/home' || exit\nclai q hi", "minutes:Record#1"]),
    exec(3, 2, "/bin/clai", ["clai", "q", "hi"]),
    exec(4, 3, "/usr/bin/ffmpeg", ["ffmpeg", "-f", "pulse"]),
    exec(9, 1, "/bin/bash", ["bash", "-c", "ls", "terminal"]),
  ]);

  assert.deepEqual(m.find("minutes:Record#1", "ffmpeg").map((p) => p.pid), [4]);
  assert.equal(m.procs.get(9).action, "terminal");
  const [root] = m.tree("minutes:Record#1");
  assert.equal(root.proc.pid, 2);
  assert.equal(root.children[0].children[0].proc.name, "ffmpeg");
  assert.equal(describe(root.proc), "bash -c clai q hi");
});

test("bytes written through a copied descriptor count for the file", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "echo hi > /tmp/a", "terminal"]),
    { t: 1, type: "open", pid: 2, fd: 3, path: "/tmp/a", write: true },
    { t: 1, type: "dup", pid: 2, from: 3, to: 1 },
    { t: 1, type: "close", pid: 2, fd: 3 },
    { t: 2, type: "io", pid: 2, fd: 1, dir: "out", bytes: 3 },
  ]);

  const file = m.resources.get("file:/tmp/a");
  assert.equal(file.out, 3);
  assert.deepEqual([...file.procs], ["bash"]);
});

test("a child execs with its parent's descriptors, but for those it changed", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "x", "terminal"]),
    { t: 1, type: "open", pid: 2, fd: 5, path: "/tmp/out", write: true },
    { t: 1, type: "connect", pid: 2, fd: 6, host: "api.openai.com", port: 443 },
    { t: 1, type: "dup", pid: 7, from: 9, to: 6 },
    exec(7, 2, "/bin/cat", ["cat"]),
    { t: 2, type: "io", pid: 7, fd: 5, dir: "out", bytes: 10 },
    { t: 2, type: "io", pid: 7, fd: 6, dir: "out", bytes: 99 },
  ]);

  assert.equal(m.resources.get("file:/tmp/out").out, 10);
  assert.equal(m.resources.get("net:api.openai.com:443").out, 0);
});

test("an ended process's descriptors are forgotten", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "x", "terminal"]),
    { t: 1, type: "open", pid: 2, fd: 5, path: "/tmp/out", write: true },
    { t: 2, type: "exit", pid: 2, code: 0 },
  ]);

  assert.equal(m.fds.size, 0);
  assert.equal(m.procs.get(2).status, "exit 0");
});

test("keys are masked wherever they show", () => {
  assert.equal(mask("OPENAI_API_KEY=sk-abcdefghijkl clai"), "OPENAI_API_KEY=sk-…ijkl clai");
  assert.equal(mask("TOKEN=short"), "TOKEN=…");
});

test("a notebook file names its meeting", () => {
  assert.deepEqual(describeFile("meetings/summaries/2026-10-30T08-00Z_daily-standup.md"), {
    start: "2026-10-30T08-00Z",
    title: "Daily standup",
  });
  assert.deepEqual(parseNote("---\ntitle: \"Daily\"\nduration: 15\n---\n# Notes\n"), {
    fields: { title: "Daily", duration: "15" },
    body: "# Notes\n",
  });
  assert.deepEqual(parseNote("no front matter"), { fields: {}, body: "no front matter" });
});

test("the agent's reply leaves out clai's status lines", () => {
  const stdout = "2026-10-30T12:45:14Z \x1b[32mok\x1b[0m: added new field(s)\n" +
    "2026-10-30T12:45:14Z \x1b[33mwarning\x1b[0m: found none\nWho is Speaker A?\n";
  assert.equal(replyText(stdout), "Who is Speaker A?");
});
