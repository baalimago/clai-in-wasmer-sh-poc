// Proofreading a filed meeting: a row per utterance, corrected in place until saved.

const LABEL = /^(?:Speaker [A-Z0-9]{1,2}|[Uu]nknown[ -][Ss]peaker(?: \d+)?|unknown-\d+)$/;
const TIME = String.raw`\d{1,2}:\d\d(?::\d\d)?(?:[.,]\d+)?`;
const STAMP = String.raw`(?:\[[^\]\n]*\d:\d\d[^\]\n]*\]|${TIME}(?:\s*(?:-->|–|-)\s*${TIME})?)`;
// `- **Speaker A** [00:12]: words`, `[00:00:04.300 --> 00:00:09.250] Ada: words`: prefix, speaker, mid, words.
const UTTERANCE = new RegExp(
  String.raw`^(\s*(?:[-*+]\s+)?(?:${STAMP}\s*)?\*{0,2})` +
    String.raw`(\p{L}[\p{L}\p{N} .'’-]{0,38}?)` +
    String.raw`(\*{0,2}\s*(?:${STAMP})?\s*:(?!\/\/)\s*(?:\*\*\s*)?)` +
    "(.*)$",
  "u",
);
const CLOCK = /(?:(\d+):)?(\d{1,2}):(\d\d)(?:[.,](\d+))?/g;
const TOKEN = /[\p{L}\p{N}]+|\s+|[^\s\p{L}\p{N}]/gu;

// Private-use characters that mark struck and written-in text through markdown rendering.
const DEL = ["\uE000", "\uE001"];
const INS = ["\uE002", "\uE003"];

export const escapeHtml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export const isLabel = (name) => LABEL.test(name);

// A line of a transcript as an utterance, with its start and end in seconds when it has them.
export function parseUtterance(line) {
  const m = UTTERANCE.exec(line);
  if (!m) return null;
  const [, prefix, name, mid, words] = m;
  const times = [...(prefix + mid).matchAll(CLOCK)].map(([, h = "0", min, s, frac = ""]) =>
    Number(h) * 3600 + Number(min) * 60 + Number(s) + (frac ? Number(`0.${frac}`) : 0));
  return { prefix, name, mid, words, start: times[0] ?? null, end: times[1] ?? null };
}

// The speaker and words of `line`, a correction of the utterance `u`.
export function partsOf(line, u) {
  const at = line.startsWith(u.prefix) ? line.indexOf(u.mid, u.prefix.length) : -1;
  return at < 0 ? null : { name: line.slice(u.prefix.length, at), words: line.slice(at + u.mid.length) };
}

// How many lines of `text` its front matter takes.
export function frontLines(text) {
  const m = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(text);
  return m ? m[0].split("\n").length - (m[0].endsWith("\n") ? 1 : 0) : 0;
}

// Each line after the front matter with its utterance or null; `- **Duration:** 38` above the first one stays text.
export function transcriptRows(text) {
  const lines = text.split("\n");
  const front = frontLines(text);
  const found = [];
  const said = new Map();
  let fenced = false;
  for (let n = front; n < lines.length; n++) {
    if (/^\s*(?:```|~~~)/.test(lines[n])) fenced = !fenced;
    const u = fenced || /^\s*#/.test(lines[n]) ? null : parseUtterance(lines[n]);
    found.push(u);
    if (u) said.set(u.name, (said.get(u.name) ?? 0) + 1);
  }
  let begun = false;
  return found.map((u, i) => {
    const counts = u && (begun || u.start !== null || LABEL.test(u.name) || said.get(u.name) > 1);
    begun ||= Boolean(counts);
    return { n: front + i, u: counts ? u : null };
  });
}

// 4.3 → "0:04", 3725 → "1:02:05".
export function clock(seconds) {
  const s = Math.floor(seconds);
  const mm = String(Math.floor(s / 60) % 60);
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

// `x` and `y` matched as their longest common run, in order: same { i, j }, del { i }, ins { j }.
export function align(x, y) {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const m = x.length - p - s;
  const k = y.length - p - s;
  const ops = [];
  for (let i = 0; i < p; i++) ops.push({ type: "same", i, j: i });
  if (m * k > 4_000_000) {
    for (let i = 0; i < m; i++) ops.push({ type: "del", i: p + i });
    for (let j = 0; j < k; j++) ops.push({ type: "ins", j: p + j });
  } else {
    const lcs = Array.from({ length: m + 1 }, () => new Uint32Array(k + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = k - 1; j >= 0; j--) {
        lcs[i][j] = x[p + i] === y[p + j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < k) {
      if (x[p + i] === y[p + j]) ops.push({ type: "same", i: p + i++, j: p + j++ });
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ type: "del", i: p + i++ });
      else ops.push({ type: "ins", j: p + j++ });
    }
    while (i < m) ops.push({ type: "del", i: p + i++ });
    while (j < k) ops.push({ type: "ins", j: p + j++ });
  }
  for (let t = 0; t < s; t++) ops.push({ type: "same", i: x.length - s + t, j: y.length - s + t });
  return ops;
}

// The edit from `a` to `b` word by word: runs of same, del and ins.
export function diff(a, b) {
  const x = a.match(TOKEN) ?? [];
  const y = b.match(TOKEN) ?? [];
  const ops = [];
  for (const op of align(x, y)) {
    const text = op.type === "ins" ? y[op.j] : x[op.i];
    const last = ops.at(-1);
    if (last?.type === op.type) last.text += text;
    else ops.push({ type: op.type, text });
  }
  return ops;
}

// `b`, with what changed from `a` marked so that it survives markdown: see marksToHtml.
export function diffMarks(a, b) {
  return diff(a, b).map(({ type, text }) => type === "del" ? DEL[0] + text + DEL[1] : type === "ins" ? INS[0] + text + INS[1] : text).join("");
}

export const marksToHtml = (html) =>
  html.replaceAll(DEL[0], "<del>").replaceAll(DEL[1], "</del>").replaceAll(INS[0], "<ins>").replaceAll(INS[1], "</ins>");

const marked = (a, b) => marksToHtml(escapeHtml(diffMarks(a, b)));

const BLOCK = /^(\s*(?:(?:#{1,6}|>|[-*+]|\d+[.)])\s+)*)(.*)$/;
// `line` with its text after any heading, quote or list marker between `marks`, so markdown keeps its shape.
const wrapLine = (line, [open, close]) => {
  const [, head, body] = BLOCK.exec(line);
  return body.trim() ? head + open + body + close : line;
};

// The one phrase of up to three words `b` puts in place of `a`'s: a name or a longer word, not just its case.
export function singleChange(a, b) {
  const hunks = [];
  let open = null;
  for (const op of diff(a, b)) {
    if (op.type === "same") {
      open = null;
      continue;
    }
    if (!open) hunks.push((open = { from: "", to: "" }));
    open[op.type === "del" ? "from" : "to"] += op.text;
  }
  if (hunks.length !== 1) return null;
  const from = hunks[0].from.trim();
  const to = hunks[0].to.trim();
  if (!/\p{L}/u.test(from) || !to || from.toLowerCase() === to.toLowerCase()) return null;
  if (!/\p{Lu}/u.test(from) && from.length < 4) return null;
  return (from.match(/[\p{L}\p{N}]+/gu) ?? []).length > 3 ? null : { from, to };
}

// Where else a fix is offered: "In 11 more places: 9 in the transcript, 2 in the summary."
export function offerWhere({ transcript, summary }) {
  const all = transcript.count + summary.count;
  const places = `${all} more ${all === 1 ? "place" : "places"}`;
  if (!summary.count) return `In ${places} in the transcript.`;
  if (!transcript.count) return `In ${places} in the summary.`;
  return `In ${places}: ${transcript.count} in the transcript, ${summary.count} in the summary.`;
}

// `word` as a whole word, in any case.
export const wordPattern = (word) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu");

// Conflict blocks slivingdoc wrote into `text`, each replaced by its remote side.
export function resolveConflicts(text) {
  const lines = text.split("\n");
  const is = (j, marker) => lines[j]?.replace(/\r$/, "") === marker;
  const out = [];
  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    if (is(i, "<<<<<<< local")) {
      let mid = i + 1;
      while (mid < lines.length && !is(mid, "=======")) mid++;
      let end = mid + 1;
      while (end < lines.length && !is(end, ">>>>>>> remote")) end++;
      if (end < lines.length) {
        out.push(...lines.slice(mid + 1, end));
        blocks++;
        i = end;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return { text: out.join("\n"), blocks };
}

// Unsaved corrections: each file's line number → its new text (null: taken out), and lines added after one.
export class Fixes {
  constructor(files) {
    this.files = { ...files };
    this.lines = {};
    this.changed = {};
    this.added = {};
    this.front = {};
    for (const [file, text] of Object.entries(this.files)) {
      this.lines[file] = text.split("\n");
      this.changed[file] = new Map();
      this.added[file] = new Map();
      this.front[file] = frontLines(text);
    }
    this.undos = [];
  }

  get count() {
    return Object.keys(this.lines).reduce((sum, file) => sum + this.size(file), 0);
  }

  size(file) {
    return this.changed[file].size + [...this.added[file].values()].reduce((sum, lines) => sum + lines.length, 0);
  }

  original(file, n) {
    return this.lines[file][n];
  }

  text(file, n) {
    const m = this.changed[file];
    return m.has(n) ? m.get(n) : this.lines[file][n];
  }

  addedAfter(file, n) {
    return this.added[file].get(n) ?? [];
  }

  // `changes` holds { file, n, text } for a filed line and { file, after, lines } for the lines after one.
  change(changes) {
    const undo = [];
    for (const c of changes) {
      const adds = "after" in c;
      const m = adds ? this.added[c.file] : this.changed[c.file];
      const key = adds ? c.after : c.n;
      undo.push({ m, key, had: m.has(key), value: m.get(key) });
      if (adds ? c.lines.length === 0 : c.text === this.lines[c.file][c.n]) m.delete(key);
      else m.set(key, adds ? [...c.lines] : c.text);
    }
    if (undo.length) this.undos.push(undo);
  }

  undo() {
    const undo = this.undos.pop() ?? [];
    for (const { m, key, had, value } of undo.reverse()) {
      if (had) m.set(key, value);
      else m.delete(key);
    }
    return undo.length > 0;
  }

  // `file` as it reads now: { n, text } for a filed line, { n, k, text } for the k-th line added after it.
  entries(file) {
    const out = [];
    const add = (n) => this.addedAfter(file, n).forEach((text, k) => out.push({ n, k, text }));
    add(-1);
    this.lines[file].forEach((_, n) => {
      const text = this.text(file, n);
      if (text !== null) out.push({ n, text });
      add(n);
    });
    return out;
  }

  result(file) {
    return this.entries(file).map((e) => e.text).join("\n");
  }

  // Line `n` and the lines added after it, each correction marked: see marksToHtml.
  markedLines(file, n) {
    const was = this.lines[file][n];
    const now = this.text(file, n);
    const own = now === was ? was : now === null ? wrapLine(was, DEL) : diffMarks(was, now);
    return [own, ...this.addedAfter(file, n).map((line) => wrapLine(line, INS))];
  }

  marked(file) {
    const top = this.addedAfter(file, -1).map((line) => wrapLine(line, INS));
    return [...top, ...this.lines[file].flatMap((_, n) => this.markedLines(file, n))].join("\n");
  }

  // The changes that make `file` read `text`: a copy of it someone edited, matched line by line.
  adopt(file, text) {
    const entries = this.entries(file);
    const lines = text.split("\n");
    const texts = new Map();
    const added = new Map();
    const push = (n, line) => added.set(n, [...(added.get(n) ?? []), line]);
    let anchor = -1;
    const keep = (e, line) => {
      if (e.k === undefined) texts.set(e.n, line);
      else if (line !== null) push(e.n, line);
      anchor = e.n;
    };
    const ops = align(entries.map((e) => e.text), lines);
    for (let p = 0; p < ops.length;) {
      if (ops[p].type === "same") {
        const e = entries[ops[p++].i];
        keep(e, e.text);
        continue;
      }
      const dels = [];
      const ins = [];
      while (p < ops.length && ops[p].type !== "same") {
        const op = ops[p++];
        if (op.type === "del") dels.push(entries[op.i]);
        else ins.push(lines[op.j]);
      }
      dels.forEach((e, x) => keep(e, x < ins.length ? ins[x] : null));
      for (const line of ins.slice(dels.length)) push(anchor, line);
    }
    const changes = [];
    for (const [n, line] of texts) if (line !== this.text(file, n)) changes.push({ file, n, text: line });
    for (const n of new Set([...this.added[file].keys(), ...added.keys()])) {
      const next = added.get(n) ?? [];
      const now = this.addedAfter(file, n);
      if (next.length !== now.length || next.some((line, x) => line !== now[x])) changes.push({ file, after: n, lines: next });
    }
    return changes;
  }

  // Where `word` is in each file below its front matter: the lines, and how many times.
  places(word) {
    const pattern = wordPattern(word);
    const out = {};
    for (const file of Object.keys(this.lines)) {
      const found = this.entries(file)
        .filter((e) => e.k !== undefined || e.n >= this.front[file])
        .map((e) => ({ e, count: e.text.match(pattern)?.length ?? 0 }))
        .filter((f) => f.count);
      out[file] = { entries: found.map((f) => f.e), count: found.reduce((sum, f) => sum + f.count, 0) };
    }
    return out;
  }

  // `from` → `to` wherever it is, as one step.
  everywhere(from, to) {
    const pattern = wordPattern(from);
    const fix = (line) => line.replace(pattern, () => to);
    const changes = [];
    for (const [file, { entries }] of Object.entries(this.places(from))) {
      for (const e of entries) if (e.k === undefined) changes.push({ file, n: e.n, text: fix(e.text) });
      for (const n of new Set(entries.filter((e) => e.k !== undefined).map((e) => e.n))) {
        changes.push({ file, after: n, lines: this.addedAfter(file, n).map(fix) });
      }
    }
    this.change(changes);
    return changes.length;
  }

  // `disk` with the corrections, each placed by its line's filed text nearest where it was.
  rebase(file, disk) {
    const lines = disk.split("\n");
    const used = new Set();
    const nearest = (text, n) => {
      for (let d = 0; d <= lines.length; d++) {
        for (const j of d ? [n - d, n + d] : [n]) {
          if (j >= 0 && j < lines.length && !used.has(j) && lines[j] === text) return j;
        }
      }
      return -1;
    };
    const changed = this.changed[file];
    const placed = new Map([[-1, -1]]);
    const removed = new Set();
    let lost = 0;
    const anchors = [...this.added[file].keys()].filter((n) => n >= 0);
    for (const n of [...new Set([...changed.keys(), ...anchors])].sort((a, b) => a - b)) {
      const text = changed.has(n) ? changed.get(n) : this.lines[file][n];
      let j = nearest(this.lines[file][n], n);
      if (j < 0 && text !== null) j = nearest(text, n);
      if (j < 0) {
        if (changed.has(n) && text !== null) lost++;
        lost += this.addedAfter(file, n).length;
        continue;
      }
      used.add(j);
      placed.set(n, j);
      if (text === null) removed.add(j);
      else lines[j] = text;
    }
    const after = new Map([...this.added[file]].filter(([n]) => placed.has(n)).map(([n, add]) => [placed.get(n), add]));
    const there = (j, add) => add.every((line, x) => lines[j + 1 + x] === line);
    const out = [];
    for (let j = -1; j < lines.length; j++) {
      if (j >= 0 && !removed.has(j)) out.push(lines[j]);
      const add = after.get(j);
      if (add && !there(j, add)) out.push(...add);
    }
    return { text: out.join("\n"), lost };
  }
}

// The transcript's rows; what it redraws is marked data-written, which handwriting.js leaves alone.
export class Proofreader {
  // `changed(changes, words)` takes a correction, `words` being { from, to } when what was said changed.
  constructor({ root, audio, markdown, changed }) {
    this.root = root;
    this.audio = audio;
    this.markdown = markdown;
    this.changed = changed;
    this.fixes = null;
    this.rows = [];
    this.parsed = new Map();
    this.elements = new Map();
    this.chunks = [];
    this.shown = new Map();
    this.editing = null;
    this.menu = null;
    this.playing = null;
    this.playable = false;
    // While corrections are saved, the transcript takes none.
    this.locked = false;
    root.addEventListener("click", (e) => this.click(e));
    root.addEventListener("keydown", (e) => this.keyDown(e));
    root.addEventListener("focusin", (e) => this.focused(e));
    root.ownerDocument.addEventListener("pointerdown", (e) => {
      if (this.menu && !this.menu.el.contains(e.target)) this.closeMenu();
    });
  }

  // Nothing to proofread: the pad shows something else.
  clear() {
    this.close(false);
    this.closeMenu();
    this.stop();
    this.fixes = null;
    this.rows = [];
    this.chunks = [];
    this.elements = new Map();
  }

  // `written` when the same meeting is drawn again, which the pencil does not write out anew.
  draw(fixes, written = false) {
    this.close(false);
    this.closeMenu();
    this.stop();
    this.fixes = fixes;
    const rows = transcriptRows(fixes.files.transcript);
    this.rows = rows.filter((r) => r.u).map((r) => r.n);
    this.parsed = new Map(rows.filter((r) => r.u).map((r) => [r.n, r.u]));
    this.shown = new Map();
    this.chunks = [];
    let html = "";
    let lines = [];
    const flush = () => {
      if (lines.some((n) => fixes.original("transcript", n).trim())) {
        this.chunks.push(lines);
        html += this.chunkHtml(lines, this.chunks.length - 1, html === "");
      }
      lines = [];
    };
    for (const { n, u } of rows) {
      if (!u) {
        lines.push(n);
        continue;
      }
      flush();
      this.shown.set(n, this.keyOf(n));
      html += this.rowHtml(n) + this.addedHtml(n);
    }
    flush();
    this.root.toggleAttribute("data-written", written);
    // Once the pencil has the drawing, what changes after is the user's and is not written out anew.
    if (!written) setTimeout(() => this.root.setAttribute("data-written", ""), 0);
    this.root.classList.remove("settling");
    this.root.classList.toggle("untimed", !rows.some((r) => r.u && r.u.start !== null));
    this.root.innerHTML = html;
    this.elements = new Map([...this.root.querySelectorAll(".utt")].map((el) => [Number(el.dataset.line), el]));
    this.chunks = this.chunks.map((lines, i) => ({ lines, el: this.root.querySelector(`[data-chunk="${i}"]`), key: this.chunkKey(lines) }));
    this.elements.get(this.rows[0])?.setAttribute("tabindex", "0");
  }

  keyOf(n) {
    const m = this.fixes.changed.transcript;
    const added = this.fixes.addedAfter("transcript", n);
    return m.has(n) || added.length ? JSON.stringify([m.has(n) ? m.get(n) : 0, added]) : undefined;
  }

  chunkKey(lines) {
    return lines.map((n) => this.keyOf(n) ?? "\u0001").join("\u0002");
  }

  // What the row's line says now: its speaker and words, or null once taken out.
  current(n) {
    const u = this.parsed.get(n);
    const now = this.fixes.text("transcript", n);
    if (now === null) return null;
    return now === this.fixes.original("transcript", n) ? { name: u.name, words: u.words } : partsOf(now, u) ?? { name: u.name, words: now };
  }

  rowHtml(n) {
    const u = this.parsed.get(n);
    const now = this.current(n);
    const fixed = this.fixes.changed.transcript.has(n);
    const who = !now || now.name === u.name ? escapeHtml(u.name) : marked(u.name, now.name);
    const words = now ? (fixed ? marked(u.words, now.words) : escapeHtml(u.words)) : `<del>${escapeHtml(u.words)}</del>`;
    const time = u.start === null ? "" : `<button type="button" class="utt-time" tabindex="-1" aria-label="Play ${clock(u.start)}">${clock(u.start)}</button>`;
    const span = (u.start === null ? "" : ` data-start="${u.start}"`) + (u.end === null ? "" : ` data-end="${u.end}"`);
    return `<div class="utt${fixed ? " fixed" : ""}${now ? "" : " removed"}" data-line="${n}"${span} tabindex="-1" aria-describedby="proof-keys">` +
      `${time}<button type="button" class="utt-who" tabindex="-1">${who}</button>: <span class="utt-words">${words}</span></div>`;
  }

  // The lines added after row `n`, in pen: rows when they are utterances.
  addedHtml(n) {
    return this.fixes.addedAfter("transcript", n).map((line) => {
      const u = parseUtterance(line);
      const inner = u
        ? `${u.start === null ? "" : `<span class="utt-time">${clock(u.start)}</span>`}<span class="utt-who">${escapeHtml(u.name)}</span>: ` +
          `<span class="utt-words">${escapeHtml(u.words)}</span>`
        : escapeHtml(line);
      return `<div class="utt-added" data-after="${n}"><ins>${inner}</ins></div>`;
    }).join("");
  }

  chunkHtml(lines, i, first) {
    const text = lines.flatMap((n) => this.fixes.markedLines("transcript", n)).join("\n");
    const fixed = lines.some((n) => this.keyOf(n) !== undefined);
    return `<div class="chunk${fixed ? " fixed" : ""}" data-chunk="${i}">${marksToHtml(this.markdown(text, first))}</div>`;
  }

  // Redraws the rows and chunks whose corrections changed.
  refresh() {
    if (!this.fixes) return;
    for (const n of this.rows) {
      if (this.shown.get(n) !== this.keyOf(n)) this.patch(this.elements.get(n));
    }
    this.chunks.forEach((chunk, i) => {
      const key = this.chunkKey(chunk.lines);
      if (key === chunk.key || !chunk.el) return;
      chunk.key = key;
      const fresh = this.template(this.chunkHtml(chunk.lines, i, chunk.el === this.root.firstElementChild));
      chunk.el.dataset.written = "";
      chunk.el.className = fresh.className;
      chunk.el.replaceChildren(...fresh.childNodes);
    });
  }

  template(html) {
    const t = this.root.ownerDocument.createElement("template");
    t.innerHTML = html;
    return t.content.firstElementChild;
  }

  patch(row) {
    if (!row) return;
    const n = Number(row.dataset.line);
    if (this.editing?.row === row) this.editing = null;
    if (this.menu?.row === row) this.menu = null;
    const fresh = this.template(this.rowHtml(n));
    row.dataset.written = "";
    row.className = fresh.className + (this.playing?.row === row ? " playing" : "");
    row.replaceChildren(...fresh.childNodes);
    let next = row.nextElementSibling;
    while (next?.dataset.after === String(n)) {
      const gone = next;
      next = next.nextElementSibling;
      gone.remove();
    }
    const added = this.addedHtml(n);
    if (added) row.insertAdjacentHTML("afterend", added);
    this.shown.set(n, this.keyOf(n));
  }

  // Before a saved meeting is drawn again: the struck words are rubbed out.
  settle() {
    this.close(true);
    this.root.classList.add("settling");
  }

  step(row, dir) {
    let el = row;
    do el = dir > 0 ? el.nextElementSibling : el.previousElementSibling;
    while (el && !el.classList.contains("utt"));
    return el;
  }

  click(e) {
    const row = e.target.closest?.(".utt");
    if (!row || !this.fixes || e.target.closest(".who-menu, textarea")) return;
    if (this.locked && !e.target.closest(".utt-time")) return;
    if (e.target.closest(".utt-time")) return this.play(row);
    if (e.target.closest(".utt-who")) return this.openMenu(row);
    if (!this.root.ownerDocument.getSelection().isCollapsed) return;
    this.edit(row, this.caret(e, row));
  }


  keyDown(e) {
    const row = e.target.classList?.contains("utt") ? e.target : null;
    if (!row || !this.fixes) return;
    const go = (to) => {
      if (!to) return;
      e.preventDefault();
      to.focus();
    };
    if (e.key === "ArrowDown") go(this.step(row, 1));
    else if (e.key === "ArrowUp") go(this.step(row, -1));
    else if (e.key === "Home") go(this.elements.get(this.rows[0]));
    else if (e.key === "End") go(this.elements.get(this.rows.at(-1)));
    else if (e.key === "Enter") {
      e.preventDefault();
      this.edit(row, null);
    } else if (e.key === " ") {
      e.preventDefault();
      this.play(row);
    } else if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      this.openMenu(row);
    }
  }

  // One row of the transcript is in the tab order: the one last focused.
  focused(e) {
    const row = e.target.closest?.(".utt");
    if (!row || row.tabIndex === 0) return;
    for (const el of this.root.querySelectorAll('.utt[tabindex="0"]')) el.tabIndex = -1;
    row.tabIndex = 0;
  }

  // Where in the row's words the click landed, counting what they say now.
  caret(e, row) {
    const doc = this.root.ownerDocument;
    const words = row.querySelector(".utt-words");
    let node = null;
    let offset = 0;
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(e.clientX, e.clientY);
      node = p?.offsetNode;
      offset = p?.offset ?? 0;
    } else if (doc.caretRangeFromPoint) {
      const r = doc.caretRangeFromPoint(e.clientX, e.clientY);
      node = r?.startContainer;
      offset = r?.startOffset ?? 0;
    }
    if (!words || !node || !words.contains(node)) return null;
    let at = 0;
    const walker = doc.createTreeWalker(words, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const struck = Boolean(text.parentElement.closest("del"));
      if (text === node) return at + (struck ? 0 : offset);
      if (!struck) at += text.data.length;
    }
    return null;
  }

  edit(row, offset) {
    if (!row || !this.fixes || this.locked) return;
    this.close(true);
    this.closeMenu();
    const n = Number(row.dataset.line);
    const u = this.parsed.get(n);
    const now = this.current(n) ?? { name: u.name, words: u.words };
    const area = this.root.ownerDocument.createElement("textarea");
    area.className = "utt-edit";
    area.rows = 1;
    area.value = now.words;
    area.setAttribute("aria-label", `What ${now.name} said`);
    row.dataset.written = "";
    row.querySelector(".utt-words")?.replaceWith(area);
    this.editing = { row, n, area, name: now.name, words: now.words };
    this.fit(area);
    area.focus({ preventScroll: true });
    area.scrollIntoView({ block: "nearest" });
    const at = offset ?? area.value.length;
    area.setSelectionRange(at, at);
    area.addEventListener("input", () => this.fit(area));
    area.addEventListener("keydown", (e) => this.editKey(e));
    area.addEventListener("blur", () => this.close(true));
  }

  // The textarea is as many rules tall as its words take.
  fit(area) {
    const rule = Number.parseFloat(getComputedStyle(area).lineHeight) || 32;
    area.style.height = `${rule}px`;
    area.style.height = `${Math.max(1, Math.ceil((area.scrollHeight - 1) / rule)) * rule}px`;
  }

  editKey(e) {
    const ed = this.editing;
    if (!ed || e.isComposing) return;
    e.stopPropagation();
    const { area, row } = ed;
    if (e.key === "Enter") {
      e.preventDefault();
      this.close(true);
      row.focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close(false);
      row.focus();
    } else if (e.key === "ArrowUp" && area.selectionStart === 0 && area.selectionEnd === 0 && this.step(row, -1)) {
      e.preventDefault();
      this.edit(this.step(row, -1), null);
    } else if (e.key === "ArrowDown" && area.selectionStart === area.value.length && this.step(row, 1)) {
      e.preventDefault();
      this.edit(this.step(row, 1), 0);
    }
  }

  // Ends the edit; `keep` takes what was typed as the line's words, and none takes it out.
  close(keep) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const words = ed.area.value.replace(/\s+/g, " ").trim();
    const u = this.parsed.get(ed.n);
    const line = words ? u.prefix + ed.name + u.mid + words : null;
    if (keep && line !== this.fixes.text("transcript", ed.n)) {
      this.changed([{ file: "transcript", n: ed.n, text: line }], words ? { from: ed.words, to: words } : null);
    }
    this.patch(ed.row);
  }

  // The speakers of the transcript as it reads now, the most talkative first.
  speakers() {
    const count = new Map();
    for (const n of this.rows) {
      const now = this.current(n);
      if (now) count.set(now.name, (count.get(now.name) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }

  openMenu(row) {
    if (!this.fixes || this.locked) return;
    this.close(true);
    this.closeMenu();
    const doc = this.root.ownerDocument;
    const n = Number(row.dataset.line);
    const now = this.current(n) ?? this.parsed.get(n);
    const el = doc.createElement("div");
    el.className = "who-menu";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", "Who said this");
    const item = (text, act) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = text;
      b.onclick = act;
      el.append(b);
      return b;
    };
    for (const name of this.speakers().filter((s) => s !== now.name)) item(name, () => this.reassign(row, name));
    const other = item("Someone else…", () => {
      const input = doc.createElement("input");
      input.placeholder = "Their name";
      input.setAttribute("aria-label", "Who said this");
      input.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        this.reassign(row, input.value);
      };
      other.replaceWith(input);
      input.focus();
    });
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeMenu();
        row.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = [...el.querySelectorAll("button, input")];
        const i = items.indexOf(doc.activeElement);
        items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
      }
    });
    row.dataset.written = "";
    row.append(el);
    this.menu = { el, row };
    el.querySelector("button, input")?.focus();
  }

  closeMenu() {
    const menu = this.menu;
    if (!menu) return;
    this.menu = null;
    menu.el.remove();
  }

  reassign(row, name) {
    this.closeMenu();
    const n = Number(row.dataset.line);
    const u = this.parsed.get(n);
    const now = this.current(n) ?? { name: u.name, words: u.words };
    const clean = name.replace(/[*:[\]\n]/g, "").trim();
    if (clean && clean !== now.name) this.changed([{ file: "transcript", n, text: u.prefix + clean + u.mid + now.words }], null);
    row.focus();
  }

  setPlayable(on) {
    this.playable = on;
    this.root.classList.toggle("playable", on);
    if (!on) this.stop();
  }

  // Plays the row's stretch of the recording, to its end or the next row's start, and stops.
  async play(row) {
    if (!this.playable || row.dataset.start === undefined) return;
    if (this.playing?.row === row) return this.stop();
    this.stop();
    const start = Number(row.dataset.start);
    let end = Number(row.dataset.end ?? Number.NaN);
    if (!(end > start)) {
      let next = this.step(row, 1);
      while (next && next.dataset.start === undefined) next = this.step(next, 1);
      end = next ? Number(next.dataset.start) : start + 10;
    }
    if (!(end > start)) end = start + 5;
    const playing = { row, timer: null };
    this.playing = playing;
    row.classList.add("playing");
    this.audio.currentTime = start;
    try {
      await this.audio.play();
    } catch {
      if (this.playing === playing) this.stop();
      return;
    }
    if (this.playing !== playing) return;
    playing.timer = setTimeout(() => {
      if (this.playing === playing) this.stop();
    }, ((end - start) / (this.audio.playbackRate || 1)) * 1000 + 120);
  }

  stop() {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    clearTimeout(p.timer);
    p.row.classList.remove("playing");
    if (!this.audio.paused) this.audio.pause();
  }
}
