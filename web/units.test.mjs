// The page's logic that needs no browser: the under-the-hood model the kernel's events build,
// and how Minutes reads the notebook and the agent's reply.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Machine, describe, label, mask } from "./www/hood.js";
import { notePath, renderMarkdown } from "./www/markdown.js";
import { STEPS, fetchedLine, resourceLabel, stepsFor, stepsOver } from "./www/arrival.js";
import { groupLines, writingMs } from "./www/pen.js";
import { wrapWords } from "./www/doodles.js";
import { isShellLine } from "./www/shell.js";
import { AudioInputs, audioLimits, platformOf, withOsVersion } from "./www/audio.js";
import { AgentRun, brief, problemOf, toolProblem } from "./www/agent.js";
import { RecordPrinter } from "./www/records.js";
import {
  Fixes, align, clock, diffMarks, marksToHtml, offerWhere, parseUtterance, partsOf, resolveConflicts, singleChange, transcriptRows,
} from "./www/proofread.js";
import { activityOf, correctionsOf, penelopeQuery, parseSay } from "./www/penelope.js";
import {
  DEFAULTS, SILENCE_SECONDS, accountOf, untrustedProfile, precheck, notebookFormat, describeFile, groupMeetings, isRemote, meetingMeta, parseApproval, parseList, parseNote,
  parseSpaces, profilePage, signoutResult, splitMessage, summariesIn, unknownSpeakers,
  withFlags, withoutHeading,
} from "./www/minutes.js";
import {
  OPENROUTER_AUDIO, PROVIDERS, activeProvider, authorizeUrl, callbackMessage, challengeOf, exchangeCode, pkce, providerById, providerFlags, sha256Hex,
} from "./www/providers.js";

const exec = (pid, ppid, path, argv, t = 1) => ({ t, type: "exec", pid, ppid, path, argv });

test("a line with a shell operator after its first word goes to bash whole", () => {
  for (const line of ["cd /tmp/m && go build .", "export A=1; ls", "cd /x | wc -l", "cd /x 2>/dev/null", "cd /x > out"])
    assert.ok(isShellLine(line), line);
  for (const line of ["cd /tmp/m", "export A=1 B=2", "help", "cd 'a > b'", 'cd "a && b"', "cd a\\>b"])
    assert.ok(!isShellLine(line), line);
});

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

test("the agent's reply is its last reply record, whatever streamed before it", () => {
  const run = new AgentRun();
  for (const line of [
    '{"type":"reply_delta","text":"Let me "}',
    '{"type":"reply_delta","text":"record."}',
    '{"type":"reply","text":"Let me record."}',
    '{"type":"tool_call","name":"audio_record","inputs":{}}',
    '{"type":"tool_result","name":"audio_record","ok":true,"output":"saved /tmp/a.wav"}',
    '{"type":"diagnostic","name":"clai.run_summary","subsystem":"clai","level":"info","message":"query done","facts":{}}',
    '{"type":"reply_delta","text":"Who is "}',
    '{"type":"reply_delta","text":"Speaker A?"}',
    '{"type":"reply","text":"Who is Speaker A?"}',
    "",
  ]) run.take(line);
  assert.equal(run.text, "Who is Speaker A?");
  assert.deepEqual([run.errors, run.failures, run.warnings, run.stray], [[], [], [], []]);
  assert.equal(problemOf(run, 0), null);
});

test("a reply that never closed is what streamed of it", () => {
  const run = new AgentRun();
  run.take('{"type":"reply_delta","text":"Hello wor"}');
  assert.equal(run.text, "Hello wor");
});

test("a rejected key is a problem that names the status, clai's remedy and the provider's code", () => {
  const run = new AgentRun();
  const message = 'run step 0: stream completions: authentication failed, status: 401, provider code: invalid_api_key, body: {"error":{"message":"Incorrect API key provided"}}';
  run.take(JSON.stringify({ type: "error", message, causes: [{ message, status: 401, provider_code: "invalid_api_key", remedies: ["Set OPENAI_API_KEY to your API key"] }] }));
  assert.deepEqual(problemOf(run, 1), {
    level: "error",
    title: "The provider rejected the API key",
    detail: "authentication failed, status: 401, provider code: invalid_api_key",
    hint: "Set OPENAI_API_KEY to your API key",
    code: "invalid_api_key",
  });
});

test("an error without a status keeps clai's words, short", () => {
  const run = new AgentRun();
  const message = "failed to create text querier: failed to find text querier for model: opus-5.5";
  run.take(JSON.stringify({ type: "error", message, causes: [{ message }] }));
  const problem = problemOf(run, 1);
  assert.equal(problem.title, "The agent stopped with an error");
  assert.equal(problem.detail, message);
  assert.equal(brief(`run step 2: ${"x".repeat(400)}`).length, 220);
});

test("an interrupt and a cut-off reply say what they are", () => {
  const titled = (message) => {
    const run = new AgentRun();
    run.take(JSON.stringify({ type: "error", message, causes: [{ message }] }));
    return problemOf(run, 130).title;
  };
  assert.equal(titled("interrupted by signal: interrupt"), "The agent was interrupted");
  assert.equal(titled("run step 0: completion stream error: transport failure: the reply is truncated: unexpected EOF"), "The reply was cut off");
  assert.equal(titled("run step 0: completion stream error: unexpected provider response, status: 200, body: the provider returned no completion"), "The provider sent no reply");
});

test("a failed exit without an error record still is a problem, with the last thing said", () => {
  const run = new AgentRun();
  run.take("bash: clai: command not found");
  assert.deepEqual(run.stray, ["bash: clai: command not found"]);
  assert.deepEqual(problemOf(run, 127), {
    level: "error", title: "The agent stopped with exit status 127", detail: "bash: clai: command not found", hint: null, code: null,
  });
});

test("a run that printed no record and no reply died, even with a clean status", () => {
  const run = new AgentRun();
  run.take("panic: runtime error: index out of range");
  run.take("goroutine 1 [running]:");
  assert.equal(problemOf(run, 0).title, "The agent stopped unexpectedly");
  assert.equal(problemOf(run, 0).detail, "goroutine 1 [running]:");
  // A stray line beside a reply is not a failure.
  run.take('{"type":"reply","text":"All filed."}');
  assert.equal(problemOf(run, 0), null);
});

// What a printer writes for records, with the terminal's colours taken out.
const drawn = (records) => {
  const printer = new RecordPrinter();
  const text = records.map((r) => (typeof r === "string" ? printer.raw(r) : printer.print(r))).join("") + printer.end();
  return text.replace(/\x1b\[[0-9;]*m/g, "");
};

test("the terminal joins what streams into running text, and a reply is written once", () => {
  assert.equal(drawn([
    { type: "reasoning_delta", text: "The user" },
    { type: "reasoning_delta", text: " wants notes." },
    { type: "reply_delta", text: "I will " },
    { type: "reply_delta", text: "record\nnow." },
    { type: "reply", text: "I will record\nnow." },
    { type: "reply", text: "Whole." },
  ]), "thinking The user wants notes.\r\nI will record\r\nnow.\r\nWhole.\r\n");
});

test("the terminal shows a tool as a line and its result under it", () => {
  assert.equal(drawn([
    { type: "tool_call", name: "audio_sources", inputs: {} },
    { type: "tool_call", name: "audio_record", inputs: { dir: "/tmp/recordings", mic: true, devices: ["browser-mic"] } },
    { type: "tool_result", name: "audio_sources", ok: true, output: "system_audio: available\nmic one\nmic two\n" },
    { type: "tool_result", name: "fs", ok: false, output: "ERROR: Access denied", error: "Access denied" },
  ]), "▸ audio_sources\r\n▸ audio_record dir=/tmp/recordings mic=true devices=[\"browser-mic\"]\r\n" +
    "  ✓ audio_sources: system_audio: available (+2 more lines)\r\n  ✗ fs: Access denied\r\n");
});

test("the terminal redraws one line for a progress, and ends it when it is done", () => {
  const erase = "\r\x1b[2K";
  const printer = new RecordPrinter();
  const text = [
    { type: "progress", title: "audio_record", state: "start", detail: "/tmp/rec" },
    { type: "progress", title: "audio_record", state: "update", detail: "silent" },
    { type: "progress", title: "audio_record", state: "update", detail: "sound" },
    { type: "progress", title: "audio_record", state: "done", detail: "saved" },
    { type: "reply", text: "Filed." },
  ].map((r) => printer.print(r)).join("").replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(text, `… audio_record start /tmp/rec${erase}… audio_record update silent${erase}… audio_record update sound` +
    `${erase}… audio_record done saved\r\nFiled.\r\n`);
});

test("the terminal shows an error with its status, code and hint, and other lines as they are", () => {
  const message = "authentication failed, status: 401";
  assert.equal(drawn([
    { type: "reply_delta", text: "Let me" },
    { type: "error", message, causes: [{ message, status: 401, provider_code: "invalid_api_key", remedies: ["Set OPENAI_API_KEY"] }] },
    { type: "diagnostic", level: "warn", subsystem: "clai", message: "shutting down gracefully", facts: { signal: "interrupt" } },
    { type: "prompt", kind: "calibrate", text: "silence levels may not match", choices: ["a"] },
    "bash: clai: command not found",
  ]), "Let me\r\nerror: authentication failed, status: 401\r\n  status 401 · invalid_api_key\r\n  hint: Set OPENAI_API_KEY\r\n" +
    "warn [clai] shutting down gracefully signal=interrupt\r\n? silence levels may not match [a]\r\nbash: clai: command not found\r\n");
});

test("a tool that failed is a warning, and a missing program is named as one", () => {
  const run = new AgentRun();
  run.take(JSON.stringify({
    type: "tool_result", name: "audio_sources", ok: false,
    output: "ERROR: failed to run tool: audio_sources, error: ffmpeg -sinks pulse failed: exit status 127: /bin/bash: /usr/local/bin/ffmpeg: No such file or directory",
    error: "failed to run tool: audio_sources, error: ffmpeg -sinks pulse failed: exit status 127: /bin/bash: /usr/local/bin/ffmpeg: No such file or directory",
  }));
  const problem = toolProblem(run.failures[0]);
  assert.equal(problem.level, "warn");
  assert.equal(problem.title, "The agent's audio_sources tool failed");
  assert.equal(problem.hint, "A program the tool starts is missing on the machine.");
  assert.equal(toolProblem({ name: "cat", error: "permission denied" }).hint, null);
  // The run itself went on, so nothing stopped it.
  assert.equal(problemOf(run, 0), null);
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

test("a sign-out forgets a login only once its key is revoked", () => {
  assert.deepEqual(signoutResult({ account: "ada@example.com", tokenOnly: false, status: 0 }), {
    revoked: true,
    message: "Signed out of ada@example.com.",
    page: null,
  });
  const failed = signoutResult({
    account: "ada@example.com",
    tokenOnly: false,
    status: 1,
    said: "logout: the login key could not be revoked and stays stored; retry",
  });
  assert.equal(failed.revoked, false);
  assert.match(failed.message, /^Signing out of ada@example\.com failed: logout: the login key could not be revoked/);
  assert.equal(failed.page, "https://www.slivingdoc.dev/tokens");
});

test("a token-only sign-out says the key outlives the tab", () => {
  const result = signoutResult({ account: null, tokenOnly: true, status: 0 });

  assert.equal(result.revoked, true);
  assert.match(result.message, /stays valid until it is revoked on slivingdoc\.dev\.$/);
  assert.equal(result.page, "https://www.slivingdoc.dev/tokens");
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

test("the agent the app runs is the hub's latest, with no version pin", () => {
  assert.equal(DEFAULTS.profile, "cchub:baalimago/meeting-transcriber");
  assert.equal(isRemote(DEFAULTS.profile), true);
  assert.equal(profilePage(DEFAULTS.profile), "https://www.clai.chat/hub/baalimago/meeting-transcriber/");
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

test("a transcript's speakers without a name, each with a line they said", () => {
  const transcript = [
    "# Transcript", "",
    "**Speaker A:** Hi.",
    "**Speaker A:** Let us ship the peek on Friday.",
    "- Unknown speaker [00:12]: I can review it tomorrow morning.",
    "**Ada:** Sounds good.",
    "Speaker B: Fine.",
  ].join("\n");
  assert.deepEqual(unknownSpeakers(transcript), [
    { label: "Speaker A", sample: "Let us ship the peek on Friday." },
    { label: "Unknown speaker", sample: "I can review it tomorrow morning." },
    { label: "Speaker B", sample: "Fine." },
  ]);
  assert.deepEqual(unknownSpeakers("**Ada:** Hi.\n**Grace:** Hello."), []);
  assert.deepEqual(unknownSpeakers("[00:00:14.550 --> 00:00:21.550] Speaker B: I think when you do it."), [
    { label: "Speaker B", sample: "I think when you do it." },
  ]);
});

test("a note's own Summary or Transcript heading goes, the card has one", () => {
  assert.equal(withoutHeading("## Summary\n\n- Ship it", "summary"), "- Ship it");
  assert.equal(withoutHeading("# Meeting transcript\nAda: hi", "transcript"), "Ada: hi");
  assert.equal(withoutHeading("- Ship it\n## Summary", "summary"), "- Ship it\n## Summary");
});


test("the pad writes each loading phase once, in order, and nothing after ready", () => {
  assert.deepEqual(stepsFor(["booting", "checking", "checking", "fetching", "ready", "listing"]),
    [STEPS.booting, STEPS.checking, STEPS.fetching]);
  assert.deepEqual(stepsFor(["booting", "listing", "ready"]), [STEPS.booting, STEPS.listing]);
  assert.deepEqual(stepsFor(["ready"]), []);
});

test("the pad names a fetched file by its program or package, and a line of them by size", () => {
  assert.equal(resourceLabel("./clai.wasm.gz"), "clai");
  assert.equal(resourceLabel("./bin/slivingdoc-git2.wasm"), "slivingdoc-git2");
  assert.equal(resourceLabel("./packages/wasmer-coreutils-1.0.27.webc.gz"), "coreutils");
  assert.equal(resourceLabel("./packages/wasmer-bash-1.0.25.webc"), "bash");
  assert.equal(resourceLabel("./pkg/clai_web_bg.wasm.gz"), "the kernel");
  assert.equal(resourceLabel("./bin/play.sh"), "play.sh");
  assert.equal(fetchedLine([{ url: "./clai.wasm.gz", bytes: 7_680_050 }]), "clai · 7.7 MB");
  assert.equal(fetchedLine([
    { url: "./packages/wasmer-grep-3.12.0.webc", bytes: 120_000 },
    { url: "./packages/wasmer-sed-4.9.0.webc", bytes: 90_000 },
  ]), "grep, sed · 210 KB");
});

test("the boxes are ticked only once Minutes is ready and the pen has doodled", () => {
  assert.equal(stepsOver(3, false, true), 0);
  assert.equal(stepsOver(3, true, false), 0);
  assert.equal(stepsOver(3, true, true), 3);
});

test("a pen writes text line by line, the rects of one line taken together", () => {
  const rect = (left, top, width, height = 30) => ({ left, top, right: left + width, bottom: top + height });
  const lines = groupLines([rect(200, 40, 50), rect(10, 0, 100), rect(112, 2, 60, 26), rect(10, 40, 180), rect(5, 90, 0)]);
  assert.deepEqual(lines, [
    { left: 10, right: 172, top: 0, bottom: 30 },
    { left: 10, right: 250, top: 40, bottom: 70 },
  ]);
  assert.deepEqual(groupLines([]), []);
});

test("a pen takes longer over more text, within bounds", () => {
  assert.equal(writingMs(10), 260);
  assert.ok(writingMs(300) > writingMs(200));
  assert.equal(writingMs(5000), 1700);
});

test("signed out of slivingdoc, the agent keeps the notes here and does not ask for a sign-in", () => {
  const local = DEFAULTS.query("Standup", "Ada and Grace", false);
  assert.match(local, /chose not to sign in to slivingdoc/);
  assert.match(local, /do not ask the user to sign in/);
  assert.doesNotMatch(local, /in the slivingdoc notebook/);
  assert.match(local, /Meeting: Standup\. Ada and Grace$/);
  assert.match(notebookFormat(true), /in the slivingdoc notebook/);
  for (const format of [notebookFormat(true), notebookFormat(false)]) assert.match(format, /meetings\/summaries\/<start>_<slug>\.md/);
});

// A MediaStream's stand-in: its tracks, and whether they were stopped. `surface` is what a
// display share shares.
const fakeStream = (kinds = ["audio", "video"], surface = "monitor") => {
  const listeners = [];
  const tracks = kinds.map((kind) => ({
    kind, label: kind, stopped: false,
    stop() { this.stopped = true; },
    getSettings: () => ({ displaySurface: surface }),
    addEventListener: (type, f) => listeners.push(f),
  }));
  return { tracks, end: () => listeners.forEach((f) => f()), getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === "audio"), getVideoTracks: () => tracks.filter((t) => t.kind === "video") };
};

// The browser's media devices, recording what was asked of them.
const fakeMedia = (devices, display = async () => fakeStream()) => {
  const asked = [];
  return {
    asked,
    getUserMedia: async (constraints) => (asked.push(["user", constraints]), fakeStream(["audio"])),
    getDisplayMedia: (constraints) => (asked.push(["display", constraints]), display()),
    enumerateDevices: async () => devices.map((d) => ({ kind: "audioinput", ...d })),
  };
};

// An AudioContext's stand-in for AudioInputs.start: enough to wire a capture node.
const fakeAudio = () => {
  const node = () => ({ connect() {}, disconnect() {}, port: {} });
  globalThis.AudioWorkletNode = function () { return node(); };
  return class {
    constructor() { this.destination = node(); this.audioWorklet = { addModule: async () => {} }; }
    resume = async () => {};
    close = async () => {};
    createMediaStreamSource = () => node();
  };
};

const inputs = (media) => {
  const notices = [];
  let relisted = 0;
  const audio = new AudioInputs({ send: () => {}, notice: (t) => notices.push(t), relist: () => relisted++, media, Context: fakeAudio() });
  return { audio, notices, relisted: () => relisted };
};
const labelOf = (audio, name) => audio.listing().find((i) => i.name === name)?.label;

test("until a screen or tab is shared, its input has no label, so ffmpeg leaves it out", async () => {
  const { audio } = inputs(fakeMedia([{ deviceId: "default", label: "Default - Mic" }]));
  await audio.discover();
  assert.equal(labelOf(audio, "tab"), "");
  assert.equal(labelOf(audio, "mic"), "Mic");
  assert.deepEqual(audio.access(), { mic: "Mic", computer: null });
});

test("a share from the button is a sink for clai, named for what was shared, until it ends", async () => {
  const stream = fakeStream(["audio", "video"], "browser");
  const media = fakeMedia([{ deviceId: "default", label: "Default - Mic" }], async () => stream);
  const { audio, relisted } = inputs(media);
  await audio.discover();
  assert.equal(await audio.share(), "shared");
  const [[, constraints]] = media.asked.filter(([kind]) => kind === "display");
  assert.equal(constraints.systemAudio, "include");
  assert.equal(labelOf(audio, "tab"), "Monitor of Shared tab (browser)");
  assert.deepEqual(audio.access().computer, { label: "Shared tab", via: "share" });
  assert.equal(relisted(), 1);
  // Recording it leaves the share up for the next recording.
  await audio.want(["mic", "tab"]);
  assert.ok(audio.inputs().find((i) => i.name === "tab").live);
  await audio.want([]);
  assert.ok(!stream.tracks.some((t) => t.stopped));
  stream.end();
  assert.equal(labelOf(audio, "tab"), "");
  assert.equal(relisted(), 2);
});

test("a share without audio is refused, and its video stopped", async () => {
  const stream = fakeStream(["video"]);
  const { audio, notices } = inputs(fakeMedia([], async () => stream));
  assert.equal(await audio.share(), "no-audio");
  assert.ok(stream.tracks[0].stopped);
  assert.match(notices.join(), /no audio/);
  assert.equal(labelOf(audio, "tab"), "");
});

test("a share turned down says why and lists nothing", async () => {
  const { audio, notices } = inputs(fakeMedia([], async () => { throw new Error("Permission denied"); }));
  assert.equal(await audio.share(), "refused");
  assert.match(notices.join(), /Permission denied/);
  assert.equal(audio.access().computer, null);
});

test("a monitor of the computer's output already carries its audio, with no share", async () => {
  const { audio } = inputs(fakeMedia([{ deviceId: "default", label: "Default - Mic" }, { deviceId: "m", label: "Monitor of Built-in Audio" }]));
  await audio.discover();
  assert.deepEqual(audio.access().computer, { label: "Monitor of Built-in Audio", via: "monitor" });
  assert.equal(labelOf(audio, "dev1"), "Monitor of Built-in Audio");
});

test("without a microphone, the shared input is still listed", async () => {
  const media = fakeMedia([]);
  media.getUserMedia = async () => { throw new Error("Permission denied"); };
  const { audio, notices } = inputs(media);
  await audio.discover();
  assert.deepEqual(audio.listing().map((i) => i.name), ["tab"]);
  assert.equal(audio.access().mic, null);
  assert.match(notices.join(), /no microphone/);
});

const ticks = (check) => check.items.map((i) => `${i.done ? "x" : " "} ${i.text}${i.action ? " >" : ""}`);

test("the checklist asks for the mic and a share; sound is only listened for, so a recording may start before anyone speaks", () => {
  const none = precheck({ mic: null, computer: null }, "Share a tab", {});
  assert.deepEqual(ticks(none), ["  Allow the mic >", "  Share a tab with your call >", "  Hear the call's sound"]);
  assert.equal(none.ready, false);
  const shared = { mic: "Mic", computer: { label: "Shared tab", via: "share" } };
  assert.deepEqual(ticks(precheck(shared, "Share a tab", {})), ["x Mic: Mic", "x Computer audio: Shared tab", "  Listening for sound…"]);
  assert.ok(precheck(shared, "Share a tab", {}).ready);
  assert.equal(precheck(shared, "Share a tab", { silent: true }).items[2].text, "No sound yet. You can still start.");
  assert.ok(precheck(shared, "Share a tab", { silent: true }).ready);
  const heard = precheck(shared, "Share a tab", { heard: true });
  assert.deepEqual(ticks(heard).at(-1), "x Sound heard");
  assert.ok(heard.ready);
  assert.ok(heard.sharing);
});

test("a monitor needs no share, and mic only skips the computer's audio on purpose", () => {
  const monitor = precheck({ mic: "Mic", computer: { label: "Monitor of Built-in Audio", via: "monitor" } }, "Share a tab", {});
  assert.deepEqual(ticks(monitor), ["x Mic: Mic", "x Computer audio: Monitor of Built-in Audio", "x Sound comes through the monitor"]);
  assert.ok(monitor.ready);
  const micOnly = precheck({ mic: "Mic", computer: null }, "Share a tab", { micOnly: true });
  assert.deepEqual(ticks(micOnly), ["x Mic: Mic", "x Computer audio: skipped, mic only", "x Sound: your mic only"]);
  assert.ok(micOnly.ready);
  const safari = precheck({ mic: "Mic", computer: null }, null, {});
  assert.deepEqual(ticks(safari)[1], "  Computer audio: this browser can't record it");
  assert.equal(safari.ready, false, "the user says mic only before recording without the call's sound");
  assert.equal(precheck({ mic: null, computer: null }, "Share a tab", { micOnly: true }).ready, false, "no mic, nothing to record");
});

test("the browser, its version and the OS come from the user agent", () => {
  const linuxChrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
  assert.deepEqual(platformOf({ userAgent: linuxChrome }), { os: "linux", browser: "chromium", name: "Chrome", version: 142 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0" }), { os: "windows", browser: "chromium", name: "Edge", version: 142 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15" }), { os: "mac", browser: "safari", name: "Safari", version: 17 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" }), { os: "linux", browser: "firefox", name: "Firefox", version: 140 });
  assert.deepEqual(platformOf({ userAgent: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" }), { os: "chromeos", browser: "chromium", name: "Chrome", version: 142 });
  // Chromium names itself in its brands, which Brave and others keep out of the user agent.
  assert.equal(platformOf({ userAgent: linuxChrome, userAgentData: { brands: [{ brand: "Brave", version: "142" }, { brand: "Chromium", version: "142" }] } }).name, "Brave");
});

test("on a Mac, Chromium tells its macOS version, which the user agent freezes", async () => {
  const userAgentData = { brands: [], getHighEntropyValues: async () => ({ platformVersion: "14.5.0" }) };
  const mac = platformOf({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" });
  assert.deepEqual(await withOsVersion(mac, { userAgentData }), { ...mac, osVersion: [14, 5] });
  const refused = { brands: [], getHighEntropyValues: async () => { throw new Error("NotAllowedError"); } };
  assert.deepEqual(await withOsVersion(mac, { userAgentData: refused }), mac);
  const linux = platformOf({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36" });
  assert.deepEqual(await withOsVersion(linux, { userAgentData }), linux);
});

const chrome = (os, extra = {}) => ({ os, browser: "chromium", name: "Chrome", version: 142, ...extra });
const said = (platform, monitor) => audioLimits(platform, monitor).text;

test("the audio note is one short instruction for this browser and OS", () => {
  assert.equal(said(chrome("linux")), "Chrome can only record a tab's sound. Share the tab with your call; desktop apps such as Zoom won't be heard.");
  assert.equal(audioLimits(chrome("linux")).share, "Share a tab");
  assert.equal(said(chrome("windows")), "Share your screen with \"Share system audio\" on, or the tab with your call.");
  assert.equal(audioLimits(chrome("windows")).share, "Share screen or tab");
  assert.equal(said({ ...chrome("windows"), name: "Edge" }), said(chrome("windows")));
  assert.equal(said({ os: "mac", browser: "safari", name: "Safari", version: 17 }), "Safari can't record a call's sound, only your mic. Use Chrome or Edge for calls.");
  assert.equal(audioLimits({ os: "linux", browser: "firefox", name: "Firefox" }).share, null);
  assert.equal(said({ os: "linux", browser: "firefox", name: "Firefox" }, "Monitor of Built-in Audio"), "Your computer's sound comes in through Monitor of Built-in Audio: nothing to share.");
});

test("on a Mac the note knows whether this Chrome and macOS can share the screen's sound", () => {
  assert.equal(said(chrome("mac", { osVersion: [14, 5] })), said(chrome("windows")));
  assert.equal(said(chrome("mac", { version: 140, osVersion: [14, 5] })), "Chrome 140 can only record a tab's sound (Chrome 141 can record the screen's). Share the tab with your call.");
  assert.equal(said(chrome("mac", { osVersion: [13, 6] })), "macOS 13.6 lets Chrome record only a tab's sound (macOS 14.2 can record the screen's). Share the tab with your call.");
  assert.equal(said(chrome("mac")), "Share the tab with your call. The screen's sound works only on macOS 14.2 or newer.");
});

test("every audio note fits in two lines of the pad", () => {
  const platforms = [chrome("linux"), chrome("windows"), chrome("chromeos"), chrome("mac"), chrome("mac", { osVersion: [14, 5] }),
    chrome("mac", { version: 140, osVersion: [14, 5] }), chrome("mac", { osVersion: [13, 6] }), { os: "mac", browser: "safari", name: "Safari" }];
  for (const platform of platforms) assert.ok(said(platform).length <= 120, said(platform));
});

// A clock the test moves: `sleep` advances it instead of waiting.
const fakeClock = () => {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
};

// An AudioContext's stand-in whose analyser hears `peaks`, one per look, then silence.
const hearing = (peaks) => {
  const heard = [...peaks];
  const state = { closed: false };
  class Context {
    resume = async () => {};
    close = async () => { state.closed = true; };
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} });
    createAnalyser = () => ({ fftSize: 4, getFloatTimeDomainData: (data) => data.fill(heard.shift() ?? 0) });
  }
  return { Context, state };
};

const listening = async (peaks) => {
  const { Context, state } = hearing(peaks);
  const media = fakeMedia([], async () => fakeStream());
  const audio = new AudioInputs({ send: () => {}, notice: () => {}, media, Context, ...fakeClock() });
  await audio.share();
  return { audio, state };
};

test("a share is heard once its sound passes the threshold", async () => {
  const { audio, state } = await listening([0, 0.001, 0.2]);
  const levels = [];
  assert.equal(await audio.hearShare({ onLevel: (l) => levels.push(l) }), "sound");
  assert.deepEqual(levels, [0, 0.001, 0.2].map(Math.fround));
  assert.ok(state.closed, "the listening context is closed");
});

test("a share with no sound for the whole wait is silent", async () => {
  const { audio } = await listening([]);
  assert.equal(await audio.hearShare({ ms: 2000 }), "silent");
});

test("nothing shared, or a share that ends while listening, is said so", async () => {
  const { Context } = hearing([]);
  const bare = new AudioInputs({ send: () => {}, notice: () => {}, media: fakeMedia([]), Context, ...fakeClock() });
  assert.equal(await bare.hearShare(), "unshared");
  const { audio } = await listening([]);
  const heard = audio.hearShare({ ms: 2000, onLevel: () => audio.unshare() });
  assert.equal(await heard, "ended");
});

test("a followed share says when it has been quiet for quietMs, and when sound comes back", async () => {
  const { audio, state } = await listening([0.2, 0, 0, 0, 0, 0, 0, 0.3, 0]);
  const events = [];
  let looks = 0;
  const end = await audio.followShare({
    quietMs: 1000, every: 250, active: () => ++looks <= 10,
    onQuiet: () => events.push(`quiet@${audio.now()}`), onSound: () => events.push(`sound@${audio.now()}`),
  });
  assert.equal(end, "done");
  assert.deepEqual(events, ["quiet@1000", "sound@1750"]);
  assert.ok(state.closed, "the following context is closed");
});

test("following nothing shared, or a share that ends, is said so", async () => {
  const { Context } = hearing([]);
  const bare = new AudioInputs({ send: () => {}, notice: () => {}, media: fakeMedia([]), Context, ...fakeClock() });
  assert.equal(await bare.followShare({ onQuiet() {}, onSound() {} }), "unshared");
  const { audio } = await listening([]);
  let looks = 0;
  const end = await audio.followShare({ every: 250, active: () => ++looks < 3 || (audio.unshare(), true), onQuiet() {}, onSound() {} });
  assert.equal(end, "ended");
});

test("a transcript line is an utterance whatever shape the agent wrote it in", () => {
  const say = (line) => {
    const u = parseUtterance(line);
    return u && [u.name, u.words, u.start, u.end];
  };
  assert.deepEqual(say("[00:00:04.300 --> 00:00:09.250] Tesi: Lawrence, share the screen."), ["Tesi", "Lawrence, share the screen.", 4.3, 9.25]);
  assert.deepEqual(say("**Speaker A** [00:12]: Ship it."), ["Speaker A", "Ship it.", 12, null]);
  assert.deepEqual(say("- **Speaker B**: ok"), ["Speaker B", "ok", null, null]);
  assert.deepEqual(say("**Ada:** at 10:30 we meet"), ["Ada", "at 10:30 we meet", null, null]);
  assert.deepEqual(say("1:02:05 Grace: yes"), ["Grace", "yes", 3725, null]);
  assert.equal(say("- see https://example.com"), null);
  // Rebuilt from its parts, a corrected line keeps its time and markup.
  const u = parseUtterance("**Speaker A** [00:12]: Ship it.");
  assert.equal(u.prefix + "Ada" + u.mid + "Ship it today.", "**Ada** [00:12]: Ship it today.");
  assert.deepEqual(partsOf("**Ada** [00:12]: Ship it today.", u), { name: "Ada", words: "Ship it today." });
  assert.equal(clock(4.3), "0:04");
  assert.equal(clock(3725), "1:02:05");
});

test("the transcript's rows skip front matter and the metadata above it, and keep a speaker who speaks once", () => {
  const text = "---\ntitle: Sync\n---\n# Sync transcript\n\n- **Duration:** 38\n- **Source:** mic\n\nAda: one\nGrace: two\nAda: three\n";
  const rows = transcriptRows(text).map(({ n, u }) => `${n}:${u ? u.name : "-"}`);
  assert.deepEqual(rows, ["3:-", "4:-", "5:-", "6:-", "7:-", "8:Ada", "9:Grace", "10:Ada", "11:-"]);
});

test("a correction shows what was struck and what was written in", () => {
  const marks = (a, b) => marksToHtml(diffMarks(a, b));
  assert.equal(marks("Lawrence, you have to", "Lorentz, you have to"), "<del>Lawrence</del><ins>Lorentz</ins>, you have to");
  assert.equal(marks("we use wasm air now", "we use Wasmer now"), "we use <del>wasm air</del><ins>Wasmer</ins> now");
  assert.equal(marks("same", "same"), "same");
});

test("a fix of one word or name is offered everywhere, not a fix of case or of several places", () => {
  assert.deepEqual(singleChange("Lawrence, you have to", "Lorentz, you have to"), { from: "Lawrence", to: "Lorentz" });
  assert.deepEqual(singleChange("Lawrence's turn", "Lorentz's turn"), { from: "Lawrence", to: "Lorentz" });
  assert.deepEqual(singleChange("we use wasm air now", "we use Wasmer now"), { from: "wasm air", to: "Wasmer" });
  assert.equal(singleChange("may we", "May we"), null);
  assert.equal(singleChange("a b c", "x b y"), null);
  assert.equal(singleChange("at 12 sharp", "at 13 sharp"), null);
  assert.equal(singleChange("and the plan", "and a plan"), null);
  assert.deepEqual(singleChange("ask Bob now", "ask Rob now"), { from: "Bob", to: "Rob" });
  assert.equal(singleChange("ok", "ok"), null);
});

test("corrections are undone a step at a time, and a line set back is no correction", () => {
  const fixes = new Fixes({ transcript: "Ada: one\nGrace: two", summary: "" });
  fixes.change([{ file: "transcript", n: 0, text: "Ada: uno" }]);
  fixes.change([{ file: "transcript", n: 1, text: null }]);
  assert.equal(fixes.count, 2);
  assert.equal(fixes.text("transcript", 1), null);
  fixes.change([{ file: "transcript", n: 0, text: "Ada: one" }]);
  assert.equal(fixes.count, 1);
  fixes.undo();
  assert.equal(fixes.text("transcript", 0), "Ada: uno");
  fixes.undo();
  fixes.undo();
  assert.equal(fixes.count, 0);
  assert.equal(fixes.undo(), false);
});

test("fixing a name everywhere reaches the transcript and the summary, but not their front matter", () => {
  const fixes = new Fixes({
    transcript: "---\ntitle: With Lawrence\n---\nLawrence: hi\nAda: hi lawrence, and Lawrence's dog\nAda: Lawrenceville",
    summary: "---\ntitle: With Lawrence\n---\n- Lawrence decides\n",
  });
  const places = fixes.places("Lawrence");
  assert.deepEqual([places.transcript.count, places.summary.count], [3, 1]);
  assert.equal(offerWhere(places), "In 4 more places: 3 in the transcript, 1 in the summary.");
  assert.equal(offerWhere({ transcript: { count: 1 }, summary: { count: 0 } }), "In 1 more place in the transcript.");
  assert.equal(fixes.everywhere("Lawrence", "Lorentz"), 3);
  assert.equal(fixes.text("transcript", 3), "Lorentz: hi");
  assert.equal(fixes.text("transcript", 4), "Ada: hi Lorentz, and Lorentz's dog");
  assert.equal(fixes.text("transcript", 5), "Ada: Lawrenceville");
  assert.equal(fixes.text("summary", 3), "- Lorentz decides");
  assert.equal(fixes.text("transcript", 1), "title: With Lawrence");
  // A $ in the new word is written as it is.
  fixes.undo();
  fixes.everywhere("Lawrence", "$1");
  assert.equal(fixes.text("summary", 3), "- $1 decides");
});

test("saving puts each correction on its line as the notebook has the file now", () => {
  const filed = "Ada: one\nGrace: two\nAda: three";
  const fixes = new Fixes({ transcript: filed, summary: "" });
  fixes.change([{ file: "transcript", n: 0, text: "Ada: uno" }, { file: "transcript", n: 1, text: null }, { file: "transcript", n: 2, text: "Ada: tres" }]);
  assert.deepEqual(fixes.rebase("transcript", filed), { text: "Ada: uno\nAda: tres", lost: 0 });
  // Lines added elsewhere move nothing; a line changed elsewhere loses its correction.
  assert.deepEqual(fixes.rebase("transcript", "Bo: new\nAda: one\nGrace: two\nAda: 3"), { text: "Bo: new\nAda: uno\nAda: 3", lost: 1 });
  // A save tried again finds its corrections already made.
  assert.deepEqual(fixes.rebase("transcript", "Ada: uno\nAda: tres"), { text: "Ada: uno\nAda: tres", lost: 0 });
});

test("a conflict slivingdoc wrote into a file keeps the other side's text", () => {
  const text = "a\n<<<<<<< local\nmine\n=======\ntheirs\nand more\n>>>>>>> remote\nb\n<<<<<<< local\nunclosed";
  assert.deepEqual(resolveConflicts(text), { text: "a\ntheirs\nand more\nb\n<<<<<<< local\nunclosed", blocks: 1 });
});

test("an agent's edited copy comes back as corrections to the lines it changed, and as lines it added", () => {
  const filed = "---\ntitle: Sync\n---\nAda: one\nGrace: two wasm air\nAda: three\n";
  const fixes = new Fixes({ transcript: filed, summary: "- Decide\n" });
  fixes.change([{ file: "transcript", n: 3, text: "Ada: uno" }]);
  // The copy holds the user's correction; the agent fixed a word, split a line, and took one out.
  assert.equal(fixes.result("transcript"), "---\ntitle: Sync\n---\nAda: uno\nGrace: two wasm air\nAda: three\n");
  const copy = "---\ntitle: Sync\n---\nAda: uno\nGrace: two Wasmer\nAda: three, and\nGrace: four\n";
  const changes = fixes.adopt("transcript", copy);
  assert.deepEqual(changes, [
    { file: "transcript", n: 4, text: "Grace: two Wasmer" },
    { file: "transcript", n: 5, text: "Ada: three, and" },
    { file: "transcript", after: 5, lines: ["Grace: four"] },
  ]);
  fixes.change([...changes, ...fixes.adopt("summary", "- Decide\n- Ship on Friday\n")]);
  assert.equal(fixes.result("transcript"), copy);
  assert.equal(fixes.count, 5);
  assert.equal(fixes.marked("summary"), "- Decide\n- \uE002Ship on Friday\uE003\n");
  // The agent's step undoes as one, leaving the user's own correction.
  fixes.undo();
  assert.equal(fixes.count, 1);
  assert.deepEqual(fixes.adopt("transcript", fixes.result("transcript")), []);
  // A line taken out is struck, its list marker kept.
  const summary = new Fixes({ summary: "- Keep\n- Drop me\n" });
  summary.change(summary.adopt("summary", "- Keep\n"));
  assert.equal(summary.marked("summary"), "- Keep\n- \uE000Drop me\uE001\n");
});

test("lines an agent added are saved after their line as the notebook has it, once", () => {
  const filed = "a\nb\nc";
  const fixes = new Fixes({ transcript: filed });
  fixes.change(fixes.adopt("transcript", "top\na\nb\nb2\nc"));
  assert.deepEqual(fixes.rebase("transcript", filed), { text: "top\na\nb\nb2\nc", lost: 0 });
  assert.deepEqual(fixes.rebase("transcript", "x\na\nb\nc"), { text: "top\nx\na\nb\nb2\nc", lost: 0 });
  assert.deepEqual(fixes.rebase("transcript", "top\na\nb\nb2\nc"), { text: "top\na\nb\nb2\nc", lost: 0 });
  // Its line gone from the notebook, an added line has nowhere to go.
  assert.deepEqual(fixes.rebase("transcript", "top\na\nc"), { text: "top\na\nc", lost: 1 });
  assert.deepEqual(align(["a", "b"], ["a", "x", "b"]).map((op) => op.type), ["same", "ins", "same"]);
});

test("fixing a name everywhere reaches lines an agent added too", () => {
  const fixes = new Fixes({ transcript: "Ada: hi Lawrence", summary: "" });
  fixes.change([{ file: "transcript", after: 0, lines: ["Lawrence: hello"] }]);
  assert.equal(fixes.places("Lawrence").transcript.count, 2);
  fixes.everywhere("Lawrence", "Lorentz");
  assert.equal(fixes.result("transcript"), "Ada: hi Lorentz\nLorentz: hello");
});

test("Penelope's turn is the INPUT of her prompt, with the user's unsaved corrections in it", () => {
  const fixes = new Fixes({ transcript: "Ada: hi Lawrence\nGrace: bye", summary: "- Ship\n" });
  fixes.change([{ file: "transcript", n: 0, text: "Ada: hi Lorentz" }, { file: "transcript", n: 1, text: null }, { file: "summary", after: 0, lines: ["- Test"] }]);
  const corrections = correctionsOf(fixes);
  assert.deepEqual(corrections, [
    "transcript.md: “Ada: hi Lawrence” → “Ada: hi Lorentz”",
    "transcript.md: took out “Grace: bye”",
    "summary.md: added “- Test”",
  ]);
  assert.deepEqual(correctionsOf(fixes, 1), [corrections[0], "and 2 more"]);
  assert.equal(
    penelopeQuery({ title: "Sync", transcriptLines: 2, summaryLines: 3, corrections: corrections.slice(0, 1), request: "Fix the names" }),
    "INPUT\nMeeting: Sync\ntranscript.md: 2 lines. summary.md: 3 lines.\n" +
      "The user's unsaved corrections, already in the copies:\n- transcript.md: “Ada: hi Lawrence” → “Ada: hi Lorentz”\nRequest: Fix the names",
  );
  assert.throws(() => penelopeQuery({ title: "Sync", transcriptLines: 2, summaryLines: 3, corrections: [] }), /request is missing/);
});

test("Penelope's answer is the JSON object her prompt asks for, and what she said when she wrote none", () => {
  assert.deepEqual(parseSay('Done.\n{"say": "Fixed **Lorentz** at 0:04.", "mood": "glad"}'), { say: "Fixed **Lorentz** at 0:04.", mood: "glad" });
  assert.deepEqual(parseSay('```json\n{"say": "Who is Speaker A?", "mood": "unsure"}\n```'), { say: "Who is Speaker A?", mood: "unsure" });
  assert.deepEqual(parseSay('{"say": "Hm {odd}", "mood": "grumpy"}'), { say: "Hm {odd}", mood: "glad" });
  assert.deepEqual(parseSay("done after tool for: hello"), { say: "done after tool for: hello", mood: "glad" });
  assert.deepEqual(parseSay(""), { say: "…", mood: "glad" });
});

test("what Penelope is doing reads from the tool she calls", () => {
  assert.equal(activityOf({ name: "rg", inputs: { pattern: "Lawrence", path: "." } }), "Looking for “Lawrence”");
  assert.equal(activityOf({ name: "rows_between", inputs: { file_path: "summary.md", start_line: 3, end_line: 9 } }), "Reading lines 3 to 9 of the summary");
  assert.equal(activityOf({ name: "sed", inputs: { file_path: "transcript.md" } }), "Correcting the transcript");
  assert.equal(activityOf({ name: "write_file", inputs: { file_path: "summary.md" } }), "Rewriting the summary");
  assert.equal(activityOf({ name: "date" }), "Using date");
});

test("the agent is told to record through five minutes of silence, signed in or not", () => {
  assert.equal(SILENCE_SECONDS, 300);
  for (const connected of [true, false]) assert.match(notebookFormat(connected), /silence_timeout_seconds set to 300:/);
});

test("a hub profile that changed since it was trusted is named, so the app asks to trust it again", () => {
  const changed = "profile cchub:baalimago/meeting-transcriber: cchub:baalimago/meeting-transcriber changed to a version (sha256 1a2b…9c8d) " +
    "you have not trusted, and there is no terminal to ask in. Not running it.\n  Read it:  https://www.clai.chat/hub/baalimago/meeting-transcriber/";
  assert.equal(untrustedProfile([{ message: "something else" }, { message: changed }]), "cchub:baalimago/meeting-transcriber");
  assert.equal(untrustedProfile([{ message: "failed to create text querier: no such model" }]), null);
  assert.equal(untrustedProfile([]), null);
});

// RFC 7636 appendix B: these 32 octets make this verifier, whose S256 challenge is this.
const RFC_OCTETS = [116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121];
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("a provider sign-in's PKCE pair is RFC 7636's S256, and its state is fresh", async () => {
  assert.equal(await challengeOf(RFC_VERIFIER), RFC_CHALLENGE);
  const { verifier, challenge, state } = await pkce((n) => new Uint8Array(n === 32 ? RFC_OCTETS : Array(n).fill(255)));
  assert.equal(verifier, RFC_VERIFIER);
  assert.equal(challenge, RFC_CHALLENGE);
  assert.equal(state, "_____________________w");
  const a = await pkce();
  const b = await pkce();
  assert.match(a.verifier, /^[\w-]{43}$/);
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test("OpenRouter's sign-in page gets the callback, the challenge, S256, a key label and the state", () => {
  const url = new URL(authorizeUrl(providerById("openrouter"), { callback: "https://minutes.example/signin-callback.html", challenge: RFC_CHALLENGE, state: "s1" }));
  assert.equal(url.origin + url.pathname, "https://openrouter.ai/auth");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    callback_url: "https://minutes.example/signin-callback.html",
    code_challenge: RFC_CHALLENGE,
    code_challenge_method: "S256",
    key_label: "Minutes",
    state: "s1",
  });
});

const respond = (status, body) => async (url, init) => {
  respond.last = { url, init };
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};

test("the callback's code is traded for the key with the verifier", async () => {
  const openrouter = providerById("openrouter");
  assert.equal(await exchangeCode(openrouter, { code: "c1", verifier: RFC_VERIFIER }, respond(200, { key: "sk-or-v1-abc" })), "sk-or-v1-abc");
  assert.equal(respond.last.url, "https://openrouter.ai/api/v1/auth/keys");
  assert.equal(respond.last.init.method, "POST");
  assert.deepEqual(JSON.parse(respond.last.init.body), { code: "c1", code_verifier: RFC_VERIFIER, code_challenge_method: "S256" });
});

test("a refused or keyless exchange throws with what the provider said", async () => {
  const openrouter = providerById("openrouter");
  const refused = respond(403, { error: { message: "Invalid code or code_verifier", code: 403 } });
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, refused), /OpenRouter refused the sign-in \(403: Invalid code or code_verifier\)/);
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, respond(502, "bad gateway")), /\(502: bad gateway\)/);
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, respond(200, { id: "x" })), /OpenRouter sent no key/);
  await assert.rejects(exchangeCode(openrouter, { code: "c", verifier: "v" }, respond(200, "<html>")), /OpenRouter sent no key/);
});

test("the callback page reads an approval's code and state, or a denial's error", () => {
  assert.deepEqual(callbackMessage("?code=c1&state=s1"), { code: "c1", state: "s1", error: null });
  assert.deepEqual(callbackMessage("?error=access_denied&error_description=User+denied"), { code: null, state: null, error: "User denied" });
  assert.deepEqual(callbackMessage(""), { code: null, state: null, error: null });
});

test("the first connected provider is the one the agents run with", () => {
  assert.equal(activeProvider(new Map()), null);
  assert.equal(activeProvider(new Map([["OPENROUTER_API_KEY", "k"]])).id, "openrouter");
  assert.equal(activeProvider(new Map([["OPENROUTER_API_KEY", "k"], ["OPENAI_API_KEY", "k"]])).id, "openai");
  assert.equal(new Set(PROVIDERS.map((p) => p.stored)).size, PROVIDERS.length);
  assert.equal(providerById("openai").stored, "minutes.openai-key");
});

test("OpenRouter runs the agents on or: models; OpenAI keeps the profiles' own", () => {
  assert.equal(providerFlags(providerById("openai"), "agent"), "");
  assert.equal(providerFlags(null, "agent"), "");
  assert.equal(providerFlags(providerById("openrouter"), "agent"), `-cm 'or:openai/gpt-5.6-luna' -am '${OPENROUTER_AUDIO}'`);
  assert.equal(providerFlags(providerById("openrouter"), "penelope"), "-cm 'or:openai/gpt-6.1-sol'");
  assert.equal(withFlags("", ""), "");
  assert.equal(withFlags("-cm 'a'", ""), "-cm 'a' ");
  assert.equal(withFlags("-cm 'a'", "-cm mock_test"), "-cm 'a' -cm mock_test ");
});

test("a signed-in OpenRouter key is deleted on its page, found by the key's SHA-256", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(await providerById("openrouter").manage("abc"), "https://openrouter.ai/keys/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(providerById("openai").manage, undefined);
});
