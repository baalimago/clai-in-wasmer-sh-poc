// While the agent starts, and while it transcribes, summarizes and saves a recording, the pencil
// doodles on the empty part of the pad: loops, stars, cubes, clouds, and now and then a line from
// the machine's own event log (what the peek shows), scribbled over as many rules as it takes and
// boxed, circled or crossed out. It runs while the recording bar has the class "waiting" or
// "summarizing", and rubs everything out when neither is left.

const SVG = "http://www.w3.org/2000/svg";
const RULE = 32;
const BASE = 24;
// A log line wraps onto the next rule past this many letters, as far as this many rules.
const LINE_CHARS = 46;
const MAX_LINES = 8;

const PENCIL = `<g transform="scale(.6) rotate(28)">
  <path d="M0 0 L29 -8 L29 8 Z" fill="#e8c592"/><path d="M0 0 L8 -2.2 L8 2.2 Z" fill="#333"/>
  <rect x="29" y="-8" width="160" height="16" fill="#f5c430"/><rect x="29" y="-8" width="160" height="5" fill="#ffd95a"/>
  <rect x="29" y="3" width="160" height="5" fill="#d9a514"/><rect x="189" y="-9" width="16" height="18" fill="#b9bcc2"/>
  <rect x="192" y="-9" width="2" height="18" fill="#8e9298"/><rect x="199" y="-9" width="2" height="18" fill="#8e9298"/>
  <rect x="205" y="-8" width="22" height="16" rx="3" fill="#e98a8f"/></g>`;

// An ellipse in four arcs, a little past its start, as a pen goes round a word.
const ellipse = (cx, cy, rx, ry) => {
  const k = 0.5523;
  return `M${pt(cx, cy - ry)} C${pt(cx + k * rx, cy - ry)} ${pt(cx + rx, cy - k * ry)} ${pt(cx + rx, cy)}` +
    ` C${pt(cx + rx, cy + k * ry)} ${pt(cx + k * rx, cy + ry)} ${pt(cx, cy + ry)}` +
    ` C${pt(cx - k * rx, cy + ry)} ${pt(cx - rx, cy + k * ry)} ${pt(cx - rx, cy)}` +
    ` C${pt(cx - rx, cy - k * ry)} ${pt(cx - k * rx, cy - ry - 3)} ${pt(cx + rx * 0.3, cy - ry + 2)}`;
};
// Splits text into lines of at most `width` letters at spaces, breaking a longer word, in at
// most `max` lines; the last one ends in "…" if the text is longer still.
export const wrapWords = (text, width, max) => {
  const lines = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) lines.push(line);
      lines.push(word.slice(0, width));
      word = word.slice(width);
      line = "";
    }
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = `${kept[max - 1].slice(0, width - 1)}…`;
  return kept;
};
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const j = (n = 1.5) => rand(-n, n);
const pt = (x, y) => `${(x + j()).toFixed(1)} ${(y + j()).toFixed(1)}`;

// Shapes in a box from (0, 0) to (w, h): each returns the path data, drawn as one stroke.
const SHAPES = {
  coil: { w: 150, h: 26, d: (w, h) => { let s = `M0 ${h}`; for (let t = 0; t <= 7 * Math.PI * 2; t += 0.35) s += ` L${pt(6 + t * 4.6 - 11 * Math.sin(t), h / 2 + 11 * Math.cos(t + Math.PI))}`; return s; } },
  spiral: { w: 60, h: 60, d: () => { let s = "M30 30"; for (let t = 0; t <= 5.5 * Math.PI * 2; t += 0.25) s += ` L${pt(30 + t * 0.85 * Math.cos(t), 30 + t * 0.85 * Math.sin(t), 0.6)}`; return s; } },
  star: { w: 56, h: 54, d: () => { const p = [0, 2, 4, 1, 3, 0].map((i) => [28 + 26 * Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / 5), 29 + 26 * Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / 5)]); return `M${p.map(([x, y]) => pt(x, y)).join(" L")}`; } },
  cube: { w: 62, h: 62, d: () => `M${pt(4, 18)} L${pt(42, 18)} L${pt(42, 58)} L${pt(4, 58)} Z M${pt(4, 18)} L${pt(20, 4)} L${pt(58, 4)} L${pt(42, 18)} M${pt(58, 4)} L${pt(58, 44)} L${pt(42, 58)}` },
  waves: { w: 160, h: 22, d: (w, h) => { let s = `M0 ${h / 2}`; for (let x = 0; x <= w; x += 20) s += ` Q${pt(x + 5, x % 40 ? h : 0)} ${pt(x + 10, h / 2)} T${pt(x + 20, h / 2)}`; return s; } },
  cloud: { w: 96, h: 48, d: () => `M${pt(14, 44)} C${pt(-4, 44)} ${pt(0, 20)} ${pt(18, 24)} C${pt(18, 4)} ${pt(46, 0)} ${pt(52, 16)} C${pt(62, 2)} ${pt(90, 8)} ${pt(82, 26)} C${pt(98, 30)} ${pt(94, 46)} ${pt(80, 44)} Z` },
  hatch: { w: 66, h: 46, d: (w, h) => {
    let s = `M${pt(2, 2)} L${pt(w - 2, 2)} L${pt(w - 2, h - 2)} L${pt(2, h - 2)} Z`;
    for (let x = 2; x < w - 4; x += 9) { const x2 = Math.min(w - 2, x + h - 4); s += ` M${pt(x, 2, 0.5)} L${pt(x2, 2 + x2 - x, 0.5)}`; }
    for (let y = 11; y < h - 4; y += 9) { const x2 = Math.min(w - 2, 2 + h - 2 - y); s += ` M${pt(2, y, 0.5)} L${pt(x2, y + x2 - 2, 0.5)}`; }
    return s;
  } },
  sun: { w: 64, h: 64, d: () => { let s = "M46 32"; for (let t = 0; t <= Math.PI * 2 + 0.3; t += 0.3) s += ` L${pt(32 + 14 * Math.cos(t), 32 + 14 * Math.sin(t), 0.8)}`; for (let i = 0; i < 10; i++) { const a = (i * Math.PI) / 5; s += ` M${pt(32 + 20 * Math.cos(a), 32 + 20 * Math.sin(a), 0.5)} L${pt(32 + 29 * Math.cos(a), 32 + 29 * Math.sin(a), 0.8)}`; } return s; } },
  arrow: { w: 120, h: 40, d: () => `M${pt(2, 30)} C${pt(30, 0)} ${pt(60, 44)} ${pt(110, 14)} M${pt(96, 8)} L${pt(112, 13)} L${pt(102, 26)}` },
  flower: { w: 60, h: 60, d: () => { let s = ""; for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; const x = 30 + 16 * Math.cos(a), y = 30 + 16 * Math.sin(a); s += ` M${pt(30, 30, 0.5)} Q${pt(x + 12 * Math.cos(a + 0.9), y + 12 * Math.sin(a + 0.9))} ${pt(30 + 26 * Math.cos(a), 30 + 26 * Math.sin(a))} Q${pt(x + 12 * Math.cos(a - 0.9), y + 12 * Math.sin(a - 0.9))} ${pt(30, 30, 0.5)}`; } return s.trim(); } },
  hash: { w: 44, h: 44, d: () => `M${pt(14, 2)} L${pt(10, 42)} M${pt(32, 2)} L${pt(28, 42)} M${pt(2, 14)} L${pt(42, 14)} M${pt(2, 30)} L${pt(42, 30)}` },
};

// How a scribbled log line gets marked once it is written.
const MARKS = ["underline", "box", "circle", "strike", "arrow", "none"];

export class Doodles {
  constructor(doc, model) {
    this.doc = doc;
    this.model = model;
    this.layer = null;
    this.run = 0;
    this.seen = new Set();
  }

  start() {
    const bar = this.doc.querySelector("#recbar");
    if (!bar || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const check = () => {
      const on = (bar.classList.contains("waiting") || bar.classList.contains("summarizing")) && !bar.hidden;
      if (on && !this.layer) this.begin();
      if (!on && this.layer) this.end();
    };
    new MutationObserver(check).observe(bar, { attributes: true, attributeFilter: ["class", "hidden"] });
    check();
  }

  begin() {
    const content = this.doc.querySelector(".content");
    if (!content) return;
    this.content = content;
    const layer = this.doc.createElementNS(SVG, "svg");
    layer.classList.add("doodles");
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("width", content.scrollWidth);
    layer.setAttribute("height", content.scrollHeight);
    this.ink = this.doc.createElementNS(SVG, "g");
    this.pencil = this.doc.createElementNS(SVG, "g");
    this.pencil.classList.add("doodle-pencil");
    this.pencil.innerHTML = PENCIL;
    layer.append(this.ink, this.pencil);
    content.append(layer);
    this.layer = layer;
    this.placed = [];
    // Log lines from before now are fair game too, but the newest come first.
    this.since = this.model?.log?.length ?? 0;
    this.loop(++this.run);
  }

  end() {
    this.run += 1;
    const layer = this.layer;
    this.layer = null;
    layer.classList.add("gone");
    setTimeout(() => layer.remove(), 700);
  }

  // The free part of the pad, in the content's coordinates: below the cards, and the margin.
  areas() {
    const c = this.content;
    const box = c.getBoundingClientRect();
    const cards = c.querySelector(".cards")?.getBoundingClientRect();
    const top = cards ? cards.bottom - box.top + c.scrollTop : c.scrollTop + 300;
    const first = Math.ceil((top + RULE) / RULE) * RULE;
    const bottom = c.scrollTop + c.clientHeight - RULE;
    return {
      page: { x: 110, y: first, w: c.clientWidth - 110 - 56, h: bottom - first },
      margin: { x: 8, y: c.scrollTop + 3 * RULE, w: 66, h: bottom - c.scrollTop - 3 * RULE },
    };
  }

  place(w, h, { onRule = false, margin = false } = {}) {
    const { page, margin: side } = this.areas();
    const area = margin ? side : page;
    if (w > area.w || h > area.h) return null;
    for (let i = 0; i < 40; i++) {
      let x = area.x + rand(0, area.w - w);
      let y = area.y + rand(0, area.h - h);
      if (onRule) y = Math.floor(y / RULE) * RULE;
      const r = { x, y, w, h };
      if (y + h > area.y + area.h) continue;
      if (this.placed.some((p) => r.x < p.x + p.w + 14 && p.x < r.x + r.w + 14 && r.y < p.y + p.h + 8 && p.y < r.y + r.h + 8)) continue;
      return r;
    }
    return null;
  }

  nextLine() {
    const log = this.model?.log ?? [];
    const fresh = log.slice(this.since).filter((e) => !this.seen.has(e));
    const recent = log.slice(-80);
    const unseen = recent.filter((e) => !this.seen.has(e));
    const pool = fresh.length ? fresh : unseen.length ? unseen : recent;
    if (!pool.length) return null;
    const e = fresh.length ? fresh[0] : pick(pool);
    this.seen.add(e);
    return `${e.kind}: ${e.text}`;
  }

  async loop(run) {
    const live = () => run === this.run && this.layer;
    await sleep(500);
    while (live()) {
      const line = Math.random() < 0.5 ? this.nextLine() : null;
      const done = line ? await this.scribble(line, live) : await this.shape(live);
      if (!done && live()) await this.rubOut();
      await sleep(rand(250, 900));
    }
  }

  async shape(live) {
    const name = pick(Object.keys(SHAPES));
    const shape = SHAPES[name];
    const scale = rand(0.8, 1.15);
    const margin = shape.w * scale <= 66 && Math.random() < 0.35;
    const spot = this.place(shape.w * scale, shape.h * scale, { margin });
    if (!spot) return false;
    this.placed.push(spot);
    const g = this.group(spot);
    const path = this.stroke(g, shape.d(shape.w, shape.h));
    path.setAttribute("transform", `scale(${scale.toFixed(2)}) rotate(${j(6).toFixed(1)} ${shape.w / 2} ${shape.h / 2})`);
    await this.draw(path, rand(900, 1800), live);
    return true;
  }

  async scribble(entry, live) {
    const g = this.group({ x: 0, y: 0 });
    const texts = wrapWords(entry, LINE_CHARS, MAX_LINES).map((line) => {
      const text = this.doc.createElementNS(SVG, "text");
      text.textContent = line;
      g.append(text);
      return text;
    });
    const widths = texts.map((t) => t.getComputedTextLength());
    const width = Math.max(...widths);
    const spot = this.place(width + 30, RULE * (texts.length + 1), { onRule: true });
    if (!spot) {
      g.remove();
      return false;
    }
    this.placed.push(spot);
    const x = spot.x + 10;
    const top = spot.y + BASE;
    const tilt = j(0.8).toFixed(2);
    for (const [i, text] of texts.entries()) {
      const y = top + i * RULE;
      text.setAttribute("x", x);
      text.setAttribute("y", y);
      text.setAttribute("transform", `rotate(${tilt} ${x} ${top})`);
      text.style.visibility = "hidden";
    }
    for (const [i, text] of texts.entries()) {
      if (!live()) return true;
      await this.write(g, text, x, top + i * RULE, widths[i], live);
    }
    if (!live()) return true;
    const last = top + (texts.length - 1) * RULE;
    const kinds = texts.length > 1 ? MARKS.filter((k) => k !== "strike" && k !== "circle") : MARKS;
    const mark = this.mark(pick(kinds), x, top, width, last, widths.at(-1));
    if (mark) {
      g.append(mark);
      await this.draw(mark, 600, live);
    }
    return true;
  }

  async write(g, text, x, y, width, live) {
    const clip = this.doc.createElementNS(SVG, "clipPath");
    clip.id = `doodle-${Math.random().toString(36).slice(2)}`;
    const reveal = this.doc.createElementNS(SVG, "rect");
    reveal.setAttribute("x", x - 4);
    reveal.setAttribute("y", y - BASE - 8);
    reveal.setAttribute("height", RULE + 16);
    reveal.setAttribute("width", 0);
    clip.append(reveal);
    g.append(clip);
    text.setAttribute("clip-path", `url(#${clip.id})`);
    text.style.visibility = "";
    const ms = Math.min(3200, text.textContent.length * 55);
    const t0 = performance.now();
    while (live()) {
      const p = Math.min(1, (performance.now() - t0) / ms);
      const w = width * p;
      reveal.setAttribute("width", w + 6);
      this.move(x + w, y - 3 + Math.sin(p * 90) * 2);
      if (p >= 1) break;
      await frame();
    }
  }

  // Marks a block of lines from the baseline y (the first) to last, w wide, whose last line is
  // tail wide.
  mark(kind, x, y, w, last = y, tail = w) {
    const d = {
      underline: `M${pt(x - 2, last + 6)} Q${pt(x + tail / 2, last + 10)} ${pt(x + tail + 4, last + 5)}`,
      box: `M${pt(x - 8, y - 24)} L${pt(x + w + 8, y - 25)} L${pt(x + w + 9, last + 8)} L${pt(x - 7, last + 9)} Z`,
      circle: ellipse(x + w / 2, y - 8, w / 2 + 16, 21),
      strike: `M${pt(x - 4, y - 8)} L${pt(x + w + 4, y - 10)}`,
      arrow: `M${pt(x + tail + 50, last - 30)} Q${pt(x + tail + 30, last - 6)} ${pt(x + tail + 8, last - 8)} M${pt(x + tail + 18, last - 16)} L${pt(x + tail + 7, last - 8)} L${pt(x + tail + 18, last)}`,
    }[kind];
    if (!d) return null;
    const path = this.doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    if (kind === "circle" || kind === "box") path.classList.add("pen");
    return path;
  }

  group(spot) {
    const g = this.doc.createElementNS(SVG, "g");
    g.setAttribute("transform", `translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)})`);
    this.ink.append(g);
    return g;
  }

  stroke(g, d) {
    const path = this.doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    g.append(path);
    return path;
  }

  async draw(path, ms, live) {
    const length = path.getTotalLength();
    path.style.strokeDasharray = `${length} ${length}`;
    path.style.strokeDashoffset = length;
    const t0 = performance.now();
    while (live()) {
      const p = Math.min(1, (performance.now() - t0) / ms);
      path.style.strokeDashoffset = length * (1 - p);
      const at = path.getPointAtLength(length * p);
      const m = path.getCTM();
      const layer = this.layer.getCTM();
      const point = new DOMPoint(at.x, at.y).matrixTransform(layer.inverse().multiply(m));
      this.move(point.x, point.y);
      if (p >= 1) break;
      await frame();
    }
  }

  move(x, y) {
    this.pencil.setAttribute("transform", `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
  }

  async rubOut() {
    const old = [...this.ink.children].slice(0, Math.max(1, Math.ceil(this.ink.children.length / 2)));
    for (const g of old) g.classList.add("gone");
    await sleep(700);
    for (const g of old) g.remove();
    this.placed.splice(0, old.length);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
