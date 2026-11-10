// The page's logic that needs no browser: the under-the-hood model the kernel's events build,
// and how Minutes reads the notebook and the agent's reply.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Machine, describe, label, mask } from "./www/hood.js";
import { notePath, renderMarkdown } from "./www/markdown.js";
import { STEPS, stepsFor, stepsOver } from "./www/arrival.js";
import { groupLines, writingMs } from "./www/pen.js";
import { wrapWords } from "./www/doodles.js";
import { isShellLine } from "./www/shell.js";
import { AudioInputs, audioLimits, platformOf, withOsVersion } from "./www/audio.js";
import { AgentRun, brief, problemOf, toolProblem } from "./www/agent.js";
import {
  DEFAULTS, accountOf, precheck, notebookFormat, describeFile, groupMeetings, isRemote, meetingMeta, parseApproval, parseList, parseNote,
  parseSpaces, profilePage, signoutResult, splitMessage, summariesIn, unknownSpeakers,
  withoutHeading,
} from "./www/minutes.js";

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

test("the checklist asks for the mic, then a share, then sound, and only then may a recording start", () => {
  const none = precheck({ mic: null, computer: null }, "Share a tab", {});
  assert.deepEqual(ticks(none), ["  Allow the mic >", "  Share a tab with your call >", "  Hear the call's sound"]);
  assert.equal(none.ready, false);
  const shared = { mic: "Mic", computer: { label: "Shared tab", via: "share" } };
  assert.deepEqual(ticks(precheck(shared, "Share a tab", {})), ["x Mic: Mic", "x Computer audio: Shared tab", "  Listening for sound…"]);
  assert.equal(precheck(shared, "Share a tab", {}).ready, false);
  assert.equal(precheck(shared, "Share a tab", { silent: true }).items[2].text, "No sound yet. Unmute the call or press play.");
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
