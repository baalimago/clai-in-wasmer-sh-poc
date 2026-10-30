// The page's logic that needs no browser: the under-the-hood model the kernel's events build,
// and how Minutes reads the notebook and the agent's reply.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Machine, describe, label, mask } from "./www/hood.js";
import { notePath, renderMarkdown } from "./www/markdown.js";
import { wrapWords } from "./www/doodles.js";
import {
  accountOf, describeFile, groupMeetings, isRemote, meetingMeta, parseApproval, parseList, parseNote,
  parseSpaces, profilePage, replyText, splitMessage, summariesIn,
} from "./www/minutes.js";

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

test("the process tree folds a wrapper into its program and draws its lines", () => {
  const m = new Machine();
  m.add([
    exec(2, 1, "/bin/bash", ["bash", "-c", "clai q", "minutes:Record#1"]),
    exec(3, 2, "/bin/clai", ["clai", "q"]),
    exec(4, 3, "/usr/local/bin/ffmpeg", ["ffmpeg", "-sources", "pulse"]),
    exec(5, 3, "/usr/local/bin/ffmpeg", ["ffmpeg", "-f", "pulse", "-i", "browser-mic"]),
    exec(6, 5, "/bin/ffmpeg", ["ffmpeg", "-f", "s16le", "-i", "/run/audio/mic"]),
  ]);

  assert.deepEqual(m.rows("minutes:Record#1").map((r) => `${r.prefix}${r.proc.pid}`), ["2", "└ 3", "  ├ 4", "  └ 5"]);
  assert.deepEqual(label(m.procs.get(5)), { note: "WASI", tag: "recording" });
  assert.equal(label(m.procs.get(4)).note, "lists audio devices");
  assert.equal(label(m.procs.get(3)).note, "the agent · Go, GOOS=wasix");
});

test("the notebook's listing gives each meeting its title, date and duration", () => {
  const body = "@@ meetings/summaries/2026-10-29T09-00Z_design-review.md\ntitle: Design review\nduration: 38\n---\n" +
    "@@ meetings/summaries/2026-10-30T08-00Z_daily-sync.md\n";
  const [first, second] = parseList(body);

  assert.equal(first.title, "Daily sync");
  assert.equal(first.date.toISOString(), "2026-10-30T08:00:00.000Z");
  assert.equal(first.duration, null);
  assert.equal(second.title, "Design review");
  assert.equal(second.duration, 38);
});

test("meetings group by day and say when and how long", () => {
  const now = new Date(2026, 9, 30, 15, 0);
  const at = (day, hour) => ({ date: new Date(2026, 9, day, hour, 0), duration: 38 });
  const groups = groupMeetings([at(30, 9), at(28, 10), at(1, 10)], now);

  assert.deepEqual(groups.map((g) => [g.label, g.items.length]), [["Today", 1], ["This week", 1], ["Earlier", 1]]);
  assert.match(meetingMeta(at(28, 10), now), /^\S+ · 38 min$/);
  assert.equal(meetingMeta({ date: null, duration: 0.2 }, now), "<1 min");
});

test("the agent's links to the notebook open in the app, and its HTML stays text", () => {
  const reply = "- [Transcript](file:///home/user/notebook/meetings/transcripts/2026-10-30T13-48Z_daily-sync.md)\n" +
    "- [Summary](file:///home/user/notebook/meetings/summaries/2026-10-30T13-48Z_daily-sync.md)\n\n" +
    "**Summary:** <img src=x onerror=alert(1)> [x](javascript:alert(1)) [docs](https://example.com)";
  const html = renderMarkdown(reply);

  assert.deepEqual(summariesIn(reply), ["meetings/summaries/2026-10-30T13-48Z_daily-sync.md"]);
  assert.equal(notePath("meetings/summaries/a.md"), "meetings/summaries/a.md");
  assert.equal(notePath("https://example.com"), null);
  assert.match(html, /<a href="#" data-note="meetings\/transcripts\/2026-10-30T13-48Z_daily-sync.md">Transcript<\/a>/);
  assert.match(html, /<strong>Summary:<\/strong> &lt;img/);
  assert.doesNotMatch(html, /javascript:|<img/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener">docs<\/a>/);
});

test("slivingdoc's login gives its sign-in page and code, then who approved it", () => {
  const lines = ["To log in, open this page and approve the code FDFS-RLGM:"];
  assert.equal(parseApproval(lines), null);
  lines.push("  https://www.slivingdoc.dev/cli/login#FDFS-RLGM", "(or open https://www.slivingdoc.dev/cli/login and enter the code)");

  assert.deepEqual(parseApproval(lines), { code: "FDFS-RLGM", url: "https://www.slivingdoc.dev/cli/login#FDFS-RLGM" });
  assert.equal(accountOf('{"logins":[{"Key":"k","Account":"ada@example.com"}]}'), "ada@example.com");
  assert.equal(accountOf("not json"), null);
});

test("a login's spaces, and its default one", () => {
  const none = "HOSTED  https://api.slivingdoc.dev  ada@example.com\n  main  write  ada@example.com\n" +
    "  notes (meetings)  read  ada@example.com\nNo default space; run 'slivingdoc space <name>' to choose one.\n";
  assert.deepEqual(parseSpaces(none), { names: ["main", "notes"], current: null });
  assert.deepEqual(parseSpaces("HOSTED  https://api.slivingdoc.dev  ada\n  main  write  ada\n* notes  write  ada\n"),
    { names: ["main", "notes"], current: "notes" });
});

test("a hub profile is trusted before it runs, and its page says what it runs", () => {
  assert.equal(isRemote("cchub:baalimago/meeting-transcriber@13"), true);
  assert.equal(isRemote("/tmp/meeting.json"), false);
  assert.equal(profilePage("cchub:baalimago/meeting-transcriber@13"), "https://www.clai.chat/hub/baalimago/meeting-transcriber/");
  assert.equal(profilePage("gh:a/b/c.json@v1"), null);
});

test("a message names its topic on its first line, and its body stays bytes", () => {
  const { topic, body } = splitMessage(new Uint8Array([...new TextEncoder().encode("recording-part\n"), 0, 10, 255]));
  assert.equal(topic, "recording-part");
  assert.deepEqual([...body], [0, 10, 255]);
  assert.deepEqual(splitMessage(new TextEncoder().encode("recording-end")).body.length, 0);
});

test("a scribbled log line wraps at spaces instead of being cut", () => {
  const line = "exec: clai q Answer who Speaker A is, then write the summary · pid 31";
  const lines = wrapWords(line, 24, 8);
  assert.equal(lines.join(" "), line);
  assert.ok(lines.every((l) => l.length <= 24));
});

test("a scribbled word longer than a line breaks across lines", () => {
  assert.deepEqual(wrapWords("fs: /home/user/notebook/meetings", 12, 8), ["fs:", "/home/user/n", "otebook/meet", "ings"]);
});

test("a scribbled log line past the last rule ends in an ellipsis", () => {
  const lines = wrapWords("a b c d e f g h", 3, 2);
  assert.deepEqual(lines, ["a b", "c …"]);
});
