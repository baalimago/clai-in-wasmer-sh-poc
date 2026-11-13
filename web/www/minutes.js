// Minutes: meeting notes recorded, transcribed and filed by clai's meeting-transcriber agent,
// in a notebook slivingdoc keeps. Each button runs a program on the machine: the agent records
// (its audio_record tool starts ffmpeg), transcribes and files the notes; the app starts it,
// answers it and reads the notebook, which programs send it through /run/page/out.

import { mask } from "./hood.js";
import { notePath, renderMarkdown } from "./markdown.js";
import { audioLimits } from "./audio.js";
import { AgentRun, problemOf, toolProblem } from "./agent.js";
import { RecordPrinter } from "./records.js";
import { Fixes, Proofreader, isLabel, marksToHtml, offerWhere, resolveConflicts, singleChange, transcriptRows } from "./proofread.js";
import { Penelope, correctionsOf, penelopeQuery, parseSay } from "./penelope.js";
import { PROVIDERS, SIGNIN_CHANNEL, activeProvider, authorizeUrl, exchangeCode, pkce, providerById, providerFlags } from "./providers.js";

const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// clai flags joined, with the space before what follows them, or "".
export const withFlags = (...flags) => {
  const line = flags.filter(Boolean).join(" ");
  return line ? `${line} ` : "";
};

// Where meetings go, which the agent reads at the top of its query: its profile and slivingdoc's
// own settings stay as they are, so the agent works the same elsewhere. Signed out of
// slivingdoc, the notes stay in the browser's notebook, and that is the user's choice: the agent
// neither looks for slivingdoc nor asks them to sign in.
// The model's own pick overrides audioConfig.json, and a 15 s pick ended two real meetings: pin it.
export const SILENCE_SECONDS = 300;
// How long a recorded shared tab may stay silent before the app asks if it is the right one.
export const QUIET_MS = 60_000;
const MEETING_FILES =
  "meetings/summaries/<start>_<slug>.md and meetings/transcripts/<start>_<slug>.md, " +
  "<start> in the form 2026-10-30T08-00Z. Begin each with front matter holding title, date " +
  "(ISO 8601) and duration (minutes). Record with audio_record's dir set to /tmp/recordings, " +
  `so the audio stays out of the notebook, and its silence_timeout_seconds set to ${SILENCE_SECONDS}: ` +
  "a meeting has quiet stretches, and the user stops the recording. Name a speaker only when the recording makes clear who " +
  "it is; otherwise keep the transcription's labels (Speaker A, Speaker B) and do not ask: the app " +
  "asks the user who they are.";

export function notebookFormat(connected) {
  return connected
    ? `Notebook format for this app: keep each meeting in the slivingdoc notebook as two files, ${MEETING_FILES}`
    : "Notebook format for this app: the user keeps their notes on this machine and chose not to sign in to " +
      "slivingdoc. Do not use slivingdoc, do not mention it and do not ask the user to sign in. Write each " +
      `meeting as two files in the current directory, which is the notebook: ${MEETING_FILES}`;
}

export const DEFAULTS = {
  // No version tag: the hub serves the profile's latest release.
  profile: "cchub:baalimago/meeting-transcriber",
  flags: "",
  env: "",
  notebook: "~/notebook",
  // The slivingdoc space meetings go to, when the login has it.
  space: "notes",
  // The agent's query: the format, then the meeting, from which it picks the inputs to record.
  query: (title, details, connected) =>
    `${notebookFormat(connected)}\n\nMeeting: ${title}.${details ? ` ${details}` : ""}`,
};

// The checklist before a recording, from AudioInputs.access(): the mic, the computer's audio
// and sound heard from it, each `{ id, done, text, action }`, an action being a line to click
// that asks the browser. `share` is audioLimits' share words, or null where this browser shares
// no sound; `micOnly` skips the computer's audio, `heard` and `silent` say what listening found.
// A recording may start only when it is `ready`, which needs no sound heard.
export function precheck({ mic, computer }, share, { micOnly = false, heard = false, silent = false }) {
  const monitor = computer?.via === "monitor";
  const items = [
    { id: "mic", done: Boolean(mic), text: mic ? `Mic: ${mic}` : "Allow the mic", action: !mic },
    {
      id: "computer",
      done: Boolean(computer) || micOnly,
      text: computer ? `Computer audio: ${computer.label}` : micOnly ? "Computer audio: skipped, mic only"
        : share ? `${share} with your call` : "Computer audio: this browser can't record it",
      action: !computer && !micOnly && Boolean(share),
    },
    {
      id: "sound",
      done: monitor || (computer ? heard : micOnly),
      text: monitor ? "Sound comes through the monitor" : computer ? (heard ? "Sound heard" : silent ? "No sound yet. You can still start." : "Listening for sound…")
        : micOnly ? "Sound: your mic only" : "Hear the call's sound",
      action: false,
    },
  ];
  // Sound is not waited for: a recording may start before anyone speaks (watchQuiet asks later).
  return { items, ready: items.filter((i) => i.id !== "sound").every((i) => i.done), sharing: computer?.via === "share" };
}

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

const TOKENS_PAGE = "https://www.slivingdoc.dev/tokens";

// What a sign-out leaves behind, from what it signed out of and how `slivingdoc logout` ended:
// the login is forgotten only once the site revoked the key, so a live key is never orphaned
// silently (2026-11-04 research/http-host-call/PROMPT.md).
export function signoutResult({ account, tokenOnly, status, said }) {
  if (status !== 0) {
    return {
      revoked: false,
      message: `Signing out of ${account ?? "slivingdoc"} failed: ${said || `exit ${status}`}. The login is kept, so it can be revoked.`,
      page: TOKENS_PAGE,
    };
  }
  return {
    revoked: true,
    message: tokenOnly
      ? "Signed out of the token. The key itself stays valid until it is revoked on slivingdoc.dev."
      : `Signed out of ${account ?? "slivingdoc"}.`,
    page: tokenOnly ? TOKENS_PAGE : null,
  };
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
  for (const { u } of transcriptRows(transcript)) {
    if (!u || !isLabel(u.name)) continue;
    const said = u.words.trim();
    const known = found.get(u.name);
    if (!known) found.set(u.name, said);
    else if (known.split(/\s+/).length < 4 && said.split(/\s+/).length >= 4) found.set(u.name, said);
  }
  return [...found].map(([label, sample]) => ({ label, sample }));
}

// A note's body without its own leading "Summary" or "Transcript" heading, which the card has.
export function withoutHeading(body, word) {
  return body.replace(new RegExp(`^\\s*#{1,3} [^\\n]*\\b${word}\\s*\\n+`, "i"), "");
}

// The remote profile an error record says is not trusted (a new version, under -n), or null.
export function untrustedProfile(errors) {
  for (const e of errors) {
    const m = /^profile (\S+): .* you have not trusted/.exec(e.message ?? "");
    if (m) return m[1];
  }
  return null;
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
const PROVIDER_HOSTS = new Set(PROVIDERS.flatMap((p) => p.hosts));
// Set once the user chose to keep the notes in this browser: the sign-in note then stays away.
const STORED_LOCAL = "minutes.local-only";
const TRUST = '"$(clai confdir)/trust.json"';

// slivingdoc where its stderr is the console's: at debug level, so that a pull or a save that
// fails says why there, the first time it does. Where the page reads what it prints (its
// spaces, its login, its log), it runs as it is.
const SLIVINGDOC = "LOG_LEVEL=debug slivingdoc";

const transcriptOf = (summary) => summary.replace("meetings/summaries/", "meetings/transcripts/");

// Penelope works on copies of the open meeting's files, one directory a meeting, so -dre goes on with it.
const PENELOPE_HOME = "/tmp/penelope";
const penelopeDir = (path) => `${PENELOPE_HOME}/${path.split("/").at(-1).replace(/\.md$/, "").replace(/[^\w.-]+/g, "-")}`;

// Each line clai prints goes to the page as an `agent` message, then `agent-end`.
const AGENT_PIPE = " 2>&1 | while IFS= read -r line; do printf 'agent\\n%s\\n' \"$line\" > /run/page/out; done; " +
  "s=${PIPESTATUS[0]}; echo agent-end > /run/page/out; exit $s";

export class Minutes {
  // `machine.run(line, action)` runs a line on the machine and resolves to its status;
  // `machine.type(text)` types on its console. `hood` shows what a click ran, `model` is what
  // the machine did, `env` the variables every run gets, `audio` the inputs being captured.
  // `store` keeps the slivingdoc login and the AI provider's key in the browser: get(key),
  // set(key, value), remove(key). `peek(tab)` opens the under-the-hood view on a tab, and
  // `anchor` is the button that does, which a note about a failure points at. `terminal` is the
  // peek's: write(text) writes there, mark(text) writes and returns where, and reveal(where)
  // scrolls to that and selects it.
  constructor({
    root, machine, hood, model, env, audio, store, recordings, config, peek = () => {}, anchor = null,
    terminal = { write() {}, mark() { return null; }, reveal() {} }, platform = { os: "other", browser: "other" },
  }) {
    this.platform = platform;
    this.title = document.title;
    this.quietNotice = null;
    this.terminal = terminal;
    this.peek = peek;
    this.anchor = anchor;
    this.notes = new Map();
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
    this.signingOut = false;
    this.signoutNote = null;
    // An AI provider's sign-in under way, and what the provider card last said.
    this.providerSigning = null;
    this.providerSaid = null;
    this.trusted = null;
    this.spaces = null;
    this.connecting = !this.store.get(STORED_LOCAL);
    this.config = { ...DEFAULTS, ...config };
    this.meetings = [];
    this.waiters = new Map();
    this.recording = null;
    this.current = null;
    this.levels = [];
    this.actions = 0;
    // The checklist: mic only chosen, and what listening to the share found.
    this.micOnly = false;
    this.heard = false;
    this.silent = false;
    this.listening = null;
    this.shares = 0;
    this.$ = (s) => document.querySelector(s);
    // The open meeting's unsaved corrections, their post-it, and what the pad last drew.
    this.fixes = null;
    this.offer = null;
    this.saving = false;
    this.saveFailed = false;
    this.saveSaid = "";
    this.dropping = false;
    this.quiet = false;
    this.drawn = {};
    this.proof = new Proofreader({
      root: this.$("#transcript"),
      audio: this.$("#recording"),
      markdown: (text, first) => renderMarkdown(first ? withoutHeading(text, "transcript") : text),
      changed: (changes, words) => this.corrected(changes, words),
    });
    this.penelopeBusy = false;
    this.penelopeTalked = new Set();
    this.handFixes = 0;
    this.penelope = new Penelope({
      root: this.$("#penelope"),
      ask: (text) => this.askPenelope(text),
      undo: (step) => this.undoStep(step),
      canUndo: (step) => !this.penelopeBusy && this.fixes === step.fixes && this.fixes.undos.length === step.depth,
    });
    this.bind();
    this.render();
  }

  bind() {
    const $ = this.$;
    const secret = (form, input, name, kept) => {
      $(form).onsubmit = (event) => {
        event.preventDefault();
        const value = $(input).value.trim();
        if (!value) return;
        this.env.set(name, value);
        if (kept) this.store.set(kept, value);
        $(input).value = "";
        this.render();
        if (name === "SLIVINGDOC_TOKEN") {
          this.connecting = false;
          this.refresh();
        }
      };
    };
    secret("#notebook-form", "#token-input", "SLIVINGDOC_TOKEN");
    for (const el of document.querySelectorAll("#provider-card [data-provider]")) {
      const provider = providerById(el.dataset.provider);
      if (provider.connect === "key") {
        el.onsubmit = (event) => {
          event.preventDefault();
          const input = el.querySelector("input");
          const value = input.value.trim();
          input.value = "";
          if (value) this.useKey(provider, value);
        };
      } else {
        el.onclick = () => this.signinProvider(provider, window.open("about:blank", "_blank"));
      }
    }
    // The callback page, in the tab the sign-in opened, hands its code back here.
    this.signins = new BroadcastChannel(SIGNIN_CHANNEL);
    this.signins.onmessage = (event) => this.signedIn(event.data);
    $("#change-key").onclick = () => this.disconnect();
    $("#new").onclick = () => this.blocked() || this.show("record");
    $("#signin").onclick = () => this.signin(window.open("about:blank", "_blank"));
    $("#signout").onclick = () => this.blocked() || this.signout();
    $("#not-now").onclick = () => {
      this.keepLocal();
      this.render();
    };
    $("#connect").onclick = () => {
      if (this.blocked()) return;
      this.connecting = !this.connecting;
      // The sign-in note is on the new recording's page.
      if (this.connecting) this.view = "record";
      this.render();
      if (this.connecting) $("#token-input").focus();
    };
    $("#record-form").onsubmit = (event) => {
      event.preventDefault();
      this.record($("#title").value.trim() || "Meeting", $("#details").value.trim());
    };
    $("#unshare").onclick = () => this.audio?.unshare();
    $("#access-mic").onclick = async () => {
      await this.audio.discover();
      this.audio.relist();
      this.render();
    };
    $("#access-computer").onclick = () => this.shareComputer();
    $("#mic-only").onclick = () => {
      this.micOnly = !this.micOnly;
      this.render();
    };
    $("#stop").onclick = () => this.stop();
    $("#retry").onclick = () => this.blocked() || this.retry();
    $("#speakers").onsubmit = (event) => {
      event.preventDefault();
      if (this.blocked()) return;
      const names = [...$("#speaker-rows").querySelectorAll("input")].map((i) => [i.dataset.label, i.value.trim()]);
      this.nameSpeakers(names);
    };
    $("#space-form").onsubmit = (event) => {
      event.preventDefault();
      if ($("#space").value) this.chooseSpace($("#space").value);
    };
    $("#history").onclick = () => this.history();
    $("#reply-form").onsubmit = (event) => {
      event.preventDefault();
      const text = $("#reply").value.trim();
      if (text && !this.blocked()) this.answer(text);
    };
    $("#fixes-save").onclick = () => this.saveFixes();
    $("#fixes-undo").onclick = () => {
      this.fixes?.undo();
      this.offer = null;
      this.touched();
    };
    $("#fixes-drop").onclick = () => this.drop();
    $("#offer-all").onclick = () => this.fixEverywhere();
    $("#offer-one").onclick = () => {
      this.offer = null;
      this.render();
    };
    globalThis.addEventListener?.("beforeunload", (event) => {
      if (this.fixes?.count) event.preventDefault();
    });
    // Links to the notebook's files, in what the agent wrote, open them here.
    this.root.addEventListener("click", (event) => {
      const link = event.target.closest?.("a[data-note]");
      if (!link) return;
      event.preventDefault();
      const path = link.dataset.note.replace("meetings/transcripts/", "meetings/summaries/");
      this.visit(this.meetings.find((m) => m.path === path) ?? { path, ...describeFile(path) });
    });
  }

  // A meeting the user chose opens, but not over corrections to another still to be saved.
  visit(meeting) {
    if (this.fixes?.count && this.current?.path === meeting.path) return this.show("meeting");
    if (!this.blocked()) this.open(meeting);
  }

  // True when corrections wait to be saved or dropped: the post-it says so, with a wiggle.
  blocked() {
    if (this.penelopeBusy) {
      this.penelope.nudge("Hang on, I'm still writing.");
      return true;
    }
    if (!this.fixes?.count) return false;
    this.saveSaid = "Save or drop these first.";
    this.dropping = false;
    this.show("meeting");
    const postit = this.$("#fixes");
    postit.classList.remove("nudge");
    void postit.offsetWidth;
    postit.classList.add("nudge");
    return true;
  }

  // A correction from the transcript; one word or name changed is offered everywhere it is.
  corrected(changes, words) {
    this.fixes.change(changes);
    if (++this.handFixes === 3) {
      this.penelope.tip("It looks like you're fixing the transcript. Want me to look for more like these?",
        "Look through the transcript for more mistakes like the ones I corrected, and fix them.");
    }
    this.offer = null;
    const change = words && singleChange(words.from, words.to);
    if (change) {
      const places = this.fixes.places(change.from);
      if (places.transcript.count + places.summary.count > 0) this.offer = { ...change, places };
    }
    this.touched();
  }

  // After the corrections changed: the transcript's rows, the summary and the post-it follow.
  touched() {
    this.saveSaid = "";
    this.saveFailed = false;
    this.dropping = false;
    this.proof.refresh();
    this.render();
    document.activeElement?.closest?.(".utt")?.scrollIntoView({ block: "nearest" });
  }

  fixEverywhere() {
    const offer = this.offer;
    this.offer = null;
    if (offer) this.fixes.everywhere(offer.from, offer.to);
    this.touched();
  }

  // Drops every correction, on a second click.
  drop() {
    if (!this.dropping) {
      this.dropping = true;
      return this.render();
    }
    this.fixes = new Fixes(this.current.raw);
    this.proof.fixes = this.fixes;
    this.offer = null;
    this.touched();
  }

  // The user keeps the notes in this browser: the sign-in note goes, and stays away.
  keepLocal() {
    this.connecting = false;
    this.store.set(STORED_LOCAL, "1");
  }

  get connected() {
    return this.env.has("SLIVINGDOC_TOKEN") || this.login !== null;
  }

  // Puts back the slivingdoc login this browser kept, then lists the notebook. #app's
  // data-phase says how far it got (arrival.js writes it on the pad): checking, then fetching
  // or listing, then ready, whatever failed on the way.
  async start() {
    this.phase("checking");
    try {
      // The keys this browser kept, so a return to the site needs no paste or sign-in.
      for (const p of PROVIDERS) {
        const key = this.store.get(p.stored);
        if (key) this.env.set(p.env, key);
      }
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
      this.phase(this.connected && !this.spaces ? "fetching" : "listing");
      await this.refresh(true);
    } finally {
      this.phase("ready");
    }
  }

  phase(name) {
    this.root.dataset.phase = name;
  }

  // The browser's trust is for a version the hub has since replaced: the next start asks again.
  distrust() {
    this.trusted = null;
    this.store.remove(STORED_TRUST);
    this.store.remove(STORED_TRUST + ".profile");
    this.render();
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
      this.fail(`clai could not fetch or trust ${profile}`, `clai profiles trust ended with exit status ${status}.`);
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
    const line = `${SLIVINGDOC} space ${quote(name)} </dev/null >&2 && { echo credentials; cat ${CREDENTIALS}; } > /run/page/out`;
    const { status, body } = await this.run(`Use space ${name}`, line, { topic: "credentials", followUp });
    if (status !== 0 || !body) return this.status(`slivingdoc could not make ${name} the default space (exit ${status}).`);
    this.store.set(STORED_LOGIN, compact(body));
    this.spaces = null;
    this.render();
    if (!followUp) await this.refresh();
  }

  // A provider's OAuth sign-in: its page opens in `tab` (opened by the click), and its callback
  // page hands the code back over SIGNIN_CHANNEL. A second click starts over.
  async signinProvider(provider, tab) {
    const { verifier, challenge, state } = await pkce();
    const callback = new URL("./signin-callback.html", location.href).href;
    const url = authorizeUrl(provider, { callback, challenge, state });
    this.providerSigning = { provider, verifier, state, url, text: `Approve Minutes on ${provider.name}'s page, in the tab that opened.` };
    this.providerSaid = null;
    if (tab && !tab.closed) tab.location.href = url;
    this.render();
  }

  // The callback's answer: an approval for the sign-in under way is traded for its key. A denial
  // carries no state.
  async signedIn({ code, state, error } = {}) {
    const signing = this.providerSigning;
    if (!signing || !(state === signing.state || (!state && !code))) return;
    const { provider } = signing;
    if (!code) {
      this.providerSigning = null;
      this.providerSaid = { text: `${provider.name} did not sign you in${error ? `: ${error}` : ""}.` };
      return this.render();
    }
    this.providerSigning = { ...signing, state: null, text: `Getting your key from ${provider.name}…` };
    this.render();
    try {
      this.useKey(provider, await exchangeCode(provider, { code, verifier: signing.verifier }));
    } catch (error) {
      this.providerSaid = { text: error.message };
    } finally {
      this.providerSigning = null;
      this.render();
    }
  }

  useKey(provider, key) {
    this.env.set(provider.env, key);
    this.store.set(provider.stored, key);
    this.providerSaid = null;
    this.render();
  }

  // Forgets the provider's key here. A key a sign-in created stays live at the provider, so the
  // card links to where it is deleted.
  async disconnect() {
    const provider = activeProvider(this.env);
    if (!provider) return;
    const key = this.env.get(provider.env);
    this.env.delete(provider.env);
    this.store.remove(provider.stored);
    const said = { text: `Minutes forgot your ${provider.name} key.`, name: provider.name, manage: null };
    this.providerSaid = said;
    this.render();
    if (!provider.manage) return;
    said.manage = await provider.manage(key);
    if (this.providerSaid === said) this.render();
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
    this.store.remove(STORED_LOCAL);
    this.login = accountOf(body) ?? "signed in";
    this.signing = null;
    this.connecting = false;
    this.signoutNote = null;
    this.render();
    await this.checkSpace();
    await this.refresh();
  }

  // Signs out: `slivingdoc logout` revokes the login's key at the site and removes the login, and
  // only then does the app forget what it kept. A token-only session has no stored login, and its
  // key stays valid until it is revoked on slivingdoc.dev.
  async signout() {
    const account = this.login;
    const tokenOnly = !this.store.get(STORED_LOGIN);
    this.signingOut = true;
    this.signoutNote = null;
    this.render();
    let { status, body } = { status: 0, body: "" };
    if (!tokenOnly) {
      const line = "{ echo logout; slivingdoc logout </dev/null 2>&1; } > /run/page/out";
      ({ status, body } = await this.run("Sign out", line, { topic: "logout" }));
    }
    const said = (body ?? "").split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
    const result = signoutResult({ account, tokenOnly, status, said });
    if (result.revoked) {
      this.store.remove(STORED_LOGIN);
      this.env.delete("SLIVINGDOC_TOKEN");
      this.login = null;
      this.spaces = null;
      this.connecting = true;
      this.meetings = [];
      this.current = null;
      this.historyItems = null;
      this.signing = null;
    }
    this.signingOut = false;
    this.signoutNote = result;
    this.status(result.message);
    this.show("record");
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
  // on the last click. `args` are the line's $1, $2…, for text too big or too free for `env`.
  async run(label, line, { topic, followUp = false, hint = "", env, args } = {}) {
    const action = `minutes:${label}#${++this.actions}`;
    const sent = topic ? new Promise((resolve) => this.waiters.set(topic, resolve)) : null;
    if (!followUp) this.hood.ran(label, action, line, hint);
    const status = await this.machine.run(line, action, env, args);
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
    const pull = this.connected && !this.spaces ? `${SLIVINGDOC} pull >&2 || echo pull-failed > /run/page/out; ` : "";
    const line = `${this.cd()} && ${pull}{ echo meetings; ` +
      "for f in $(find meetings/summaries -name '*.md' 2>/dev/null); do echo \"@@ $f\"; " +
      "sed -n '1{/^---$/!q};2,/^---$/p' \"$f\" | head -20; done; } > /run/page/out";
    let pullFailed = false;
    this.streams.set("pull-failed", () => (pullFailed = true));
    const { status, body } = await this.run("Refresh", line, { topic: "meetings", followUp });
    this.streams.delete("pull-failed");
    if (status !== 0 || body === null) return this.status(`Listing the notebook failed (exit ${status}).`);
    if (!pullFailed) this.dismiss("slivingdoc could not pull the notebook");
    if (pullFailed) this.fail("slivingdoc could not pull the notebook", "This list is what is on this machine.", "warn");
    this.meetings = parseList(body);
    this.render();
  }

  // The meeting's summary and transcript files as the notebook on the machine has them.
  async readMeeting(path, label, followUp) {
    const line = `${this.cd()} && { echo meeting; cat ${quote(path)}; printf '\\0'; ` +
      `cat ${quote(transcriptOf(path))} 2>/dev/null; } > /run/page/out`;
    const { status, body } = await this.run(label, line, { topic: "meeting", followUp });
    if (status !== 0 || body === null) return null;
    const [summary, transcript = ""] = body.split("\0");
    return { summary, transcript };
  }

  async open(meeting, followUp = false) {
    const files = await this.readMeeting(meeting.path, `Open ${meeting.title}`, followUp);
    if (!files) return this.status(`Could not read ${meeting.path}.`);
    const note = parseNote(files.summary);
    this.recording = null;
    this.current = {
      ...meeting,
      title: note.fields.title || meeting.title,
      summary: note.body,
      transcript: parseNote(files.transcript).body,
      raw: files,
    };
    this.fixes = new Fixes(files);
    this.offer = null;
    this.saveSaid = "";
    this.saveFailed = false;
    this.dropping = false;
    this.historyItems = null;
    this.status("");
    this.show("meeting");
    await this.showRecording(meeting.path, meeting.title);
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

  // The recording kept under `key` in the player, with a link that downloads it as `name`.
  async showRecording(key, name = "recording") {
    const audio = this.$("#recording");
    const link = this.$("#recording-download");
    const blob = key === null ? null : await this.recordings.get(key);
    this.proof.setPlayable(false);
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.hidden = !blob;
    link.hidden = !blob;
    this.proof.setPlayable(Boolean(blob));
    this.render();
    if (blob) {
      audio.src = URL.createObjectURL(blob);
      link.href = audio.src;
      link.download = `${name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "recording"}.wav`;
      link.textContent = `Download the recording (${(blob.size / 1e6).toFixed(1)} MB)`;
    } else {
      audio.removeAttribute("src");
      link.removeAttribute("href");
    }
  }

  // The run failed after the recording was made: the agent runs again on that recording, which
  // is still on the machine, and is told not to record anew.
  async retry() {
    const r = this.recording;
    if (!r?.done || !r.audioPath) return;
    const text = `The recording of this meeting is already made and is the file ${r.audioPath}. Do not record again and do not ` +
      "ask for one: transcribe that file with audio_transcribe and file the notes.";
    this.dismissAll();
    this.recording = { ...r, stages: new Set(["recording", "recorded"]), answering: true, done: false, status: undefined, problem: null };
    this.show("meeting");
    const unwatch = this.watchStages("Try again");
    const { status, reply, problem } = await this.runAgent("Try again", this.agentLine(this.config.query(r.title, text, this.connected), false));
    unwatch();
    await this.finish(status, reply, problem);
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
    const flags = withFlags(providerFlags(activeProvider(this.env), "agent"), c.flags);
    // slivingdoc's server then keeps the notebook the agent's file tools write in.
    const root = this.connected ? 'SLIVINGDOC_WORKSPACE_ROOT="$PWD" ' : "";
    // -json: every line clai prints, on either stream, is a record, and each goes to the page.
    // The page reads the reply and what went wrong from them and draws them on the console
    // (runAgent), so nothing of clai's is printed there as JSON.
    // clai stays the pipeline's own first program, so the peek files what it starts under this
    // click. This bash's PIPESTATUS says 0 for it whatever it exited with, so a failed run is
    // told by its error record.
    // -n: a hub profile that changed since it was trusted is refused at once, not asked about on the console.
    return `${this.cd()} && ${root}${env}clai -json -reply-only -n ${reply ? "-dre " : ""}-profile-path ${c.profile} ` +
      `${flags}query ${quote(query)}${AGENT_PIPE}`;
  }

  // Runs the agent with `line` and resolves to its exit status and reply. A tool that fails
  // on the way and what stopped the run each become a note that points under the hood.
  async runAgent(label, line, options = {}) {
    const run = new AgentRun();
    const printer = new RecordPrinter();
    // Where the terminal shows what stopped the run, for its note to point at.
    let failedAt = null;
    this.streams.set("agent", (body) => {
      for (const text of body.split("\n")) {
        if (!text.trim()) continue;
        const record = run.take(text);
        if (!record) {
          failedAt = this.terminal.mark(printer.raw(text)) ?? failedAt;
        } else if (record.type === "error") {
          failedAt = this.terminal.mark(printer.print(record));
        } else if (record.type === "tool_result" && record.ok === false) {
          this.note({ ...toolProblem(run.failures.at(-1)), at: this.terminal.mark(printer.print(record)) });
        } else {
          this.terminal.write(printer.print(record));
        }
        if (record) options.onRecord?.(record);
      }
    });
    // The run's last message: what is still open on the console closes before its prompt.
    this.streams.set("agent-end", () => this.terminal.write(printer.end()));
    const { status } = await this.run(label, line, { hint: options.hint, followUp: options.followUp, topic: "agent-end" });
    this.streams.delete("agent");
    this.streams.delete("agent-end");
    this.terminal.write(printer.end());
    const changed = untrustedProfile(run.errors);
    if (changed) this.distrust();
    const found = changed
      ? { level: "error", title: "The agent changed since you trusted it", detail: `Read what ${changed} runs now, then start again to trust this version.`, hint: null, code: null }
      : problemOf(run, status);
    const problem = found ? { ...found, at: failedAt } : null;
    if (problem) this.note(problem);
    // A run that reported an error failed, whatever status the pipeline gave.
    return { status: status === 0 && problem ? 1 : status, reply: run.text, problem };
  }

  // Why a recording cannot start yet, or "" when it can.
  blocker() {
    if (!activeProvider(this.env) && !this.config.flags) return "Connect an AI provider first.";
    if (this.spaces) return "Choose the slivingdoc space for your meetings first.";
    return "";
  }

  // Listens to the share until sound comes through, so that a recording never starts on a share
  // that records nothing. Each quiet round says so; a new share starts a new listen.
  async listen() {
    const shared = this.audio.access().computer;
    if (shared?.via !== "share" || this.listening === shared.label + this.shares) return;
    const round = shared.label + this.shares;
    this.listening = round;
    this.heard = false;
    this.silent = false;
    this.render();
    const meter = this.$("#precheck-level");
    for (;;) {
      const heard = await this.audio.hearShare({ onLevel: (peak) => meter.style.setProperty("--level", Math.min(1, peak * 4)) });
      if (this.listening !== round) return;
      if (heard !== "silent") {
        this.heard = heard === "sound";
        this.listening = null;
        meter.style.setProperty("--level", 0);
        return this.render();
      }
      this.silent = true;
      this.render();
    }
  }

  // From a click: a screen or tab to share, then listening to it.
  async shareComputer() {
    if ((await this.audio.share()) !== "shared") return;
    this.shares++;
    this.micOnly = false;
    this.listen();
  }

  // While recording `r` captures the shared tab, a minute without sound from it asks whether it
  // is the right tab: in the page, in its title, and as a system notification when allowed.
  async watchQuiet(r) {
    if (this.audio?.access().computer?.via !== "share") return;
    const recording = () => this.recording === r && !r.done && !r.stages.has("recorded");
    const capturesTab = () => this.audio.inputs().some((i) => i.name === "tab");
    await this.audio.followShare({
      quietMs: QUIET_MS,
      active: recording,
      onQuiet: () => capturesTab() && this.quietTab(r, true),
      onSound: () => this.quietTab(r, false),
    });
    this.quietTab(r, false);
  }

  quietTab(r, quiet) {
    if (Boolean(r.quiet) === quiet) return;
    r.quiet = quiet;
    document.title = quiet ? `(No sound) ${this.title}` : this.title;
    this.quietNotice?.close();
    this.quietNotice = null;
    if (quiet && globalThis.Notification?.permission === "granted") {
      this.quietNotice = new Notification("Are you sharing the right tab?", {
        body: "Minutes has heard nothing from the shared tab for a minute.", tag: "minutes-quiet",
      });
      this.quietNotice.onclick = () => globalThis.focus();
    }
    this.renderRecording();
  }

  check() {
    return precheck(this.audio.access(), audioLimits(this.platform).share, { micOnly: this.micOnly, heard: this.heard, silent: this.silent });
  }

  async record(title, details) {
    if (this.blocker()) return this.status(this.blocker());
    if (this.audio && !this.check().ready) return this.status("Tick off the checklist first.");
    this.status("");
    // The checklist's listening is done with; a shared tab is followed while it records (watchQuiet).
    this.listening = null;
    if (this.audio && this.check().sharing && globalThis.Notification?.permission === "default") Notification.requestPermission();
    if (this.needsTrust && !(await this.trust())) return;
    // Recording past the sign-in note answers it: the notes stay in this browser.
    if (!this.connected && this.connecting) this.keepLocal();
    // Nothing of the last meeting carries over: its notes, recording, history or the form's text.
    this.current = null;
    this.fixes = null;
    this.offer = null;
    this.saveSaid = "";
    this.historyItems = null;
    this.levels = [];
    this.$("#title").value = "";
    this.$("#details").value = "";
    this.renderWave();
    this.recording = { title, startedAt: new Date(), started: null, stages: new Set() };
    this.show("meeting");
    await this.showRecording(null);
    const line = this.agentLine(this.config.query(title, details, this.connected), false);
    const unwatch = this.watchStages("Record");
    const { status, reply, problem } = await this.runAgent("Record", line, {
      hint: "Stop and summarize types Enter on the console, which ends the agent's recording.",
    });
    unwatch();
    await this.finish(status, reply, problem);
  }

  async answer(text) {
    this.$("#reply").value = "";
    this.recording = { ...(this.recording ?? { title: this.current?.title ?? "Meeting" }), stages: new Set(), answering: true, done: false };
    this.show("meeting");
    const unwatch = this.watchStages("Answer");
    const { status, reply, problem } = await this.runAgent("Answer", this.agentLine(text, true));
    unwatch();
    await this.finish(status, reply, problem);
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
    const { status, reply, problem } = await this.runAgent("Name the speakers", this.agentLine(text, true));
    await this.finish(status, reply, problem);
  }

  // Penelope edits copies of the files as they read now; her changes return as one step of proposals.
  async askPenelope(request) {
    const c = this.current;
    if (!c || this.penelopeBusy) return { say: "Open a meeting first.", mood: "unsure", step: null };
    this.proof.close(true);
    this.penelopeBusy = true;
    this.proof.locked = true;
    this.render();
    try {
      this.penelopeProfile ??= await fetch(new URL("./penelope.json", import.meta.url)).then((r) => r.text());
      const dir = penelopeDir(c.path);
      const files = { transcript: this.fixes.result("transcript"), summary: this.fixes.result("summary") };
      const copy = `mkdir -p ${quote(dir)} && cd ${quote(dir)} && printf %s "$1" > ${PENELOPE_HOME}/profile.json && ` +
        'printf %s "$2" > transcript.md && printf %s "$3" > summary.md';
      const { status: copied } = await this.run("Copy the notes for Penelope", copy, { followUp: true, args: [this.penelopeProfile, files.transcript, files.summary] });
      if (copied !== 0) return { say: "I could not get a copy of the notes to work on.", mood: "sorry", step: null };
      const query = penelopeQuery({
        title: c.title,
        transcriptLines: files.transcript.split("\n").length,
        summaryLines: files.summary.split("\n").length,
        corrections: correctionsOf(this.fixes),
        request,
      });
      const k = this.config;
      const line = `cd ${quote(dir)} && ${k.env ? `${k.env} ` : ""}clai -json -reply-only ${this.penelopeTalked.has(dir) ? "-dre " : ""}` +
        `-profile-path ${PENELOPE_HOME}/profile.json ${withFlags(providerFlags(activeProvider(this.env), "penelope"), k.flags)}query ${quote(query)}${AGENT_PIPE}`;
      const { status, reply, problem } = await this.runAgent("Ask Penelope", line, { onRecord: (record) => this.penelope.activity(record) });
      if (status !== 0) return { say: `${problem?.title ?? "I stopped before I was done"}. Nothing changed.`, mood: "sorry", step: null };
      this.penelopeTalked.add(dir);
      const read = `cd ${quote(dir)} && { echo penelope-files; cat transcript.md; printf '\\0'; cat summary.md; } > /run/page/out`;
      const { body } = await this.run("Read Penelope's copies", read, { topic: "penelope-files", followUp: true });
      const answer = parseSay(reply);
      if (body === null) return { ...answer, mood: "sorry", step: null };
      const [transcript, summary = ""] = body.split("\0");
      // A file Penelope rewrote ends as the one she was given did, so a lost final newline is no correction.
      const ending = (text, like) => text.replace(/\n?$/, like.endsWith("\n") ? "\n" : "");
      // The front matter stays the app's.
      const changes = [...this.fixes.adopt("transcript", ending(transcript, files.transcript)), ...this.fixes.adopt("summary", ending(summary, files.summary))]
        .filter((ch) => ("after" in ch ? ch.after + 1 : ch.n) >= this.fixes.front[ch.file]);
      if (changes.length === 0) return { ...answer, step: null };
      this.fixes.change(changes);
      this.offer = null;
      this.touched();
      const first = Math.min(...changes.filter((ch) => ch.file === "transcript").map((ch) => ("after" in ch ? ch.after : ch.n)));
      this.proof.elements.get(first)?.scrollIntoView({ block: "center" });
      const count = changes.reduce((sum, ch) => sum + ("after" in ch ? Math.max(1, ch.lines.length) : 1), 0);
      return { ...answer, step: { fixes: this.fixes, depth: this.fixes.undos.length, count } };
    } finally {
      this.penelopeBusy = false;
      this.proof.locked = false;
      this.render();
    }
  }

  undoStep(step) {
    if (this.fixes !== step.fixes || this.fixes.undos.length !== step.depth) return;
    this.fixes.undo();
    this.offer = null;
    this.touched();
  }

  // What Penelope offers to do for the open meeting, before the user asks anything.
  penelopeIdeas(c) {
    const unknown = unknownSpeakers(c.transcript).map((s) => s.label);
    return [
      "Look for other spellings of the names in this meeting",
      ...unknown.slice(0, 1).map((label) => `Who might ${label} be?`),
      "Bring the summary up to date with the transcript",
      "Take out filler words like um and uh",
    ];
  }

  // The agent is done: the notes it filed open, else what it said shows.
  async finish(status, reply, problem = null) {
    const r = this.recording;
    r.done = true;
    r.status = status;
    r.reply = reply ?? "";
    r.problem = problem;
    this.render();
    // The recording leaves the machine first, whatever became of the run: it is only in this
    // tab's memory there, and a failed transcription or a reload would take it along.
    if (r.audioPath && !r.kept) {
      const key = `unfiled:${r.audioPath}`;
      await this.keepRecording(r.audioPath, key);
      r.kept = key;
      await this.showRecording(key, r.title);
      this.render();
    }
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
      if (r.kept) {
        // Kept under the meeting it now belongs to.
        const blob = await this.recordings.get(r.kept);
        if (blob && (await this.recordings.put(filed.path, blob))) await this.recordings.remove(r.kept);
        r.kept = null;
        await this.showRecording(filed.path, filed.title);
      }
      this.recording = r;
      this.render();
    }
  }

  // Publishes what the agent filed, whether or not it committed through its notes tools.
  async save(title) {
    this.recording.stages.add("saving");
    if (await this.commit(`Minutes: ${title}`)) return true;
    this.fail("slivingdoc could not save the notes", "They are only on this machine.");
    return false;
  }

  async commit(message) {
    const line = `${this.cd()} && ${SLIVINGDOC} commit -m ${quote(message)} >&2`;
    const { status } = await this.run("Save to slivingdoc", line, { followUp: true });
    return status === 0;
  }

  // The texts go as bash's arguments: an env var drops newlines and is inherited (128 KiB cap).
  async writeFiles(entries, followUp = false) {
    if (entries.length === 0) return true;
    const line = `${this.cd()} && ${entries.map(([path], i) => `printf %s "$${i + 1}" > ${quote(path)}`).join(" && ")}`;
    const { status } = await this.run("Save corrections", line, { followUp, args: entries.map(([, text]) => text) });
    return status === 0;
  }

  // No conflict block may stay in the notebook: slivingdoc refuses every later commit.
  async saveFixes() {
    const c = this.current;
    const fixes = this.fixes;
    if (!c || !fixes?.count || this.saving) return;
    this.proof.close(true);
    this.saving = true;
    this.proof.locked = true;
    this.saveFailed = false;
    this.saveSaid = "";
    this.dropping = false;
    this.offer = null;
    this.render();
    const paths = { summary: c.path, transcript: transcriptOf(c.path) };
    const files = Object.keys(paths).filter((file) => fixes.size(file) > 0);
    const notSaved = (said) => {
      this.saveFailed = true;
      this.saveSaid = said;
    };
    try {
      const disk = await this.readMeeting(c.path, "Read the meeting", true);
      if (!disk) return notSaved("Not saved: the meeting could not be read back from the notebook.");
      let lost = 0;
      const texts = files.map((file) => {
        const { text, lost: missed } = fixes.rebase(file, disk[file]);
        lost += missed;
        return [paths[file], text];
      });
      if (!(await this.writeFiles(texts))) return notSaved("Not saved: the files could not be written.");
      let clashed = 0;
      const message = `Minutes: corrections to ${c.title}`;
      if (this.connected && !(await this.commit(message))) {
        const back = await this.readMeeting(c.path, "Read the conflict", true);
        const resolved = files.map((file) => [paths[file], resolveConflicts(back?.[file] ?? "")]).filter(([, r]) => r.blocks > 0);
        clashed = resolved.reduce((sum, [, r]) => sum + r.blocks, 0);
        if (clashed === 0) {
          // No conflict: the files go back as they were, and the corrections stay on the post-it.
          await this.writeFiles(files.map((file) => [paths[file], disk[file]]), true);
          this.fail("slivingdoc could not save the corrections", "The notebook is as it was. Saving again tries again.");
          return notSaved("Not saved to slivingdoc. Try again.");
        }
        if (!((await this.writeFiles(resolved.map(([path, r]) => [path, r.text]), true)) && (await this.commit(message)))) {
          this.fail("slivingdoc could not save the corrections", "They are written in the notebook on this machine; saving again tries the commit again.");
          return notSaved("Not saved to slivingdoc. Try again.");
        }
      }
      const final = (await this.readMeeting(c.path, "Read the saved meeting", true)) ?? disk;
      const said = [
        lost ? `${lost} ${lost === 1 ? "correction was" : "corrections were"} not made: the line changed elsewhere.` : "",
        clashed ? "Where the same lines changed elsewhere, that change was kept." : "",
      ].filter(Boolean).join(" ");
      this.saveSaid = said ? `Saved. ${said}` : this.connected ? "Saved to slivingdoc." : "Saved in the notebook in this tab.";
      await this.settle(c, final);
      if (!said) {
        const shown = this.saveSaid;
        setTimeout(() => {
          if (this.saveSaid !== shown) return;
          this.saveSaid = "";
          this.render();
        }, 5000);
      }
    } finally {
      this.saving = false;
      this.proof.locked = false;
      this.render();
    }
  }

  // The saved meeting, drawn again once the struck words are rubbed out.
  async settle(c, files) {
    this.proof.settle();
    this.$("#summary").classList.add("settling");
    if (!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches) await new Promise((r) => setTimeout(r, 650));
    this.$("#summary").classList.remove("settling");
    if (this.current !== c) return;
    c.raw = files;
    c.summary = parseNote(files.summary).body;
    c.transcript = parseNote(files.transcript).body;
    this.fixes = new Fixes(files);
    this.quiet = true;
    try {
      this.render();
    } finally {
      this.quiet = false;
    }
  }

  // Enter ends the recording: the agent's audio_record waits for it on the console.
  stop() {
    this.machine.type("\r");
    this.$("#stop").disabled = true;
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
  // the AI provider, then one of slivingdoc's, which pushes the notebook.
  watchStages(label) {
    const action = `minutes:${label}#${this.actions + 1}`;
    const listener = (events) => {
      const r = this.recording;
      if (!r || r.done) return;
      const ffmpeg = this.model.find(action, "ffmpeg").filter((p) => p.argv.includes("-i")).at(-1);
      if (ffmpeg) {
        r.stages.add("recording");
        r.started ??= ffmpeg.start;
        r.quietWatch ??= this.watchQuiet(r);
        if (ffmpeg.end !== null) {
          r.stages.add("recorded");
          r.recordedAt ??= ffmpeg.end;
          // clai records into a .part file and renames it once the recording is whole.
          r.audioPath ??= ffmpeg.argv.at(-1).replace(/\.part$/, "");
        }
      }
      const mine = (pid) => this.model.procs.get(pid)?.action === action;
      for (const e of events) {
        if (e.type === "connect" && PROVIDER_HOSTS.has(e.host) && mine(e.pid) && r.stages.has("recorded")) {
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

  // Something the app ran failed: a note with what and, under the hood, why.
  fail(title, detail = "", level = "error") {
    this.note({ level, title, detail, hint: null, code: null });
  }

  dismissAll() {
    for (const el of this.notes.values()) el.remove();
    this.notes.clear();
    this.placeNotes();
  }

  dismiss(title) {
    for (const [key, el] of this.notes) {
      if (!key.startsWith(`${title}\n`)) continue;
      el.remove();
      this.notes.delete(key);
    }
    this.placeNotes();
  }

  // A note about a problem, hung under the button that peeks under the hood and pointing at
  // it: the terminal there has what the programs printed. An error stays until it is closed;
  // a warning leaves by itself. The same note is shown once.
  note({ level, title, detail, hint, code, at = null }) {
    const host = document.querySelector("#notes");
    const key = `${title}\n${detail}`;
    if (!host || this.notes.has(key)) return;
    const el = document.createElement("div");
    el.className = `note ${level}`;
    el.setAttribute("role", level === "error" ? "alert" : "status");
    const head = document.createElement("strong");
    head.textContent = title;
    const close = document.createElement("button");
    close.className = "note-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "✕";
    const remove = () => {
      el.remove();
      this.notes.delete(key);
      this.placeNotes();
    };
    close.onclick = remove;
    el.append(head, close);
    for (const [text, name] of [[detail, "note-detail"], [hint, "note-hint"]]) {
      if (!text) continue;
      const p = document.createElement("p");
      p.className = name;
      p.textContent = text;
      el.append(p);
    }
    if (code) {
      const tag = document.createElement("code");
      tag.className = "note-code";
      tag.textContent = code;
      el.append(tag);
    }
    const look = document.createElement("button");
    look.className = "note-peek";
    look.textContent = "See what the machine printed";
    look.onclick = () => {
      this.peek("terminal");
      // The lines of the terminal the note is about, selected.
      if (at) this.terminal.reveal(at);
      this.placeNotes();
    };
    el.append(look);
    host.append(el);
    this.notes.set(key, el);
    if (level !== "error") setTimeout(remove, 15_000);
    this.placeNotes();
  }

  // Hangs the notes under the peek button, their arrow at its middle, and has the button
  // pulse while there is one.
  placeNotes() {
    const host = document.querySelector("#notes");
    if (!host) return;
    const open = this.notes.size > 0;
    host.hidden = !open;
    this.anchor?.classList.toggle("nudge", open);
    if (!open || !this.anchor) return;
    const at = this.anchor.getBoundingClientRect();
    const right = Math.max(8, document.documentElement.clientWidth - at.right);
    host.style.top = `${Math.round(at.bottom + 12)}px`;
    host.style.right = `${Math.round(right)}px`;
    host.style.setProperty("--arrow", `${Math.round(at.width / 2)}px`);
  }

  show(view) {
    this.view = view;
    this.render();
  }

  render() {
    const $ = this.$;
    const active = activeProvider(this.env);
    $("#key-chip").textContent = active ? `${active.name}: ${mask(`KEY=${this.env.get(active.env)}`).slice(4)}` : "AI provider: not connected";
    $("#change-key").hidden = !active;
    $("#notebook-chip").textContent = this.login ? `slivingdoc: ${this.login}` : this.connected ? "slivingdoc: connected" : "slivingdoc: local notebook";
    $("#provider-card").hidden = Boolean(active);
    const signing = this.providerSigning;
    $("#provider-wait").hidden = !signing;
    if (signing) {
      $("#provider-wait-text").textContent = signing.text;
      $("#provider-link").hidden = !signing.state;
      $("#provider-link").href = signing.url;
    }
    const said = this.providerSaid;
    $("#provider-said").hidden = !said;
    if (said) {
      $("#provider-said-text").textContent = said.text;
      $("#provider-manage").hidden = !said.manage;
      if (said.manage) {
        $("#provider-manage").href = said.manage;
        $("#provider-manage").textContent = `Delete it on ${said.name}`;
      }
    }
    $("#notebook-card").hidden = this.connected || !this.connecting || (this.view ?? "record") !== "record";
    $("#signin").disabled = Boolean(this.signing);
    $("#signin-wait").hidden = !this.signing;
    if (this.signing) {
      $("#signin-text").textContent = this.signing.text;
      $("#signin-code").textContent = this.signing.code ?? "…";
      $("#signin-link").hidden = !this.signing.url;
      if (this.signing.url) $("#signin-link").href = this.signing.url;
    }
    $("#connect").hidden = this.connected;
    $("#signout").hidden = !this.connected;
    $("#signout").disabled = this.signingOut;
    $("#signout-note").hidden = !this.signoutNote;
    if (this.signoutNote) {
      $("#signout-said").textContent = this.signoutNote.message;
      $("#tokens-link").hidden = !this.signoutNote.page;
      if (this.signoutNote.page) $("#tokens-link").href = this.signoutNote.page;
    }
    if (this.audio) {
      // A share that ended takes what was heard with it.
      if (!this.check().sharing && this.listening === null) this.heard = false;
      const check = this.check();
      for (const item of check.items) {
        const line = $(`#access-${item.id}`);
        line.textContent = item.text;
        line.classList.toggle("allowed", item.done);
        line.disabled = !item.action;
      }
      const listening = this.listening !== null && !check.items[2].done;
      $("#precheck-level").hidden = !listening;
      $("#precheck-hint").textContent = audioLimits(this.platform, this.audio.access().computer?.via === "monitor" ? this.audio.access().computer.label : null).text;
      $("#unshare").hidden = !check.sharing;
      $("#mic-only").textContent = this.micOnly ? "Record the call's sound after all" : "Or skip it: record the mic only";
      $("#mic-only").hidden = check.items[1].done && !this.micOnly;
      $("#record-form > .primary").disabled = !check.ready;
    }
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
    const c = this.current;
    const r = this.recording;
    const onPad = (this.view ?? "record") === "meeting" && Boolean(c) && !(r && !r.done) && Boolean(withoutHeading(c.transcript, "transcript").trim());
    this.penelope.place(onPad ? c.path : null, onPad ? this.penelopeIdeas(c) : []);
  }

  // Keeps the entries it drew before, so only a meeting new to the list is written in: the new
  // ones have the class "fresh" until arrival.js has them written.
  renderList() {
    const list = this.$("#meetings");
    const drawn = new Map([...list.children].map((el) => [el.dataset.key, el]));
    const nodes = [];
    const entry = (key, make) => {
      let el = drawn.get(key);
      if (!el) {
        el = make();
        el.dataset.key = key;
        el.classList.add("fresh");
      }
      nodes.push(el);
      return el;
    };
    for (const { label, items } of groupMeetings(this.meetings)) {
      entry(`group:${label}`, () => {
        const head = document.createElement("div");
        head.className = "sidehead";
        head.textContent = label;
        return head;
      });
      for (const meeting of items) {
        const button = entry(`meeting:${meeting.path}`, () => {
          const button = document.createElement("button");
          button.className = "meeting";
          button.append(document.createElement("strong"), document.createElement("span"));
          return button;
        });
        const [title, meta] = button.children;
        if (title.textContent !== meeting.title) title.textContent = meeting.title;
        const when = meetingMeta(meeting);
        if (meta.textContent !== when) meta.textContent = when;
        if (this.current?.path === meeting.path) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
        button.onclick = () => this.visit(meeting);
      }
    }
    if (nodes.length !== list.children.length || nodes.some((el, i) => list.children[i] !== el)) list.replaceChildren(...nodes);
    this.$("#empty").hidden = this.meetings.length > 0;
  }

  renderMeeting() {
    const $ = this.$;
    const r = this.recording;
    const c = this.current;
    $("#meeting-title").textContent = c?.title ?? r?.title ?? "Meeting";
    const meta = c ? meetingMeta(c) : r ? `Today · started ${r.startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
    $("#meeting-meta").textContent = meta;
    // Redrawn only when changed, so a render keeps a correction being typed.
    const summary = $("#summary");
    const same = Boolean(c) && this.drawn.path === c.path;
    const summaryHtml = c ? this.summaryHtml(c) : renderMarkdown("_Written by the agent when you stop the recording._");
    if (this.drawn.summary !== summaryHtml) {
      summary.toggleAttribute("data-written", same && (this.quiet || this.drawn.summaryRaw === c.raw.summary));
      summary.innerHTML = summaryHtml;
      this.drawn.summary = summaryHtml;
    }
    const transcriptKey = c ? `${c.path}\n${c.raw.transcript}` : "";
    if (this.drawn.transcript !== transcriptKey) {
      if (c && withoutHeading(c.transcript, "transcript").trim()) {
        this.proof.draw(this.fixes, same && this.quiet);
      } else {
        this.proof.clear();
        const transcript = $("#transcript");
        transcript.removeAttribute("data-written");
        transcript.innerHTML = renderMarkdown(c ? "_No transcript in the notebook for this meeting._" : "_Transcribed with speaker labels when the recording stops._");
      }
      this.drawn.transcript = transcriptKey;
    }
    this.drawn.path = c?.path;
    this.drawn.summaryRaw = c?.raw.summary;
    this.renderFixes();
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

  // The summary, with what the corrections strike and write in marked.
  summaryHtml(c) {
    const text = this.fixes ? this.fixes.marked("summary") : c.raw.summary;
    return marksToHtml(renderMarkdown(withoutHeading(parseNote(text).body, "summary") || "_The summary is empty._"));
  }

  // The post-it of corrections: how many, the offer to make one everywhere, and saving them.
  renderFixes() {
    const $ = this.$;
    const c = this.current;
    const n = this.fixes?.count ?? 0;
    const hint = $("#proof-hint");
    hint.hidden = !c || this.proof.rows.length === 0;
    hint.textContent = this.proof.playable
      ? "Click a line to correct it, a name to change who said it, a time to hear it."
      : "Click a line to correct it, or a name to change who said it.";
    const postit = $("#fixes");
    postit.hidden = !c || (this.view ?? "record") !== "meeting" || (n === 0 && !this.saving && !this.saveSaid);
    $("#fixes-count").textContent = n === 0 ? (this.saving ? "Saving" : "Saved") : n === 1 ? "1 correction" : `${n} corrections`;
    $("#fixes-said").textContent = this.dropping ? `Drop ${n === 1 ? "it" : `all ${n}`}? Click again to drop.` : this.saveSaid;
    const save = $("#fixes-save");
    save.textContent = this.saving ? "Saving…" : this.saveFailed ? "Try again" : "Save";
    save.disabled = this.saving || this.penelopeBusy;
    save.hidden = n === 0;
    $("#fixes-undo").hidden = this.saving || !this.fixes?.undos.length;
    $("#fixes-drop").hidden = this.saving || n === 0;
    $("#fixes-drop").textContent = `${this.dropping ? "Yes, drop" : "Drop"} ${n === 1 ? "it" : "them"}`;
    const offer = this.offer;
    $("#fix-offer").hidden = !offer || this.saving;
    if (offer) {
      $("#offer-what").textContent = `${offer.from} → ${offer.to}`;
      $("#offer-where").textContent = offerWhere(offer.places);
    }
    // What is scrolled into view, such as the line being corrected, stays above the post-it.
    for (const el of [this.root, $(".content")]) {
      const below = Number.parseFloat(getComputedStyle(el).paddingBottom) || 0;
      el.style.scrollPaddingBottom = postit.hidden ? "" : `${postit.offsetHeight + below + 40}px`;
    }
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
    $("#agent").hidden = !(r?.done && (r.status !== 0 || !this.current));
    $("#agent-text").innerHTML = r?.done
      ? renderMarkdown(r.status === 0 ? r.reply || "_The agent said nothing._"
        : `${r.problem?.title ?? `The agent stopped with exit status ${r.status}`}. ${r.reply ?? ""}`)
      : "";
    $("#retry-note").hidden = !(r?.done && r.status !== 0 && r.audioPath);
    if (!busy) return;
    const seconds = r.started ? Math.max(0, Math.round(((r.recordedAt ?? Date.now()) - r.started) / 1000)) : 0;
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    $("#rec-quiet").hidden = !(live && r.quiet);
    const state = $("#rec-state");
    state.classList.toggle("live", live);
    $("#recbar").classList.toggle("waiting", !live && !r.stages.has("recorded"));
    $("#recbar").classList.toggle("summarizing", r.stages.has("recorded"));
    state.textContent = live ? `Recording ${clock}` : r.stages.has("recorded") ? `Recorded ${clock}` : r.answering ? "The agent is working…" : "Starting the agent…";
    const inputs = this.audio?.inputs() ?? [];
    $("#rec-inputs").textContent = inputs.map((i) => i.label).join(" + ") || "Mic";
    const stages = [
      ["recording", "Recording"],
      ["recorded", "Recorded"],
      ["transcribing", `Transcribing with ${activeProvider(this.env)?.name ?? "the AI provider"}`],
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
