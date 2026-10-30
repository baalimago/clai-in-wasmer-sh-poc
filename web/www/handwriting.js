// Writes out by hand what the app puts on the pad: when the title, the summary, the transcript or
// the agent's reply changes, a pencil writes it word by word, one element after the other. It
// only wraps the words the app rendered in spans: the text stays the same.

const TARGETS = ["#meeting-title", "#summary", "#transcript", "#agent-text"];
// Each element is written in about this long at most, however long its text is.
const BUDGET_MS = 3500;
const WORD_MS = 55;
// Past this many words, an element's rest appears at once instead of being written.
const MAX_WORDS = 1400;
const BLOCKS = "p, li, h1, h2, h3, h4, blockquote, pre, td, th";

const PENCIL = `<svg width="230" height="20" viewBox="0 0 230 20" aria-hidden="true">
  <path d="M1 10 L30 2 L30 18 Z" fill="#e8c592"/><path d="M1 10 L9 7.8 L9 12.2 Z" fill="#333"/>
  <rect x="30" y="2" width="160" height="16" fill="#f5c430"/><rect x="30" y="2" width="160" height="5" fill="#ffd95a"/>
  <rect x="30" y="13" width="160" height="5" fill="#d9a514"/><rect x="190" y="1" width="16" height="18" fill="#b9bcc2"/>
  <rect x="193" y="1" width="2" height="18" fill="#8e9298"/><rect x="200" y="1" width="2" height="18" fill="#8e9298"/>
  <rect x="206" y="2" width="22" height="16" rx="3" fill="#e98a8f"/></svg>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Handwriting {
  constructor(doc) {
    this.doc = doc;
    this.jobs = new Map();
    this.queue = [];
    this.running = false;
    this.observer = new MutationObserver((records) => this.changed(records));
    this.pencil = doc.createElement("div");
    this.pencil.className = "pencil";
    this.pencil.hidden = true;
    this.pencil.innerHTML = PENCIL;
  }

  start() {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.doc.querySelector(".app")?.append(this.pencil);
    for (const el of this.targets()) {
      this.observer.observe(el, { childList: true, characterData: true, subtree: true });
      this.enqueue(el, 0);
    }
    this.run();
  }

  targets() {
    return TARGETS.map((s) => this.doc.querySelector(s)).filter(Boolean);
  }

  changed(records) {
    const touched = new Set();
    for (const record of records) {
      const el = this.targets().find((t) => t.contains(record.target));
      if (el) touched.add(el);
    }
    for (const el of touched) {
      const old = this.jobs.get(el);
      const html = el.innerHTML;
      if (old?.wrapped === html) continue;
      // The app drew the same text again: keep what is already written.
      const from = old?.source === html ? (old.done ? Infinity : old.index) : 0;
      this.enqueue(el, from);
    }
    this.run();
  }

  enqueue(el, from) {
    const old = this.jobs.get(el);
    if (old) old.cancelled = true;
    this.queue = this.queue.filter((job) => job.el !== el);
    const job = { el, source: el.innerHTML, index: 0, done: false, cancelled: false };
    job.units = this.wrap(el);
    job.wrapped = el.innerHTML;
    this.observer.takeRecords();
    this.jobs.set(el, job);
    if (from === Infinity || !el.getClientRects().length || !job.units.some((u) => u.classList.contains("hw-word"))) {
      this.finish(job);
      return;
    }
    for (const unit of job.units.slice(0, from)) this.show(unit, false);
    job.index = Math.min(from, job.units.length);
    el.classList.add("hw-writing");
    this.queue.push(job);
    this.queue.sort((a, b) => this.targets().indexOf(a.el) - this.targets().indexOf(b.el));
  }

  // Wraps each word, and each run of spaces, in a span that stays hidden until it is written.
  wrap(el) {
    const walker = this.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    const units = [];
    for (const text of texts) {
      if (!text.data.trim()) continue;
      const frag = this.doc.createDocumentFragment();
      for (const part of text.data.split(/(\s+)/)) {
        if (!part) continue;
        const span = this.doc.createElement("span");
        span.className = /^\s+$/.test(part) ? "hw-space hw-unwritten" : "hw-word hw-unwritten";
        span.textContent = part;
        frag.append(span);
        units.push(span);
      }
      text.replaceWith(frag);
    }
    return units;
  }

  show(unit, fresh) {
    unit.classList.remove("hw-unwritten");
    if (fresh) unit.classList.add("hw-fresh");
    unit.closest(BLOCKS)?.classList.add("hw-on");
  }

  finish(job) {
    for (const unit of job.units.slice(job.index)) this.show(unit, false);
    job.index = job.units.length;
    job.done = true;
    job.el.classList.remove("hw-writing");
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue.shift();
        if (!job.cancelled) await this.write(job);
      }
    } finally {
      this.running = false;
      this.pencil.hidden = true;
    }
  }

  async write(job) {
    const words = job.units.filter((u) => u.classList.contains("hw-word"));
    const last = words[Math.min(words.length, MAX_WORDS) - 1];
    const live = job.units.indexOf(last) + 1;
    const delay = Math.min(WORD_MS, BUDGET_MS / Math.max(1, words.length));
    this.pencil.hidden = false;
    let block = null;
    while (job.index < live) {
      if (job.cancelled) return;
      const unit = job.units[job.index];
      job.index += 1;
      if (unit.classList.contains("hw-space")) {
        this.show(unit, false);
        continue;
      }
      const at = unit.closest(BLOCKS);
      if (at !== block) {
        if (block) await this.lift(160 + delay * 4);
        if (job.cancelled) return;
        block = at;
      }
      this.show(unit, true);
      this.point(unit);
      await sleep(delay);
    }
    if (!job.cancelled) this.finish(job);
  }

  async lift(ms) {
    this.pencil.classList.add("lifted");
    await sleep(ms);
    this.pencil.classList.remove("lifted");
  }

  point(unit) {
    const app = this.pencil.parentElement;
    if (!app) return;
    const box = app.getBoundingClientRect();
    const rect = unit.getBoundingClientRect();
    const x = rect.right - box.left;
    const y = rect.top + rect.height * 0.72 - box.top;
    this.pencil.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}

new Handwriting(document).start();
