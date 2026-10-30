// Minutes: meeting notes recorded, transcribed and filed by clai's meeting-transcriber agent,
// in a notebook slivingdoc keeps. Each button runs a program on the machine: the agent records
// (its audio_record tool starts ffmpeg), transcribes and files the notes; the app starts it,
// answers it and reads the notebook, which programs send it through /run/page/out.

import { mask } from "./hood.js";
import { notePath, renderMarkdown } from "./markdown.js";

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// Where meetings go in the notebook, which the agent reads at the top of its query: its
// profile and slivingdoc's own settings stay as they are, so the agent works the same
// elsewhere.
export const NOTEBOOK_FORMAT =
  "Notebook format for this app: keep each meeting in the slivingdoc notebook as two files, " +
  "meetings/summaries/<start>_<slug>.md and meetings/transcripts/<start>_<slug>.md, " +
  "<start> in the form 2026-10-30T08-00Z. Begin each with front matter holding title, date " +
  "(ISO 8601) and duration (minutes). Record with audio_record's dir set to /tmp/recordings, " +
  "so the audio stays out of the notebook. Name a speaker only when the recording makes clear who " +
  "it is; otherwise keep the transcription's labels (Speaker A, Speaker B) and do not ask: the app " +
  "asks the user who they are.";

export const DEFAULTS = {
  profile: "cchub:baalimago/meeting-transcriber@13",
  flags: "",
  env: "",
  notebook: "~/notebook",
  // The slivingdoc space meetings go to, when the login has it.
  space: "notes",
  // The agent's query: the format, then the meeting.
  query: (title, details) =>
    `${NOTEBOOK_FORMAT}\n\nMeeting: ${title}.${details ? ` ${details}` : ""}`,
};

// Front matter fields of a markdown file, and its body.
export function parseNote(text) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: text.slice(match[0].length) };
}

// `meetings/summaries/2026-10-30T08-00Z_daily-standup.md` → its start and a title.
export function describeFile(path) {
  const name = path.split("/").at(-1).replace(/\.md$/, "");
  const [start, ...rest] = name.split("_");
  const title = rest.join(" ").replaceAll("-", " ") || name;
  return { start, title: title.charAt(0).toUpperCase() + title.slice(1) };
}

// clai's status lines ("<time> ok: ...", "warning", "notice"), which it prints on stdout even
// with -reply-only.
const STATUS_LINE = /^\S+ \x1b\[\d+m(?:ok|warning|notice)\x1b\[0m: .*\n?/gm;

export const replyText = (stdout) => stdout.replace(STATUS_LINE, "").trim();

// `2026-10-30T08-00Z`, the start in a notebook file's name, as a Date.
export function startDate(start) {
  const match = /^(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)Z$/.exec(start ?? "");
  return match ? new Date(`${match[1]}T${match[2]}:${match[3]}:00Z`) : null;
}

// The meetings in what the list command sends: "@@ <path>" and the front matter under it.
export function parseList(body) {
  const meetings = [];
  for (const chunk of body.split(/^@@ /m).slice(1)) {
    const at = chunk.indexOf("\n");
    const path = (at < 0 ? chunk : chunk.slice(0, at)).trim();
    const { fields } = parseNote(`---\n${at < 0 ? "" : chunk.slice(at + 1).replace(/\n?---\s*$/, "")}\n---\n`);
    const file = describeFile(path);
    const date = new Date(fields.date ?? "");
    meetings.push({
      path,
      title: fields.title || file.title,
      start: file.start,
      date: Number.isNaN(date.getTime()) ? startDate(file.start) : date,
      duration: Number.parseFloat(fields.duration) || null,
    });
  }
  return meetings.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

const DAY = 24 * 60 * 60 * 1000;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// The meetings by when they were: Today, This week, Earlier (the empty groups left out).
export function groupMeetings(meetings, now = new Date()) {
  const today = dayStart(now);
  const groups = [["Today", []], ["This week", []], ["Earlier", []]];
  for (const m of meetings) {
    const day = m.date ? dayStart(m.date) : 0;
    groups[day >= today ? 0 : day > today - 7 * DAY ? 1 : 2][1].push(m);
  }
  return groups.filter(([, items]) => items.length > 0).map(([label, items]) => ({ label, items }));
}

// "Tue · 38 min", or the time for a meeting of today.
export function meetingMeta(m, now = new Date()) {
  const parts = [];
  if (m.date) {
    parts.push(dayStart(m.date) === dayStart(now)
      ? m.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : m.date.toLocaleDateString([], dayStart(now) - dayStart(m.date) < 7 * DAY ? { weekday: "short" } : { day: "numeric", month: "short" }));
  }
  if (m.duration) parts.push(`${m.duration < 1 ? "<1" : Math.round(m.duration)} min`);
  return parts.join(" · ");
}

// The summaries a reply of the agent links to, as paths under the notebook.
export function summariesIn(reply) {
  const paths = [...reply.matchAll(/\]\(([^)\s]+)\)|(file:\/\/\S+)/g)].map((m) => notePath(m[1] ?? m[2]));
  return [...new Set(paths.filter((p) => p?.startsWith("meetings/summaries/")))];
}

// The sign-in page and code in what `slivingdoc login` printed so far, once it printed them.
export function parseApproval(lines) {
  const text = lines.join("\n");
  const code = /approve the code (\S+?):/.exec(text)?.[1];
  const url = /^\s*(https:\/\/\S+)$/m.exec(text)?.[1];
  return code && url ? { code, url } : null;
}

// Who approved the login stored in slivingdoc's credentials file, if it says.
export function accountOf(credentials) {
  let found = null;
  const walk = (value) => {
    if (found || value === null || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value)) {
      if (key.toLowerCase() === "account" && typeof inner === "string") found = inner;
      else walk(inner);
    }
  };
  try {
    walk(JSON.parse(credentials));
  } catch {
    return null;
  }
  return found;
}

// The spaces `slivingdoc space` lists for the stored login, and its default space, if any
// (marked with a *).
export function parseSpaces(text) {
  const rows = [...text.matchAll(/^([ *])!? (\S+)(?: \([^)]*\))? {2,}(?:write|read)\b/gm)];
  return { names: rows.map((m) => m[2]), current: rows.find((m) => m[1] === "*")?.[2] ?? null };
}

// The speakers a transcript names by a label rather than a name, each with a line they said.
export function unknownSpeakers(transcript) {
  const found = new Map();
  const line = /^\s*(?:[-*]\s+)?\*{0,2}(Speaker [A-Z0-9]{1,2}|[Uu]nknown [Ss]peaker(?: \d+)?)\*{0,2}\s*(?:\[[^\]]*\])?\s*:\s*\*{0,2}\s*(.+)$/gm;
  for (const [, label, said] of transcript.matchAll(line)) {
    const known = found.get(label);
    if (!known) found.set(label, said.trim());
    else if (known.split(/\s+/).length < 4 && said.split(/\s+/).length >= 4) found.set(label, said.trim());
  }
  return [...found].map(([label, sample]) => ({ label, sample }));
}

// A note's body without its own leading "Summary" or "Transcript" heading, which the card has.
export function withoutHeading(body, word) {
  return body.replace(new RegExp(`^\\s*#{1,3} [^\\n]*\\b${word}\\s*\\n+`, "i"), "");
}

// A profile clai fetches from the hub or a repository, rather than a file on the machine.
export const isRemote = (profile) => /^(cchub|gh):/.test(profile);

// The hub's page for a cchub: profile, where its prompt and tools can be read.
export function profilePage(profile) {
  const m = /^cchub:([^/@\s]+)\/([^/@\s]+)/.exec(profile);
  return m ? `https://www.clai.chat/hub/${m[1]}/${m[2]}/` : null;
}

// JSON on one line: an environment variable with a newline does not reach the machine.
const compact = (json) => {
  try {
    return JSON.stringify(JSON.parse(json));
  } catch {
    return json;
  }
};

// A message from /run/page/out: its first line names its topic, and the rest is its body.
export function splitMessage(bytes) {
  const at = bytes.indexOf(10);
  const end = at < 0 ? bytes.length : at;
  return { topic: new TextDecoder().decode(bytes.subarray(0, end)), body: bytes.subarray(Math.min(bytes.length, end + 1)) };
}

// Messages hold at most 16 MB, so a recording comes in parts.
const PART = 15_000_000;

const CREDENTIALS = "~/.config/slivingdoc/credentials.json";
const STORED_LOGIN = "minutes.slivingdoc-credentials";
const STORED_TRUST = "minutes.clai-trust";
const TRUST = '"$(clai confdir)/trust.json"';

const transcriptOf = (summary) => summary.replace("meetings/summaries/", "meetings/transcripts/");

export class Minutes {
  // `machine.run(line, action)` runs a line on the machine and resolves to its status;
  // `machine.type(text)` types on its console. `hood` shows what a click ran, `model` is what
  // the machine did, `env` the variables every run gets, `audio` the inputs being captured.
  // `store` keeps the slivingdoc login in the browser: get(key), set(key, value).
  constructor({ root, machine, hood, model, env, audio, store, recordings, config }) {
    this.root = root;
    this.machine = machine;
    this.hood = hood;
    this.model = model;
    this.env = env;
    this.audio = audio;
    this.store = store;
    this.recordings = recordings;
    this.streams = new Map();
    this.login = null;
    this.trusted = null;
    this.spaces = null;
    this.connecting = true;
    this.config = { ...DEFAULTS, ...config };
    this.meetings = [];
    this.waiters = new Map();
    this.recording = null;
    this.current = null;
    this.share = null;
    this.levels = [];
    this.actions = 0;
    this.$ = (s) => document.querySelector(s);
    this.bind();
    this.render();
  }

  bind() {
    const $ = this.$;
    const secret = (form, input, name) => {
      $(form).onsubmit = (event) => {
        event.preventDefault();
        const value = $(input).value.trim();
        if (!value) return;
        this.env.set(name, value);
        $(input).value = "";
        this.render();
        if (name === "SLIVINGDOC_TOKEN") {
          this.connecting = false;
          this.refresh();
        }
      };
    };
    secret("#key-form", "#key-input", "OPENAI_API_KEY");
    secret("#notebook-form", "#token-input", "SLIVINGDOC_TOKEN");
    $("#new").onclick = () => this.show("record");
    $("#signin").onclick = () => this.signin(window.open("about:blank", "_blank"));
    $("#not-now").onclick = () => {
      this.connecting = false;
      this.render();
    };
    $("#connect").onclick = () => {
      this.connecting = !this.connecting;
      this.render();
      if (this.connecting) $("#token-input").focus();
    };
    $("#record-form").onsubmit = (event) => {
      event.preventDefault();
      this.record($("#title").value.trim() || "Meeting", $("#details").value.trim());
    };
    $("#stop").onclick = () => this.stop();
    $("#speakers").onsubmit = (event) => {
      event.preventDefault();
      const names = [...$("#speaker-rows").querySelectorAll("input")].map((i) => [i.dataset.label, i.value.trim()]);
      this.nameSpeakers(names);
    };
    $("#space-form").onsubmit = (event) => {
      event.preventDefault();
      if ($("#space").value) this.chooseSpace($("#space").value);
    };
    $("#share-tab").onclick = () => this.share?.();
    $("#history").onclick = () => this.history();
    $("#reply-form").onsubmit = (event) => {
      event.preventDefault();
      const text = $("#reply").value.trim();
      if (text) this.answer(text);
    };
    // Links to the notebook's files, in what the agent wrote, open them here.
    this.root.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[data-note]");
      if (!link) return;
      event.preventDefault();
      const path = link.dataset.note.replace("meetings/transcripts/", "meetings/summaries/");
      this.open(this.meetings.find((m) => m.path === path) ?? { path, ...describeFile(path) });
    });
  }

  get connected() {
    return this.env.has("SLIVINGDOC_TOKEN") || this.login !== null;
  }

  // Puts back the slivingdoc login this browser kept, then lists the notebook.
  async start() {
    const credentials = this.store.get(STORED_LOGIN);
    if (credentials) {
      const line = `mkdir -p ~/.config/slivingdoc && printf '%s' "$SLIVINGDOC_CREDENTIALS" > ${CREDENTIALS}`;
      const { status } = await this.run("Restore the slivingdoc login", line, {
        followUp: true, env: { SLIVINGDOC_CREDENTIALS: compact(credentials) },
      });
      if (status === 0) this.login = accountOf(credentials) ?? "signed in";
    }
    const trust = this.store.get(STORED_TRUST);
    if (trust) {
      const line = `mkdir -p "$(clai confdir)" && printf '%s' "$CLAI_TRUST" > ${TRUST}`;
      const { status } = await this.run("Restore the agent's trust", line, { followUp: true, env: { CLAI_TRUST: compact(trust) } });
      if (status === 0) this.trusted = this.store.get(STORED_TRUST + ".profile");
    }
    this.render();
    if (this.login) await this.checkSpace();
    await this.refresh(true);
  }

  get needsTrust() {
    return isRemote(this.config.profile) && this.trusted !== this.config.profile;
  }

  // clai asks on the console before it first runs a profile from the hub: the click on
  // Record is the answer, and the trust it records is kept in the browser.
  async trust() {
    const profile = this.config.profile;
    const line = `clai profiles trust ${quote(profile)} </dev/null >&2 && { echo trust; cat ${TRUST}; } > /run/page/out`;
    const { status, body } = await this.run("Trust the agent", line, { topic: "trust", followUp: true });
    if (status !== 0 || !body) {
      this.status(`clai could not fetch or trust ${profile} (exit ${status}). The peek's terminal shows why.`);
      return false;
    }
    this.store.set(STORED_TRUST, compact(body));
    this.store.set(STORED_TRUST + ".profile", profile);
    this.trusted = profile;
    return true;
  }

  // A login needs a default space before slivingdoc can pull: the app asks for one if the
  // login has none, and keeps the choice with the login.
  async checkSpace() {
    const { status, body } = await this.run("List slivingdoc spaces",
      "{ echo spaces; slivingdoc space </dev/null 2>&1; } > /run/page/out", { topic: "spaces", followUp: true });
    if (status !== 0 || body === null) {
      this.spaces = null;
      return this.status(`slivingdoc could not list the login's spaces (exit ${status}).`);
    }
    const { names, current } = parseSpaces(body);
    const space = names.includes(this.config.space) ? this.config.space : !current && names.length === 1 ? names[0] : null;
    if (space && space !== current) return this.chooseSpace(space, true);
    this.spaces = current ? null : names;
    this.render();
  }

  // `followUp` when the login's only space is chosen without asking: the caller refreshes.
  async chooseSpace(name, followUp = false) {
    const line = `slivingdoc space ${quote(name)} </dev/null >&2 && { echo credentials; cat ${CREDENTIALS}; } > /run/page/out`;
    const { status, body } = await this.run(`Use space ${name}`, line, { topic: "credentials", followUp });
    if (status !== 0 || !body) return this.status(`slivingdoc could not make ${name} the default space (exit ${status}).`);
    this.store.set(STORED_LOGIN, compact(body));
    this.spaces = null;
    this.render();
    if (!followUp) await this.refresh();
  }

  // `slivingdoc login` in the machine: its sign-in page opens in `tab` (opened by the click,
  // as only a click may open one), and once approved, the login it stored is kept here.
  async signin(tab) {
    const lines = [];
    const $ = this.$;
    this.signing = { text: "Asking slivingdoc for a sign-in page…" };
    this.render();
    this.streams.set("login", (line) => {
      lines.push(line.replace(/\n$/, ""));
      const approval = parseApproval(lines);
      if (approval && !this.signing.url) {
        this.signing = { ...approval, text: "Approve the code on slivingdoc's page, in the tab that opened." };
        if (tab && !tab.closed) tab.location.href = approval.url;
        this.render();
      }
    });
    const line = "slivingdoc login --no-browser </dev/null 2>&1 | " +
      "while IFS= read -r line; do printf 'login\n%s\n' \"$line\" > /run/page/out; done; s=${PIPESTATUS[0]}; " +
      `[ $s = 0 ] && { echo credentials; cat ${CREDENTIALS}; } > /run/page/out; exit $s`;
    const { status, body } = await this.run("Sign in to slivingdoc", line, { topic: "credentials" });
    this.streams.delete("login");
    if (status !== 0 || !body) {
      if (tab && !tab.closed && !this.signing.url) tab.close();
      this.signing = { text: `The sign-in did not finish: ${lines.filter(Boolean).at(-1) ?? `exit ${status}`}` };
      this.render();
      return;
    }
    this.store.set(STORED_LOGIN, compact(body));
    this.login = accountOf(body) ?? "signed in";
    this.signing = null;
    this.connecting = false;
    this.render();
    await this.checkSpace();
    await this.refresh();
  }

  // A message from /run/page/out: its first line says what it answers.
  receive(bytes) {
    const { topic, body: raw } = splitMessage(bytes);
    if (topic === "recording-part") return this.parts?.push(raw.slice());
    const body = new TextDecoder().decode(raw);
    this.streams.get(topic)?.(body);
    const waiter = this.waiters.get(topic);
    if (waiter) {
      this.waiters.delete(topic);
      waiter(body);
    }
  }

  // Runs `line` for the button `label`, and resolves to its status and what it sent to the
  // page under `topic`, if it names one. A `followUp` the app ran on its own leaves the hood
  // on the last click.
  async run(label, line, { topic, followUp = false, hint = "", env } = {}) {
    const action = `minutes:${label}#${++this.actions}`;
    const sent = topic ? new Promise((resolve) => this.waiters.set(topic, resolve)) : null;
    if (!followUp) this.hood.ran(label, action, line, hint);
    const status = await this.machine.run(line, action, env);
    const body = sent ? await Promise.race([sent, new Promise((r) => setTimeout(() => r(null), 2000))]) : null;
    if (topic) this.waiters.delete(topic);
    return { status, body, action };
  }

  cd() {
    return `mkdir -p ${this.config.notebook} && cd ${this.config.notebook}`;
  }

  // Pulls the notebook when connected, then lists its meetings with their front matter.
  async refresh(followUp = false) {
    // Until the login has a space, there is nothing to pull from.
    const pull = this.connected && !this.spaces ? "slivingdoc pull >&2 || echo pull-failed > /run/page/out; " : "";
    const line = `${this.cd()} && ${pull}{ echo meetings; ` +
      "for f in $(find meetings/summaries -name '*.md' 2>/dev/null); do echo \"@@ $f\"; " +
      "sed -n '1{/^---$/!q};2,/^---$/p' \"$f\" | head -20; done; } > /run/page/out";
    let pullFailed = false;
    this.streams.set("pull-failed", () => (pullFailed = true));
    const { status, body } = await this.run("Refresh", line, { topic: "meetings", followUp });
    this.streams.delete("pull-failed");
    if (status !== 0 || body === null) return this.status(`Listing the notebook failed (exit ${status}).`);
    if (!pullFailed && this.$("#status").textContent.startsWith("slivingdoc could not pull")) this.status("");
    if (pullFailed) this.status("slivingdoc could not pull the notebook, so this list is what is on this machine. The peek's terminal shows why.");
    this.meetings = parseList(body);
    this.render();
  }

  async open(meeting, followUp = false) {
    const line = `${this.cd()} && { echo meeting; cat ${quote(meeting.path)}; printf '\\0'; ` +
      `cat ${quote(transcriptOf(meeting.path))} 2>/dev/null; } > /run/page/out`;
    const { status, body } = await this.run(`Open ${meeting.title}`, line, { topic: "meeting", followUp });
    if (status !== 0 || body === null) return this.status(`Could not read ${meeting.path}.`);
    const [summary, transcript = ""] = body.split("\0");
    const note = parseNote(summary);
    this.recording = null;
    this.current = {
      ...meeting,
      title: note.fields.title || meeting.title,
      summary: note.body,
      transcript: parseNote(transcript).body,
    };
    this.historyItems = null;
    this.status("");
    this.show("meeting");
    await this.showRecording(meeting.path);
  }

  // The recording the agent made for a meeting, from the machine into the browser's storage.
  async keepRecording(path, key) {
    this.parts = [];
    const line = `${this.cd()} && f=${quote(path)}; size=$(wc -c < "$f") || exit; ` +
      `for ((at = 0; at < size; at += ${PART})); do { echo recording-part; tail -c +$((at + 1)) "$f" | head -c ${PART}; } > /run/page/out; done; ` +
      "echo recording-end > /run/page/out";
    const { status, body } = await this.run("Keep the recording", line, { topic: "recording-end", followUp: true });
    const parts = this.parts;
    this.parts = null;
    if (status !== 0 || body === null) return this.status(`Could not read the recording ${path} (exit ${status}).`);
    if (!(await this.recordings.put(key, new Blob(parts, { type: "audio/wav" })))) {
      this.status("This browser keeps no storage, so the recording is not kept.");
    }
  }

  async showRecording(key) {
    const audio = this.$("#recording");
    const blob = key === null ? null : await this.recordings.get(key);
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.hidden = !blob;
    if (blob) audio.src = URL.createObjectURL(blob);
    else audio.removeAttribute("src");
  }

  async history() {
    if (!this.connected) {
      this.historyItems = ["Connect slivingdoc to keep a history of the notebook."];
      return this.render();
    }
    const line = `${this.cd()} && { echo history; slivingdoc log --limit 10; } > /run/page/out`;
    const { body } = await this.run("History", line, { topic: "history" });
    this.historyItems = (body ?? "").split("\n").filter(Boolean);
    this.render();
  }

  agentLine(query, reply) {
    const c = this.config;
    const env = c.env ? `${c.env} ` : "";
    const flags = c.flags ? `${c.flags} ` : "";
    // slivingdoc's server then keeps the notebook the agent's file tools write in.
    const root = this.connected ? 'SLIVINGDOC_WORKSPACE_ROOT="$PWD" ' : "";
    return `${this.cd()} && { echo reply; ${root}${env}clai -reply-only ${reply ? "-dre " : ""}-profile-path ${c.profile} ` +
      `${flags}query ${quote(query)}; } > /run/page/out`;
  }

  async record(title, details) {
    if (!this.env.has("OPENAI_API_KEY") && !this.config.flags) {
      return this.status("Add your OpenAI key first.");
    }
    if (this.spaces) return this.status("Choose the slivingdoc space for your meetings first.");
    this.status("");
    if (this.needsTrust && !(await this.trust())) return;
    // Nothing of the last meeting carries over: its notes, recording, history or the form's text.
    this.current = null;
    this.historyItems = null;
    this.levels = [];
    this.share = null;
    this.$("#title").value = "";
    this.$("#details").value = "";
    this.renderWave();
    this.recording = { title, startedAt: new Date(), started: null, stages: new Set() };
    this.show("meeting");
    await this.showRecording(null);
    const line = this.agentLine(this.config.query(title, details), false);
    const unwatch = this.watchStages("Record");
    const { status, body } = await this.run("Record", line, {
      topic: "reply",
      hint: "Stop and summarize types Enter on the console, which ends the agent's recording.",
    });
    unwatch();
    await this.finish(status, body);
  }

  async answer(text) {
    this.$("#reply").value = "";
    this.recording = { ...(this.recording ?? { title: this.current?.title ?? "Meeting" }), stages: new Set(), answering: true, done: false };
    this.show("meeting");
    const unwatch = this.watchStages("Answer");
    const { status, body } = await this.run("Answer", this.agentLine(text, true), { topic: "reply" });
    unwatch();
    await this.finish(status, body);
  }

  // Names for the speakers the transcript only labels: the agent, in the same conversation,
  // rewrites both notes with them.
  async nameSpeakers(names) {
    const c = this.current;
    const given = names.filter(([, name]) => name);
    if (!c || given.length === 0) return;
    const text = `Rename the speakers in ${transcriptOf(c.path)} and ${c.path}: ` +
      given.map(([label, name]) => `"${label}" is ${name}`).join("; ") +
      ". Where one label covers several voices, tell them apart from what each line says. Keep everything else, " +
      "including the front matter, and save both files to the notebook again.";
    this.recording = { title: c.title, startedAt: new Date(), stages: new Set(), answering: true, done: false, path: c.path };
    this.show("meeting");
    const { status, body } = await this.run("Name the speakers", this.agentLine(text, true), { topic: "reply" });
    await this.finish(status, body);
  }

  // The agent is done: the notes it filed open, else what it said shows.
  async finish(status, body) {
    const r = this.recording;
    r.done = true;
    r.status = status;
    r.reply = replyText(body ?? "");
    this.render();
    if (status !== 0) return;
    if (this.connected) await this.save(r.title);
    const before = new Set(this.meetings.map((m) => m.path));
    await this.refresh(true);
    const linked = summariesIn(r.reply);
    const filed = this.meetings.find((m) => linked.includes(m.path)) ??
      this.meetings.find((m) => !before.has(m.path)) ??
      this.meetings.find((m) => m.path === r.path);
    if (filed) {
      await this.open(filed, true);
      if (r.audioPath) {
        await this.keepRecording(r.audioPath, filed.path);
        await this.showRecording(filed.path);
      }
      this.recording = r;
      this.render();
    }
  }

  // Publishes what the agent filed, whether or not it committed through its notes tools.
  async save(title) {
    this.recording.stages.add("saving");
    const line = `${this.cd()} && slivingdoc commit -m ${quote(`Minutes: ${title}`)} >&2`;
    const { status } = await this.run("Save to slivingdoc", line, { followUp: true });
    if (status !== 0) {
      this.status("slivingdoc could not save the notes, so they are only on this machine. The peek's terminal shows why.");
      return false;
    }
    return true;
  }

  // Enter ends the recording: the agent's audio_record waits for it on the console.
  stop() {
    this.machine.type("\r");
    this.$("#stop").disabled = true;
  }

  // The tab sharing the audio input waits for: `share()` from a click, or null.
  offerShare(share) {
    this.share = share;
    this.render();
  }

  // The loudness of the latest samples, 0 to 1, for the waveform.
  level(value) {
    this.levels.push(value);
    if (this.levels.length > 64) this.levels.shift();
    if (this.waving) return;
    this.waving = true;
    requestAnimationFrame(() => {
      this.waving = false;
      this.renderWave();
    });
  }

  // Follows the processes of the run for `label`, which starts next, to tell where the agent
  // is: the ffmpeg that records (the ones that list devices take no -i), then a connection to
  // OpenAI, then one of slivingdoc's, which pushes the notebook.
  watchStages(label) {
    const action = `minutes:${label}#${this.actions + 1}`;
    const listener = (events) => {
      const r = this.recording;
      if (!r || r.done) return;
      const ffmpeg = this.model.find(action, "ffmpeg").filter((p) => p.argv.includes("-i")).at(-1);
      if (ffmpeg) {
        r.stages.add("recording");
        r.started ??= ffmpeg.start;
        if (ffmpeg.end !== null) {
          r.stages.add("recorded");
          r.recordedAt ??= ffmpeg.end;
          // clai records into a .part file and renames it once the recording is whole.
          r.audioPath ??= ffmpeg.argv.at(-1).replace(/\.part$/, "");
        }
      }
      const mine = (pid) => this.model.procs.get(pid)?.action === action;
      for (const e of events) {
        if (e.type === "connect" && e.host === "api.openai.com" && mine(e.pid) && r.stages.has("recorded")) {
          r.stages.add("transcribing");
        }
        if (e.type === "connect" && mine(e.pid) && r.stages.has("recorded") &&
          this.model.procs.get(e.pid).name.startsWith("slivingdoc")) {
          r.stages.add("saving");
        }
      }
      this.renderRecording();
    };
    this.model.onChange(listener);
    const timer = setInterval(() => this.renderRecording(), 500);
    return () => {
      this.model.listeners.delete(listener);
      clearInterval(timer);
    };
  }

  status(text) {
    this.$("#status").textContent = text;
  }

  show(view) {
    this.view = view;
    this.render();
  }

  render() {
    const $ = this.$;
    const keyed = this.env.has("OPENAI_API_KEY");
    $("#key-chip").textContent = keyed ? `OpenAI key: ${mask(`KEY=${this.env.get("OPENAI_API_KEY")}`).slice(4)}` : "OpenAI key: not set";
    $("#notebook-chip").textContent = this.login ? `slivingdoc: ${this.login}` : this.connected ? "slivingdoc: connected" : "slivingdoc: local notebook";
    $("#key-form").hidden = keyed;
    $("#notebook-card").hidden = this.connected || !this.connecting;
    $("#signin").disabled = Boolean(this.signing);
    $("#signin-wait").hidden = !this.signing;
    if (this.signing) {
      $("#signin-text").textContent = this.signing.text;
      $("#signin-code").textContent = this.signing.code ?? "…";
      $("#signin-link").hidden = !this.signing.url;
      if (this.signing.url) $("#signin-link").href = this.signing.url;
    }
    $("#connect").hidden = this.connected;
    $("#space-form").hidden = !this.spaces;
    if (this.spaces && $("#space").options.length !== this.spaces.length) {
      $("#space").replaceChildren(...this.spaces.map((name) => new Option(name, name)));
    }
    const page = profilePage(this.config.profile);
    $("#trust-note").hidden = !this.needsTrust;
    $("#trust-profile").textContent = this.config.profile;
    $("#trust-link").hidden = !page;
    if (page) $("#trust-link").href = page;
    $("#record-form > .primary").textContent = this.needsTrust ? "Trust the agent and start recording" : "Start recording";
    $("#notebook-status").textContent = this.connected ? "Notebook: slivingdoc" : "Notebook: in this tab";
    for (const view of this.root.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== (this.view ?? "record");
    this.renderList();
    this.renderMeeting();
    this.renderRecording();
  }

  renderList() {
    const list = this.$("#meetings");
    list.replaceChildren();
    for (const { label, items } of groupMeetings(this.meetings)) {
      const head = document.createElement("div");
      head.className = "sidehead";
      head.textContent = label;
      list.append(head);
      for (const meeting of items) {
        const button = document.createElement("button");
        button.className = "meeting";
        if (this.current?.path === meeting.path) button.setAttribute("aria-current", "true");
        const title = document.createElement("strong");
        title.textContent = meeting.title;
        const meta = document.createElement("span");
        meta.textContent = meetingMeta(meeting);
        button.append(title, meta);
        button.onclick = () => this.open(meeting);
        list.append(button);
      }
    }
    this.$("#empty").hidden = this.meetings.length > 0;
  }

  renderMeeting() {
    const $ = this.$;
    const r = this.recording;
    const c = this.current;
    $("#meeting-title").textContent = c?.title ?? r?.title ?? "Meeting";
    const meta = c ? meetingMeta(c) : r ? `Today · started ${r.startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    $("#meeting-meta").textContent = meta;
    const summary = $("#summary");
    const transcript = $("#transcript");
    if (c) {
      summary.innerHTML = renderMarkdown(withoutHeading(c.summary, "summary") || "_The summary is empty._");
      transcript.innerHTML = renderMarkdown(withoutHeading(c.transcript, "transcript") || "_No transcript in the notebook for this meeting._");
    } else {
      summary.innerHTML = renderMarkdown("_Written by the agent when you stop the recording._");
      transcript.innerHTML = renderMarkdown("_Transcribed with speaker labels when the recording stops._");
    }
    $("#saved").hidden = !c;
    const busy = r && !r.done;
    const unknown = c && !busy ? unknownSpeakers(c.transcript) : [];
    const form = $("#speakers");
    form.hidden = unknown.length === 0;
    const key = unknown.map((u) => u.label).join("\n");
    if (form.dataset.key !== key || form.dataset.path !== c?.path) {
      form.dataset.key = key;
      form.dataset.path = c?.path ?? "";
      $("#speaker-rows").replaceChildren(...unknown.map(({ label, sample }) => {
        const row = document.createElement("label");
        row.className = "speaker";
        const who = document.createElement("strong");
        who.textContent = label;
        const quote = document.createElement("q");
        quote.textContent = sample.length > 90 ? `${sample.slice(0, 90)}…` : sample;
        const input = document.createElement("input");
        input.dataset.label = label;
        input.placeholder = "Name, or names if several voices";
        row.append(who, quote, input);
        return row;
      }));
    }
    $("#saved-path").textContent = c?.path ?? "";
    const history = $("#history-list");
    history.hidden = !this.historyItems;
    history.replaceChildren(...(this.historyItems ?? []).map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }));
  }

  renderRecording() {
    const $ = this.$;
    const r = this.recording;
    const busy = r && !r.done;
    $("#recbar").hidden = !busy;
    $("#stages").hidden = !busy;
    const live = Boolean(busy && r.stages.has("recording") && !r.stages.has("recorded"));
    $("#stop").hidden = !live;
    $("#stop").disabled = !live;
    $("#share-tab").hidden = !(live && this.share);
    $("#agent").hidden = !(r?.done && (r.status !== 0 || !this.current));
    $("#agent-text").innerHTML = r?.done
      ? renderMarkdown(r.status === 0 ? r.reply || "_The agent said nothing._" : `The agent stopped with exit status ${r.status}. ${r.reply ?? ""}`)
      : "";
    if (!busy) return;
    const seconds = r.started ? Math.max(0, Math.round(((r.recordedAt ?? Date.now()) - r.started) / 1000)) : 0;
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    const state = $("#rec-state");
    state.classList.toggle("live", live);
    $("#recbar").classList.toggle("waiting", !live && !r.stages.has("recorded"));
    $("#recbar").classList.toggle("summarizing", r.stages.has("recorded"));
    state.textContent = live ? `Recording ${clock}` : r.stages.has("recorded") ? `Recorded ${clock}` : r.answering ? "The agent is working…" : "Starting the agent…";
    const inputs = this.audio?.inputs() ?? [];
    const tab = inputs.find((i) => i.name === "tab");
    const recorded = inputs.filter((i) => i.name !== "tab" || i.live).map((i) => i.name === "tab" ? "meeting tab" : i.label);
    $("#rec-inputs").textContent = (recorded.join(" + ") || "Mic") + (tab && !tab.live ? " · no tab shared yet" : "");
    const stages = [
      ["recording", "Recording"],
      ["recorded", "Recorded"],
      ["transcribing", "Transcribing with OpenAI"],
      ["saving", "Saving to slivingdoc"],
    ].filter(([key]) => key !== "saving" || this.connected);
    $("#stages").replaceChildren(...stages.map(([key, text]) => {
      const li = document.createElement("li");
      li.className = r.stages.has(key) ? "done" : "";
      li.textContent = text;
      return li;
    }));
  }

  renderWave() {
    const wave = this.$("#wave");
    const bars = this.levels.map((level) => {
      const bar = document.createElement("span");
      bar.style.height = `${Math.max(3, Math.round(level * 32))}px`;
      return bar;
    });
    wave.replaceChildren(...bars);
  }
}
