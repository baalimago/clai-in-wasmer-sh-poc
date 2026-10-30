// The B4 variants that write by hand (?look=b4b..b4d): when the app puts a title, a summary, a
// transcript or the agent's reply on the page, this writes it out word by word or letter by
// letter, with a pencil, a pen or a hand. It only restyles what the app rendered: the text in the
// page stays the same, and switching to another look shows it whole.

const MODES = {
  b4b: { unit: "word", delay: 55, budget: 3500, tool: "pencil" },
  b4c: { unit: "char", delay: 24, budget: 6000, tool: "pen", wobble: 1 },
  b4d: { unit: "char", delay: 42, budget: 8000, tool: "hand", wobble: 1.6, typos: 3, flip: true },
};
const TARGETS = ["#meeting-title", "#summary", "#transcript", "#agent-text"];
// Past this many letters, an element's rest appears at once instead of being written.
const MAX_UNITS = 1400;

const TOOLS = {
  pencil: `<svg width="230" height="20" viewBox="0 0 230 20" style="left:-1px;top:-10px">
    <path d="M1 10 L30 2 L30 18 Z" fill="#e8c592"/><path d="M1 10 L9 7.8 L9 12.2 Z" fill="#333"/>
    <rect x="30" y="2" width="160" height="16" fill="#f5c430"/><rect x="30" y="2" width="160" height="5" fill="#ffd95a"/>
    <rect x="30" y="13" width="160" height="5" fill="#d9a514"/><rect x="190" y="1" width="16" height="18" fill="#b9bcc2"/>
    <rect x="193" y="1" width="2" height="18" fill="#8e9298"/><rect x="200" y="1" width="2" height="18" fill="#8e9298"/>
    <rect x="206" y="2" width="22" height="16" rx="3" fill="#e98a8f"/></svg>`,
  pen: `<svg width="250" height="22" viewBox="0 0 250 22" style="left:-1px;top:-11px">
    <path d="M1 11 L26 4 Q34 11 26 18 Z" fill="#c9a24a"/><path d="M1 11 L26 10.4 L26 11.6 Z" fill="#6b5216"/>
    <circle cx="20" cy="11" r="1.6" fill="#6b5216"/><rect x="26" y="3" width="30" height="16" rx="3" fill="#1d1f24"/>
    <rect x="56" y="2" width="6" height="18" fill="#c9a24a"/><rect x="62" y="2" width="180" height="18" rx="8" fill="#16263f"/>
    <rect x="62" y="4" width="180" height="4" rx="2" fill="#3b5884"/><rect x="120" y="0" width="90" height="4" rx="2" fill="#c9a24a"/></svg>`,
};
// The hand is only its shadow on the paper, as if it were just above it.
TOOLS.hand = `${TOOLS.pen}<svg class="lp-hand" width="260" height="200" viewBox="0 0 260 200" style="left:30px;top:-30px">
    <filter id="lp-blur"><feGaussianBlur stdDeviation="9"/></filter>
    <path filter="url(#lp-blur)" fill="rgba(40, 22, 5, .26)" d="M30 40 C40 22 70 22 90 34 C110 30 150 40 180 60 C220 86 240 130 230 170 C220 196 170 200 130 186 C100 176 86 150 76 126 C60 104 40 80 30 40 Z M20 30 C40 26 70 38 92 52 L84 64 C60 54 36 46 20 30 Z"/></svg>`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const random = (spread) => (Math.random() - 0.5) * spread;
const BLOCKS = "p, li, h1, h2, h3, h4, blockquote, pre, td, th";

// One writer for the whole page: it writes one element at a time, like one hand would.
export class Writer {
  constructor(root) {
    this.root = root;
    this.doc = root.ownerDocument ?? root;
    this.state = new Map();
    this.queue = [];
    this.running = false;
    this.observer = new MutationObserver((records) => this.changed(records));
    this.tool = this.doc.createElement("div");
    this.tool.className = "lp-tool";
    this.tool.hidden = true;
  }

  get mode() {
    const look = this.doc.documentElement.dataset.look;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reduced ? undefined : MODES[look];
  }

  start() {
    const doc = this.doc;
    this.root.querySelector(".app")?.append(this.tool);
    for (const selector of TARGETS) {
      const el = this.root.querySelector(selector);
      if (el) this.observer.observe(el, { childList: true, characterData: true, subtree: true });
    }
    new MutationObserver(() => this.relook()).observe(doc.documentElement, { attributes: true, attributeFilter: ["data-look"] });
    this.relook();
  }

  targets() {
    return TARGETS.map((s) => this.root.querySelector(s)).filter(Boolean);
  }

  relook() {
    const mode = this.mode;
    this.queue = [];
    for (const [el, state] of this.state) {
      state.cancelled = true;
      if (state.source !== undefined) {
        el.innerHTML = state.written;
        el.classList.remove("lp-writing");
      }
    }
    this.state.clear();
    this.observer.takeRecords();
    this.tool.hidden = true;
    if (!mode) return;
    this.tool.innerHTML = TOOLS[mode.tool];
    this.tool.dataset.tool = mode.tool;
    for (const el of this.targets()) this.enqueue(el, mode, { fresh: true });
    this.run();
  }

  changed(records) {
    const mode = this.mode;
    if (!mode) return;
    const touched = new Set();
    for (const record of records) {
      const el = this.targets().find((t) => t.contains(record.target));
      if (el) touched.add(el);
    }
    for (const el of this.targets()) {
      if (!touched.has(el)) continue;
      const source = el.innerHTML;
      const old = this.state.get(el);
      if (old && old.source === source) continue;
      if (old && old.written === source) {
        // The app drew the same text again: keep what is already written.
        this.enqueue(el, mode, { from: old.done ? Infinity : old.index });
        continue;
      }
      if (el.id === "summary" && mode.flip && old) this.flip();
      this.enqueue(el, mode, { fresh: true });
    }
    this.run();
  }

  enqueue(el, mode, { from = 0 } = {}) {
    const old = this.state.get(el);
    if (old) old.cancelled = true;
    this.queue = this.queue.filter((job) => job.el !== el);
    const source = el.innerHTML;
    const job = { el, mode, written: source, source: undefined, index: 0, done: false, cancelled: false };
    job.units = this.wrap(el, mode);
    job.source = el.innerHTML;
    this.observer.takeRecords();
    this.state.set(el, job);
    if (from === Infinity || !el.getClientRects().length || !job.units.some((u) => !u.classList.contains("lp-sp"))) {
      this.finish(job);
      return;
    }
    for (const unit of job.units.slice(0, from)) this.show(unit, false);
    job.index = Math.min(from, job.units.length);
    el.classList.add("lp-writing");
    this.queue.push(job);
    this.queue.sort((a, b) => this.targets().indexOf(a.el) - this.targets().indexOf(b.el));
  }

  wrap(el, mode) {
    const doc = el.ownerDocument;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    const units = [];
    for (const text of texts) {
      if (!text.data.trim()) continue;
      const parts = text.data.split(/(\s+)/);
      const frag = doc.createDocumentFragment();
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          const space = doc.createElement("span");
          space.className = "lp-sp lp-u";
          space.textContent = part;
          frag.append(space);
          units.push(space);
          continue;
        }
        const word = doc.createElement("span");
        word.className = "lp-w";
        if (mode.unit === "word") {
          word.classList.add("lp-u");
          units.push(word);
        } else {
          for (const ch of part) {
            const c = doc.createElement("span");
            c.className = "lp-c lp-u";
            c.textContent = ch;
            if (mode.wobble) {
              c.style.setProperty("--r", `${random(5 * mode.wobble).toFixed(2)}deg`);
              c.style.setProperty("--y", `${random(1.4 * mode.wobble).toFixed(2)}px`);
            }
            word.append(c);
            units.push(c);
          }
        }
        if (mode.unit === "word") word.textContent = part;
        frag.append(word);
      }
      text.replaceWith(frag);
    }
    return units;
  }

  show(unit, fresh) {
    unit.classList.remove("lp-u");
    if (fresh) unit.classList.add("lp-fresh");
    unit.closest(BLOCKS)?.classList.add("lp-on");
  }

  finish(job) {
    for (const unit of job.units.slice(job.index)) this.show(unit, false);
    job.index = job.units.length;
    job.done = true;
    job.el.classList.remove("lp-writing");
    job.el.classList.add("lp-done");
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
      this.tool.hidden = true;
    }
  }

  async write(job) {
    const { el, mode, units } = job;
    const live = Math.min(units.length, MAX_UNITS);
    const delay = Math.min(mode.delay, mode.budget / Math.max(1, live - job.index));
    this.tool.hidden = false;
    let typos = mode.typos ?? 0;
    let block = null;
    while (job.index < live) {
      if (job.cancelled) return;
      const unit = units[job.index];
      if (unit.classList.contains("lp-sp")) {
        this.show(unit, false);
        job.index += 1;
        continue;
      }
      const at = unit.closest(BLOCKS);
      if (at !== block) {
        if (block) await this.lift(160 + delay * 4);
        block = at;
      }
      const word = unit.closest(".lp-w");
      if (typos && mode.unit === "char" && word.firstChild === unit && word.textContent.length > 4 && Math.random() < 0.07) {
        typos -= 1;
        await this.typo(job, word, delay);
        if (job.cancelled) return;
      }
      this.show(unit, true);
      this.point(unit);
      job.index += 1;
      const ch = unit.textContent;
      let wait = mode.unit === "char" && mode.typos ? delay * (0.5 + Math.random()) : delay;
      if (/[.,;:!?]$/.test(ch)) wait += delay * 4;
      if (word.lastChild === unit && mode.unit === "char") wait += delay * 1.5;
      await sleep(wait);
    }
    if (!job.cancelled) this.finish(job);
  }

  async typo(job, word, delay) {
    const doc = word.ownerDocument;
    const text = word.textContent;
    const i = 1 + Math.floor(Math.random() * (text.length - 2));
    const wrong = text.slice(0, i) + text[i + 1] + text[i] + text.slice(i + 2, i + 3);
    const slip = doc.createElement("span");
    slip.className = "lp-w lp-typo";
    slip.setAttribute("aria-hidden", "true");
    word.before(slip, " ");
    this.observer.takeRecords();
    for (const ch of wrong) {
      const c = doc.createElement("span");
      c.className = "lp-c lp-fresh";
      c.textContent = ch;
      slip.append(c);
      this.observer.takeRecords();
      this.point(c);
      await sleep(delay * (0.6 + Math.random()));
      if (job.cancelled) return;
    }
    await this.lift(delay * 8);
    slip.classList.add("lp-struck");
    await sleep(380);
  }

  async lift(ms) {
    this.tool.classList.add("lp-lift");
    await sleep(ms);
    this.tool.classList.remove("lp-lift");
  }

  point(unit) {
    const app = this.tool.parentElement;
    if (!app) return;
    const box = app.getBoundingClientRect();
    const rect = unit.getBoundingClientRect();
    const x = rect.right - box.left;
    const y = rect.top + rect.height * 0.72 - box.top;
    this.tool.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    this.tool.classList.toggle("lp-bob");
  }

  flip() {
    const app = this.root.querySelector(".app");
    if (!app) return;
    app.classList.remove("lp-flip");
    void app.offsetWidth;
    app.classList.add("lp-flip");
    setTimeout(() => app.classList.remove("lp-flip"), 1100);
  }
}

new Writer(document).start();
