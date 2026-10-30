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
  "(ISO 8601) and duration (minutes).";

export const DEFAULTS = {
  profile: "cchub:baalimago/meeting-transcriber@13",
  flags: "",
  env: "",
  notebook: "~/notebook",
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

const transcriptOf = (summary) => summary.replace("meetings/summaries/", "meetings/transcripts/");

export class Minutes {
  // `machine.run(line, action)` runs a line on the machine and resolves to its status;
  // `machine.type(text)` types on its console. `hood` shows what a click ran, `model` is what
  // the machine did, `env` the variables every run gets, `audio` the inputs being captured.
  constructor({ root, machine, hood, model, env, audio, config }) {
    this.root = root;
    this.machine = machine;
    this.hood = hood;
    this.model = model;
    this.env = env;
    this.audio = audio;
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
    return this.env.has("SLIVINGDOC_TOKEN");
  }

  // A message from /run/page/out: its first line says what it answers.
  receive(bytes) {
    const text = new TextDecoder().decode(bytes);
    const at = text.indexOf("\n");
    const [topic, body] = at < 0 ? [text, ""] : [text.slice(0, at), text.slice(at + 1)];
    const waiter = this.waiters.get(topic);
    if (waiter) {
      this.waiters.delete(topic);
      waiter(body);
    }
  }

  // Runs `line` for the button `label`, and resolves to its status and what it sent to the
  // page under `topic`, if it names one. A `followUp` the app ran on its own leaves the hood
  // on the last click.
  async run(label, line, { topic, followUp = false, hint = "" } = {}) {
    const action = `minutes:${label}#${++this.actions}`;
    const sent = topic ? new Promise((resolve) => this.waiters.set(topic, resolve)) : null;
    if (!followUp) this.hood.ran(label, action, line, hint);
    const status = await this.machine.run(line, action);
    const body = sent ? await Promise.race([sent, new Promise((r) => setTimeout(() => r(null), 2000))]) : null;
    if (topic) this.waiters.delete(topic);
    return { status, body, action };
  }

  cd() {
    return `mkdir -p ${this.config.notebook} && cd ${this.config.notebook}`;
  }

  // Pulls the notebook when connected, then lists its meetings with their front matter.
  async refresh(followUp = false) {
    const pull = this.connected ? "slivingdoc pull >&2; " : "";
    const line = `${this.cd()} && ${pull}{ echo meetings; ` +
      "for f in $(find meetings/summaries -name '*.md' 2>/dev/null); do echo \"@@ $f\"; " +
      "sed -n '1{/^---$/!q};2,/^---$/p' \"$f\" | head -20; done; } > /run/page/out";
    const { status, body } = await this.run("Refresh", line, { topic: "meetings", followUp });
    if (status !== 0 || body === null) return this.status(`Listing the notebook failed (exit ${status}).`);
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
    return `${this.cd()} && { echo reply; ${env}clai -reply-only ${reply ? "-re " : ""}-profile-path ${c.profile} ` +
      `${flags}query ${quote(query)}; } > /run/page/out`;
  }

  async record(title, details) {
    if (!this.env.has("OPENAI_API_KEY") && !this.config.flags) {
      return this.status("Add your OpenAI key first.");
    }
    this.status("");
    this.current = null;
    this.levels = [];
    this.recording = { title, startedAt: new Date(), started: null, stages: new Set() };
    this.show("meeting");
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

  // The agent is done: the notes it filed open, else what it said shows.
  async finish(status, body) {
    const r = this.recording;
    r.done = true;
    r.status = status;
    r.reply = replyText(body ?? "");
    this.render();
    if (status !== 0) return;
    const before = new Set(this.meetings.map((m) => m.path));
    await this.refresh(true);
    const linked = summariesIn(r.reply);
    const filed = this.meetings.find((m) => linked.includes(m.path)) ??
      this.meetings.find((m) => !before.has(m.path));
    if (filed) {
      await this.open(filed, true);
      this.recording = r;
      this.render();
    }
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
    $("#notebook-chip").textContent = this.connected ? "slivingdoc: connected" : "slivingdoc: local notebook";
    $("#key-form").hidden = keyed;
    $("#notebook-form").hidden = this.connected || !this.connecting;
    $("#connect").hidden = this.connected;
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
      summary.innerHTML = renderMarkdown(c.summary || "_The summary is empty._");
      transcript.innerHTML = renderMarkdown(c.transcript || "_No transcript in the notebook for this meeting._");
    } else {
      summary.innerHTML = renderMarkdown("_Written by the agent when you stop the recording._");
      transcript.innerHTML = renderMarkdown("_Transcribed with speaker labels when the recording stops._");
    }
    $("#saved").hidden = !c;
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
    state.textContent = live ? `Recording ${clock}` : r.stages.has("recorded") ? `Recorded ${clock}` : r.answering ? "The agent is working…" : "Starting the agent…";
    const inputs = this.audio?.inputs() ?? [];
    const tab = inputs.find((i) => i.name === "tab");
    $("#rec-inputs").textContent = tab ? (tab.live ? "Mic + meeting tab" : "Mic · no tab shared yet") : "Mic";
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
