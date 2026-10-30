// Minutes, the app half: meeting notes recorded, transcribed and filed by clai's
// meeting-transcriber agent, in a notebook slivingdoc keeps. Every button runs a line on the
// machine, in the terminal, as if typed: the agent records (its audio_record tool starts
// ffmpeg), transcribes and files the notes; the app only starts it, answers it and reads the
// notebook. Read commands send their output to /run/page/out instead of the terminal.

import { mask } from "./hood.js";

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

export class Minutes {
  // `machine` runs lines and types on the terminal; `hood` shows what a line did.
  constructor({ root, machine, hood, model, env, showTab, config }) {
    this.root = root;
    this.machine = machine;
    this.hood = hood;
    this.model = model;
    this.env = env;
    this.showTab = showTab;
    this.config = { ...DEFAULTS, ...config };
    this.meetings = [];
    this.waiters = new Map();
    this.recording = null;
    this.actions = 0;
    this.$ = (s) => root.querySelector(s);
    this.bind();
    this.render();
  }

  bind() {
    const $ = this.$;
    $("#key-form").onsubmit = (event) => {
      event.preventDefault();
      const key = $("#key-input").value.trim();
      if (!key) return;
      this.env.set("OPENAI_API_KEY", key);
      $("#key-input").value = "";
      this.render();
    };
    $("#connect").onclick = () => this.connect();
    $("#refresh").onclick = () => this.refresh();
    $("#new").onclick = () => this.show("record");
    $("#record-form").onsubmit = (event) => {
      event.preventDefault();
      this.record($("#title").value.trim() || "Meeting", $("#details").value.trim());
    };
    $("#stop").onclick = () => this.stop();
    $("#reply-form").onsubmit = (event) => {
      event.preventDefault();
      const text = $("#reply").value.trim();
      if (text) this.answer(text);
    };
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
  // on the line of the last click.
  async run(label, line, topic, followUp = false) {
    const action = `minutes:${label}#${++this.actions}`;
    const sent = topic ? new Promise((resolve) => this.waiters.set(topic, resolve)) : null;
    if (!followUp) this.hood.ran(label, action, line);
    const status = await this.machine.run(line, action, label);
    const body = sent ? await Promise.race([sent, new Promise((r) => setTimeout(() => r(null), 2000))]) : null;
    if (topic) this.waiters.delete(topic);
    return { status, body, action };
  }

  cd() {
    return `mkdir -p ${this.config.notebook} && cd ${this.config.notebook}`;
  }

  async connect() {
    this.status("Sign in to slivingdoc in the terminal: open the link it prints.");
    this.showTab("terminal");
    const { status } = await this.run("Connect notebook", `${this.cd()} && slivingdoc login`);
    this.connected = status === 0;
    this.status(this.connected ? "Notebook connected." : `slivingdoc login exited with ${status}.`);
    if (this.connected) await this.refresh(true);
    this.render();
  }

  // Pulls the notebook when connected, then lists its meetings.
  async refresh(followUp = false) {
    const pull = this.connected ? "slivingdoc pull >&2 && " : "";
    const line = `${this.cd()} && ${pull}{ echo meetings; ` +
      "find meetings/summaries -name '*.md' 2>/dev/null | sort -r; } > /run/page/out";
    const { status, body } = await this.run("Refresh meetings", line, "meetings", followUp);
    if (status !== 0 || body === null) {
      this.status(`Listing the notebook failed (exit ${status}); see the terminal.`);
      return;
    }
    this.meetings = body.split("\n").filter(Boolean).map((path) => ({ path, ...describeFile(path) }));
    this.render();
  }

  async open(meeting) {
    const transcript = meeting.path.replace("/summaries/", "/transcripts/");
    const line = `${this.cd()} && { echo meeting; cat ${quote(meeting.path)}; } > /run/page/out`;
    const { status, body } = await this.run(`Open ${meeting.title}`, line, "meeting");
    if (status !== 0 || body === null) return this.status(`Could not read ${meeting.path}.`);
    const note = parseNote(body);
    this.current = { ...meeting, ...note, transcript };
    this.show("meeting");
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
    this.recording = { title, started: null, stages: new Set() };
    this.show("recording");
    const line = this.agentLine(this.config.query(title, details), false);
    const unwatch = this.watchStages("Record");
    const { status, body } = await this.run("Record", line, "reply");
    unwatch();
    this.finish(status, body);
  }

  async answer(text) {
    this.$("#reply").value = "";
    this.recording = { ...(this.recording ?? {}), stages: new Set(), answering: true };
    this.show("recording");
    const unwatch = this.watchStages("Answer the agent");
    const { status, body } = await this.run("Answer the agent", this.agentLine(text, true), "reply");
    unwatch();
    this.finish(status, body);
  }

  finish(status, body) {
    this.recording.done = true;
    this.recording.status = status;
    this.recording.reply = replyText(body ?? "");
    this.render();
    if (status === 0) this.refresh(true);
  }

  // Enter ends the recording: the agent's audio_record waits for it on the terminal.
  stop() {
    this.machine.type("\r");
    this.$("#stop").disabled = true;
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
        if (ffmpeg.end !== null) r.stages.add("recorded");
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
    document.querySelector("#key-chip").textContent = keyed ? `OpenAI key: ${mask(`KEY=${this.env.get("OPENAI_API_KEY")}`).slice(4)}` : "OpenAI key: not set";
    document.querySelector("#notebook-chip").textContent = this.connected ? "slivingdoc: signed in" : "slivingdoc: not connected";
    $("#key-form").hidden = keyed;
    for (const view of this.root.querySelectorAll("[data-view]")) view.hidden = view.dataset.view !== (this.view ?? "record");
    const list = $("#meetings");
    list.replaceChildren();
    for (const meeting of this.meetings) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.className = "meeting";
      const title = document.createElement("strong");
      title.textContent = meeting.title;
      const start = document.createElement("span");
      start.textContent = meeting.start;
      button.append(title, start);
      button.onclick = () => this.open(meeting);
      li.append(button);
      list.append(li);
    }
    $("#empty").hidden = this.meetings.length > 0;
    if (this.view === "meeting" && this.current) {
      $("#meeting-title").textContent = this.current.fields.title ?? this.current.title;
      $("#meeting-meta").textContent = [this.current.fields.date ?? this.current.start,
        this.current.fields.duration && `${this.current.fields.duration} min`].filter(Boolean).join(" · ");
      $("#meeting-body").textContent = this.current.body;
      $("#meeting-path").textContent = this.current.path;
    }
    this.renderRecording();
  }

  renderRecording() {
    const r = this.recording;
    const $ = this.$;
    if (!r) return;
    $("#rec-title").textContent = r.title ?? "Meeting";
    const live = r.stages.has("recording") && !r.stages.has("recorded");
    $("#stop").hidden = !live;
    $("#stop").disabled = !live;
    const seconds = r.started ? Math.max(0, Math.round(((r.stages.has("recorded") ? r.recordedAt ??= Date.now() : Date.now()) - r.started) / 1000)) : 0;
    $("#rec-timer").classList.toggle("live", live);
    $("#rec-timer").textContent = live ? `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` :
      r.done ? (r.status === 0 ? "Done" : `The agent exited with ${r.status}; see the terminal`) : "Starting the agent…";
    const stages = [
      ["recording", "Recording"],
      ["recorded", "Recorded"],
      ["transcribing", "Transcribed with OpenAI"],
      ["saving", "Saved to the notebook"],
    ];
    const list = $("#stages");
    list.replaceChildren();
    for (const [key, label] of stages) {
      const li = document.createElement("li");
      li.className = r.stages.has(key) ? "done" : "";
      li.textContent = label;
      list.append(li);
    }
    $("#agent-reply").hidden = !r.done;
    $("#agent-text").textContent = r.reply ?? "";
  }
}
