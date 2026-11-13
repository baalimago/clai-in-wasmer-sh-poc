// Penelope, the red pen on the desk: the meeting's agent (penelope.json) and the bubble to talk to her.
import { renderMarkdown } from "./markdown.js";

const MOODS = ["glad", "unsure", "sorry"];
const MOUTHS = {
  glad: "M19.5 91.5 Q24 96.5 28.5 91.5",
  unsure: "M19.5 93 Q21.75 90.5 24 93 T28.5 93",
  sorry: "M19.5 95 Q24 89.5 28.5 95",
  busy: "M22.2 93 a1.8 2.2 0 1 0 3.6 0 a1.8 2.2 0 1 0 -3.6 0",
};

// The INPUT section of Penelope's prompt: the user message of one turn.
export function penelopeQuery({ title, transcriptLines, summaryLines, corrections, request }) {
  for (const [field, value] of Object.entries({ title, transcriptLines, summaryLines, corrections, request })) {
    if (value === undefined) throw new Error(`penelopeQuery: ${field} is missing`);
  }
  return [
    "INPUT",
    `Meeting: ${title}`,
    `transcript.md: ${transcriptLines} lines. summary.md: ${summaryLines} lines.`,
    "The user's unsaved corrections, already in the copies:",
    ...corrections.map((c) => `- ${c}`),
    `Request: ${request}`,
  ].join("\n");
}

// The unsaved corrections of a Fixes, a line each, at most `limit` of them.
export function correctionsOf(fixes, limit = 20) {
  const out = [];
  for (const file of Object.keys(fixes.lines)) {
    for (const [n, now] of fixes.changed[file]) {
      out.push(now === null ? `${file}.md: took out “${fixes.original(file, n)}”` : `${file}.md: “${fixes.original(file, n)}” → “${now}”`);
    }
    for (const lines of fixes.added[file].values()) for (const line of lines) out.push(`${file}.md: added “${line}”`);
  }
  return out.length > limit ? [...out.slice(0, limit), `and ${out.length - limit} more`] : out;
}

// Penelope's final answer, the JSON object her prompt asks for; what she said as it is, when it is none.
export function parseSay(text) {
  const tail = (text ?? "").trim().replace(/```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
  for (let at = tail.lastIndexOf("{"); at >= 0; at = at > 0 ? tail.lastIndexOf("{", at - 1) : -1) {
    try {
      const answer = JSON.parse(tail.slice(at));
      if (typeof answer?.say === "string") return { say: answer.say.trim(), mood: MOODS.includes(answer.mood) ? answer.mood : "glad" };
    } catch {
      // Not the answer's opening brace.
    }
  }
  return { say: tail || "…", mood: "glad" };
}

// What Penelope is doing, from a tool_call record.
export function activityOf({ name, inputs = {} }) {
  const file = String(inputs.file_path ?? inputs.file ?? inputs.path ?? "");
  const which = file.includes("summary") ? "the summary" : "the transcript";
  switch (name) {
    case "rg":
      return `Looking for “${inputs.pattern ?? "…"}”`;
    case "rows_between":
      return `Reading lines ${inputs.start_line ?? "?"} to ${inputs.end_line ?? "?"} of ${which}`;
    case "cat":
    case "head":
    case "tail":
      return `Reading ${which}`;
    case "sed":
    case "apply_patch":
      return `Correcting ${name === "sed" ? which : "a few lines"}`;
    case "write_file":
      return `Rewriting ${which}`;
    default:
      return `Using ${name}`;
  }
}

// The pen and her bubble: `ask(text)` → { say, mood, step }, `step` the proposals `undo(step)` takes back.
export class Penelope {
  constructor({ root, ask, undo, canUndo }) {
    this.root = root;
    this.ask = ask;
    this.undo = undo;
    this.canUndo = canUndo;
    this.$ = (id) => root.querySelector(`#${id}`);
    this.logs = new Map();
    this.key = null;
    this.ideas = [];
    this.busy = false;
    this.doing = "";
    this.mood = "glad";
    this.tipped = false;
    this.$("penelope-pen").onclick = () => this.toggle(this.$("penelope-bubble").hidden);
    this.$("penelope-close").onclick = () => this.toggle(false);
    this.$("penelope-form").onsubmit = (e) => {
      e.preventDefault();
      this.send(this.$("penelope-input").value);
    };
    this.$("penelope-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send(e.target.value);
      } else if (e.key === "Escape") this.toggle(false);
    });
    this.$("penelope-input").addEventListener("input", (e) => this.fit(e.target));
  }

  get log() {
    if (!this.logs.has(this.key)) {
      this.logs.set(this.key, [{
        who: "her",
        text: "Hi, I'm **Penelope**, the red pen around here: I catch what the pencil got wrong. " +
          "Ask me to fix a name, split a line between speakers, or bring the summary up to date. " +
          "What I change shows in pen, for you to keep or undo.",
      }]);
    }
    return this.logs.get(this.key);
  }

  // On the desk for the meeting `key` (null puts her away), with `ideas` to offer.
  place(key, ideas = []) {
    const shown = key !== null;
    if (this.root.hidden === shown) {
      this.root.hidden = !shown;
      if (shown) this.root.classList.add("arriving");
    }
    if (!shown) this.toggle(false);
    if (key !== this.key) {
      this.key = key;
      this.render();
    }
    if (ideas.join("\n") !== this.ideas.join("\n")) {
      this.ideas = ideas;
      this.render();
    }
  }

  toggle(open) {
    const bubble = this.$("penelope-bubble");
    bubble.hidden = !open;
    this.$("penelope-pen").setAttribute("aria-expanded", String(open));
    this.root.classList.toggle("open", open);
    this.root.ownerDocument.body.classList.toggle("penelope-open", open);
    if (open) {
      this.render();
      this.$("penelope-input").focus();
    }
  }

  // Once a session: Penelope leans out and offers to look for the rest, as a certain paperclip would.
  tip(text, request) {
    if (this.tipped || this.busy || !this.$("penelope-bubble").hidden) return;
    this.tipped = true;
    this.log.push({ who: "her", text, actions: [["Yes, have a look", () => this.send(request)], ["No thanks", () => this.toggle(false)]] });
    this.toggle(true);
  }

  // Says `text` in the bubble, opening it.
  nudge(text) {
    this.log.push({ who: "her", text, mood: "unsure" });
    this.toggle(true);
  }

  async send(text) {
    const request = text.trim();
    if (!request || this.busy) return;
    this.$("penelope-input").value = "";
    this.fit(this.$("penelope-input"));
    const log = this.log;
    for (const item of log) item.actions = null;
    log.push({ who: "you", text: request });
    this.working(true);
    try {
      const { say, mood, step } = await this.ask(request);
      log.push({ who: "her", text: say, mood, step });
      this.mood = mood;
    } catch (error) {
      log.push({ who: "her", text: `My ink ran out: ${error.message}`, mood: "sorry" });
      this.mood = "sorry";
    } finally {
      this.working(false);
    }
  }

  working(on, doing = "") {
    this.busy = on;
    this.doing = on ? doing || "Thinking" : "";
    this.render();
  }

  activity(record) {
    if (!this.busy || record.type !== "tool_call") return;
    this.doing = activityOf(record);
    this.render();
  }

  // As tall as what is typed, up to a few lines; it scrolls only past those.
  fit(area) {
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 128)}px`;
    area.style.overflowY = area.scrollHeight > 128 ? "auto" : "hidden";
  }

  render() {
    const doc = this.root.ownerDocument;
    this.root.classList.toggle("busy", this.busy);
    for (const mood of MOODS) this.root.classList.toggle(`mood-${mood}`, !this.busy && this.mood === mood);
    this.$("penelope-mouth").setAttribute("d", MOUTHS[this.busy ? "busy" : this.mood]);
    this.$("penelope-ask").disabled = this.busy;
    const doing = this.$("penelope-doing");
    doing.hidden = !this.busy;
    doing.textContent = this.doing;
    if (this.$("penelope-bubble").hidden || this.key === null) return;
    const items = this.log.map((item) => {
      const li = doc.createElement("li");
      li.className = item.who === "you" ? "penelope-you" : "penelope-her";
      if (item.who === "you") li.textContent = item.text;
      else li.innerHTML = renderMarkdown(item.text);
      if (item.step?.count) {
        const row = doc.createElement("p");
        row.className = "penelope-step";
        const n = item.step.count;
        row.append(`${n} ${n === 1 ? "line" : "lines"} in pen. `);
        const back = doc.createElement("button");
        back.type = "button";
        back.className = "penelope-link";
        back.textContent = "Undo these";
        back.disabled = !this.canUndo(item.step);
        back.onclick = () => {
          this.undo(item.step);
          this.render();
        };
        row.append(back);
        li.append(row);
      }
      if (item.actions) {
        const row = doc.createElement("p");
        row.className = "penelope-actions";
        for (const [label, act] of item.actions) {
          const b = doc.createElement("button");
          b.type = "button";
          b.className = "penelope-link";
          b.textContent = label;
          b.onclick = act;
          row.append(b);
        }
        li.append(row);
      }
      return li;
    });
    const list = this.$("penelope-log");
    list.replaceChildren(...items);
    list.scrollTop = list.scrollHeight;
    const ideas = this.$("penelope-ideas");
    ideas.hidden = this.busy || this.log.some((item) => item.who === "you");
    ideas.replaceChildren(...this.ideas.map((idea) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "penelope-link";
      b.textContent = idea;
      b.onclick = () => this.send(idea);
      return b;
    }));
  }
}
