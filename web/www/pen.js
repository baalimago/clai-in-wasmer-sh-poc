// Pens that write the page's text by hand: each text that shows gets a pen of its own, which
// flies in from off the page, writes the text line by line (the text is revealed only behind
// its tip) and flies off again, so text written at the same time has as many pens flying. A
// pen also draws SVG strokes, its tip on the stroke's end. The pens live in a fixed layer over
// the whole page; with reduced motion, nothing is hidden and no pen shows.

const SVG = "http://www.w3.org/2000/svg";

// Pens and pencils, tip at (0, 0), held at an angle.
const KINDS = [
  { body: "#f5c430", light: "#ffd95a", dark: "#d9a514", cap: "#e98a8f", band: "#b9bcc2", wood: "#e8c592", tip: "#333" },
  { body: "#2f5bb8", light: "#5b84d8", dark: "#1f3f86", cap: "#1b2d5c", band: "#c9ced8", wood: "#d9dde4", tip: "#1f3a8a" },
  { body: "#c0392b", light: "#df5a4b", dark: "#8e2a1f", cap: "#6d1f17", band: "#c9ced8", wood: "#e8c592", tip: "#8e2a1f" },
  { body: "#3b3b3b", light: "#5a5a5a", dark: "#222", cap: "#111", band: "#b9bcc2", wood: "#e8c592", tip: "#222" },
  { body: "#3f9b6e", light: "#62bd8f", dark: "#2a6e4d", cap: "#e98a8f", band: "#b9bcc2", wood: "#e8c592", tip: "#333" },
];
const penSvg = (k, size) => `<g transform="scale(${(0.6 * size).toFixed(2)}) rotate(28)">
  <path d="M0 0 L29 -8 L29 8 Z" fill="${k.wood}"/><path d="M0 0 L8 -2.2 L8 2.2 Z" fill="${k.tip}"/>
  <rect x="29" y="-8" width="160" height="16" fill="${k.body}"/><rect x="29" y="-8" width="160" height="5" fill="${k.light}"/>
  <rect x="29" y="3" width="160" height="5" fill="${k.dark}"/><rect x="189" y="-9" width="16" height="18" fill="${k.band}"/>
  <rect x="205" y="-8" width="22" height="16" rx="3" fill="${k.cap}"/></g>`;

// Client rects of text, as the lines they make up: rects whose middles are within half a
// line of each other are one line, from the leftmost to the rightmost.
export function groupLines(rects) {
  const lines = [];
  for (const r of [...rects].filter((r) => r.right > r.left && r.bottom > r.top).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const mid = (r.top + r.bottom) / 2;
    const line = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - mid) < Math.max(4, (r.bottom - r.top) / 2));
    if (line) {
      line.left = Math.min(line.left, r.left);
      line.right = Math.max(line.right, r.right);
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
    } else {
      lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
  }
  return lines.sort((a, b) => a.top - b.top);
}

// How long a pen takes over lines this many pixels wide in all.
export const writingMs = (width) => Math.round(Math.min(1700, Math.max(260, width * 2.4)));

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A hidden page gets no animation frames: a timer moves the pens on there.
const frame = () => new Promise((resolve) => {
  const timer = setTimeout(resolve, 100);
  requestAnimationFrame(() => {
    clearTimeout(timer);
    resolve();
  });
});
const easeOut = (p) => 1 - (1 - p) ** 3;
const easeIn = (p) => p * p;

export class Pen {
  // `size` scales the pen, and `pace` every move it makes: 1.5 is half as slow again.
  constructor(layer, kind, { size = 1, pace = 1 } = {}) {
    this.size = size;
    this.pace = pace;
    this.el = layer.ownerDocument.createElementNS(SVG, "svg");
    this.el.classList.add("pen");
    this.el.setAttribute("width", "1");
    this.el.setAttribute("height", "1");
    this.el.innerHTML = penSvg(kind, size);
    layer.append(this.el);
    this.x = 0;
    this.y = 0;
  }

  place(x, y) {
    this.x = x;
    this.y = y;
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  async glide(x, y, ms, ease = easeOut) {
    const [x0, y0] = [this.x, this.y];
    const t0 = performance.now();
    for (;;) {
      const p = Math.min(1, (performance.now() - t0) / (ms * this.pace));
      const e = ease(p);
      this.place(x0 + (x - x0) * e, y0 + (y - y0) * e - Math.sin(p * Math.PI) * 30 * this.size);
      if (p >= 1) return;
      await frame();
    }
  }

  // From off the page, to (x, y).
  async flyIn(x, y) {
    const w = innerWidth;
    const h = innerHeight;
    const from = pickEdge(x, y, w, h);
    this.place(from[0], from[1]);
    this.el.classList.add("lifted");
    await this.glide(x, y, rand(320, 480));
    this.el.classList.remove("lifted");
  }

  async flyOff() {
    this.el.classList.add("lifted");
    const [x, y] = pickEdge(this.x, this.y, innerWidth, innerHeight);
    await this.glide(x, y, rand(300, 420), easeIn);
    this.el.remove();
  }

  // Lifted over to (x, y), as between lines.
  async hop(x, y, ms = 110) {
    this.el.classList.add("lifted");
    await this.glide(x, y, ms);
    this.el.classList.remove("lifted");
  }
}

// A point just off the page's nearest edge to (x, y), a little to the side.
function pickEdge(x, y, w, h) {
  const edges = [[x + rand(-260, 260), -90], [w + 120, y + rand(-220, 220)], [x + rand(-260, 260), h + 60]];
  if (x > w / 2) return edges[Math.random() < 0.6 ? 1 : 0];
  return edges[Math.random() < 0.7 ? 0 : 2];
}

export class Pens {
  constructor(doc, { calm } = {}) {
    this.doc = doc;
    this.calm = calm ?? matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.jobs = new WeakMap();
    this.layer = null;
  }

  // The pens about the page are small and quick by default.
  pen({ size = 0.7, pace = 0.6, kind = Math.floor(Math.random() * KINDS.length) } = {}) {
    if (!this.layer) {
      this.layer = this.doc.createElement("div");
      this.layer.className = "pens";
      this.layer.setAttribute("aria-hidden", "true");
      this.doc.body.append(this.layer);
    }
    return new Pen(this.layer, KINDS[kind], { size, pace });
  }

  // Writes `el` in with a pen of its own, after `delay`: it is hidden at once, so call this in
  // the task that shows it. A new write of the same element replaces one under way.
  async write(el, { delay = 0 } = {}) {
    if (this.calm || !el.getClientRects().length) return;
    const job = { cancelled: false };
    const old = this.jobs.get(el);
    if (old) old.cancelled = true;
    this.jobs.set(el, job);
    el.style.clipPath = "polygon(0 0, 0 0, 0 0)";
    if (delay) await sleep(delay);
    if (job.cancelled) return;
    const pen = this.pen();
    try {
      await this.writeWith(pen, el, job);
    } finally {
      if (this.jobs.get(el) === job) {
        el.style.clipPath = "";
        this.jobs.delete(el);
      }
      pen.flyOff();
    }
  }

  // `pen` writes `el`, flying in first if it is not on the page yet.
  async writeWith(pen, el, job = { cancelled: false }, { ms, fly = true } = {}) {
    const box = el.getBoundingClientRect();
    const lines = this.linesOf(el, box);
    if (!lines.length) return;
    const reveal = (k, x) => {
      const L = (v) => (v - box.left).toFixed(1);
      const T = (v) => (v - box.top).toFixed(1);
      const W = box.width + 16;
      const H = box.height + 16;
      const top = k === 0 ? "-16" : T(lines[k].top);
      const bottom = k === lines.length - 1 ? H : T(lines[k].bottom);
      el.style.clipPath = `polygon(-16px -16px, ${W}px -16px, ${W}px ${top}px, ${L(x)}px ${top}px, ` +
        `${L(x)}px ${bottom}px, -16px ${bottom}px)`;
    };
    reveal(0, lines[0].left - 2);
    const total = lines.reduce((sum, l) => sum + l.right - l.left, 0);
    const budget = (ms ?? writingMs(total)) * pen.pace;
    const tip = (l) => l.top + (l.bottom - l.top) * 0.76;
    if (fly) await pen.flyIn(lines[0].left, tip(lines[0]));
    else await pen.hop(lines[0].left, tip(lines[0]), 160);
    for (const [k, line] of lines.entries()) {
      if (job.cancelled) return;
      if (k > 0) await pen.hop(line.left, tip(line));
      const lineMs = Math.max(120, (budget * (line.right - line.left)) / Math.max(1, total));
      const t0 = performance.now();
      for (;;) {
        if (job.cancelled) return;
        const p = Math.min(1, (performance.now() - t0) / lineMs);
        const x = line.left + (line.right - line.left) * p;
        reveal(k, x + 3);
        pen.place(x, tip(line) + Math.sin(p * (line.right - line.left) / (5 * pen.size)) * 2.2 * pen.size);
        if (p >= 1) break;
        await frame();
      }
    }
  }

  // `pen` draws `path` (an SVG path on the page) over `ms`, its tip on the stroke's end.
  async draw(pen, path, ms, live = () => true) {
    const length = path.getTotalLength();
    path.style.strokeDasharray = `${length} ${length}`;
    path.style.strokeDashoffset = length;
    const at = (p) => {
      const point = path.getPointAtLength(length * p);
      return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM());
    };
    const start = at(0);
    await pen.hop(start.x, start.y, 180);
    const t0 = performance.now();
    while (live()) {
      const p = Math.min(1, (performance.now() - t0) / (ms * pen.pace));
      path.style.strokeDashoffset = length * (1 - p);
      const point = at(p);
      pen.place(point.x, point.y);
      if (p >= 1) return;
      await frame();
    }
  }

  linesOf(el, box) {
    if (el.matches("input, textarea, select")) {
      const text = el.value || el.placeholder || el.selectedOptions?.[0]?.text || "";
      const size = parseFloat(getComputedStyle(el).fontSize) || 16;
      const width = Math.min(box.width, Math.max(40, text.length * size * 0.42 + 14));
      const bottom = el.matches("textarea") ? box.top + Math.min(box.height, size * 1.4) : box.bottom;
      return [{ left: box.left, right: box.left + width, top: box.top, bottom }];
    }
    const rects = [];
    const walker = this.doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = this.doc.createRange();
    while (walker.nextNode()) {
      if (!walker.currentNode.data.trim()) continue;
      range.selectNodeContents(walker.currentNode);
      rects.push(...range.getClientRects());
    }
    for (const field of el.querySelectorAll("input, textarea, select")) rects.push(...this.linesOf(field, field.getBoundingClientRect()));
    // A line starts at the element's own edge, so its padding and background show with it.
    const lines = groupLines(rects).map((l) => ({ ...l, left: Math.min(l.left, box.left) }));
    return lines.length ? lines : box.width ? [{ left: box.left, right: box.right, top: box.top, bottom: box.bottom }] : [];
  }
}
