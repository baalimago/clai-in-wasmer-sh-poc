// While the machine boots, the login is checked and the notes are fetched, a pen writes each
// step on the pad and draws a checkbox before it; with nothing else to add it doodles, and as
// the steps finish it ticks their boxes off one by one. Then an eraser rubs it all out and the
// app arrives on the pad: the sticky note is put down (pad.css), and every text of the app is
// written in by a pen of its own (pen.js), as is text that shows or changes later. Minutes says
// how far it got in #app's data-phase; the app shows once #app has the class "arrived".

import { Pens } from "./pen.js";
import { SHAPES } from "./doodles.js";

export const STEPS = {
  booting: "Waking up the machine…",
  checking: "Looking for your slivingdoc login…",
  fetching: "Fetching your notes from slivingdoc…",
  listing: "Reading the notes kept in this tab…",
};

// The lines to write for the phases Minutes went through, in order: a phase is written once,
// and nothing after "ready".
export function stepsFor(phases) {
  const lines = [];
  for (const phase of phases) {
    if (phase === "ready") break;
    const text = STEPS[phase];
    if (text && !lines.includes(text)) lines.push(text);
  }
  return lines;
}

// How many of `count` written steps are over: all of them once Minutes is ready, else all
// but the one under way.
export const stepsOver = (count, ready) => (ready ? count : Math.max(0, count - 1));

// What a pen writes in when it shows. The sticky note is put down whole instead, and a
// meeting's notes are handwriting.js's.
const WRITTEN = [
  ".setup > .card:not(#notebook-card) > :is(label, p)", ".setup > .card:not(#notebook-card) .row > *",
  "[data-view=record] > h1", "#record-form > *", "#empty", ".notebook > *", "#status",
  "#meetings .sidehead", "#meetings .meeting > *",
].join(", ");
const REWRITTEN = ["#machine-chip", "#notebook-chip", "#key-chip", "#status", "#notebook-status"];
const HEADER = ".brand strong, .tagline, .chip, .chips > button:not([hidden])";

const RULE = 32;
const BOX = 20;
const ERASE_MS = 900;
const SVG = "http://www.w3.org/2000/svg";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

export class Arrival {
  constructor(doc, pens = new Pens(doc)) {
    this.doc = doc;
    this.pens = pens;
    this.app = doc.querySelector("#app");
    this.list = doc.querySelector("#loading");
    this.phases = [];
    this.waiting = null;
    this.calm = pens.calm;
    // ?slowload=SECONDS keeps the loading on the pad at least that long, to watch it.
    const hold = Number(new URLSearchParams(doc.location?.search ?? "").get("slowload")) || 0;
    this.holdUntil = performance.now() + hold * 1000;
    if (hold) setTimeout(() => this.wake(), hold * 1000);
  }

  wake() {
    const wake = this.waiting;
    this.waiting = null;
    wake?.();
  }

  start() {
    if (!this.app || !this.list) return;
    this.phases.push(this.app.dataset.phase ?? "booting");
    // Phases that change within one task reach the observer together: their old values keep
    // the ones in between.
    new MutationObserver((records) => {
      for (const phase of [...records.map((r) => r.oldValue), this.app.dataset.phase]) {
        if (phase && phase !== this.phases.at(-1)) this.phases.push(phase);
      }
      this.wake();
    }).observe(this.app, { attributes: true, attributeFilter: ["data-phase"], attributeOldValue: true });
    this.watch();
    this.run();
  }

  get ready() {
    return this.phases.includes("ready") && performance.now() >= this.holdUntil;
  }

  async run() {
    if (this.calm) {
      while (!this.ready) await new Promise((resolve) => (this.waiting = resolve));
      return this.arrive();
    }
    await Promise.race([this.doc.fonts?.ready, sleep(1500)]);
    for (const [i, el] of [...this.doc.querySelectorAll(HEADER)].entries()) this.pens.write(el, { delay: i * 90 });
    this.ink = this.doc.createElementNS(SVG, "svg");
    this.ink.classList.add("loader-ink");
    this.list.append(this.ink);
    this.pen = this.pens.pen();
    this.doodles = [];
    const lines = [];
    let seen = 0;
    let flown = false;
    for (;;) {
      // Behind Minutes, the pen hurries.
      const hurry = seen < this.phases.length || this.ready ? 0.55 : 1;
      if (seen < this.phases.length) {
        const text = stepsFor([this.phases[seen++]])[0];
        if (!text || lines.some((l) => l.text === text)) continue;
        lines.push(await this.writeStep(text, hurry, flown));
        flown = true;
        continue;
      }
      const unboxed = lines.find((l) => !l.box);
      if (unboxed) {
        unboxed.box = await this.stroke(this.boxPath(lines.indexOf(unboxed)), 420 * hurry);
        continue;
      }
      const over = stepsOver(lines.length, this.ready);
      const due = lines.slice(0, over).find((l) => !l.ticked);
      if (due) {
        due.ticked = true;
        due.li.classList.add("done");
        await this.stroke(this.tickPath(lines.indexOf(due)), 300 * hurry, "tick");
        continue;
      }
      if (this.ready) break;
      await this.doodle(lines.length);
    }
    await this.erase();
  }

  async writeStep(text, hurry, flown) {
    const li = this.doc.createElement("li");
    const ink = this.doc.createElement("span");
    ink.className = "ink";
    ink.textContent = text;
    li.append(ink);
    this.list.insertBefore(li, this.ink);
    ink.style.clipPath = "polygon(0 0, 0 0, 0 0)";
    await this.pens.writeWith(this.pen, ink, undefined, { ms: text.length * 34 * hurry, fly: !flown });
    ink.style.clipPath = "";
    return { text, li };
  }

  boxPath(i) {
    const y = i * RULE + 5;
    const p = (x, yy) => `${(x + rand(-1, 1)).toFixed(1)} ${(yy + rand(-1, 1)).toFixed(1)}`;
    return `M${p(4, y)} L${p(4 + BOX, y)} L${p(4 + BOX, y + BOX)} L${p(4, y + BOX)} L${p(4, y + 1)}`;
  }

  tickPath(i) {
    const y = i * RULE + 5;
    return `M7 ${y + 10} L12 ${y + 17} L${4 + BOX + 6} ${y - 6}`;
  }

  async stroke(d, ms, kind = "") {
    const path = this.doc.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    if (kind) path.classList.add(kind);
    this.ink.append(path);
    await this.pens.draw(this.pen, path, ms);
    return path;
  }

  // One doodle on the pad below the steps, rubbing out the oldest when there is no room.
  async doodle(count) {
    const content = this.list.parentElement;
    const area = {
      x: 40, y: (count + 1) * RULE,
      w: content.clientWidth - 110 - 56 - 80, h: content.clientHeight - 3 * RULE - (count + 2) * RULE,
    };
    const shape = SHAPES[pick(Object.keys(SHAPES))];
    const scale = rand(0.8, 1.2);
    const w = shape.w * scale;
    const h = shape.h * scale;
    let spot = null;
    for (let i = 0; i < 30 && !spot && area.w > w && area.h > h; i++) {
      const r = { x: area.x + rand(0, area.w - w), y: area.y + rand(0, area.h - h), w, h };
      if (!this.doodles.some((d) => r.x < d.x + d.w + 16 && d.x < r.x + r.w + 16 && r.y < d.y + d.h + 12 && d.y < r.y + r.h + 12)) spot = r;
    }
    if (!spot) {
      const old = this.doodles.splice(0, Math.max(1, Math.ceil(this.doodles.length / 2)));
      for (const d of old) d.path.classList.add("gone");
      await sleep(400);
      for (const d of old) d.path.remove();
      return;
    }
    const path = this.doc.createElementNS(SVG, "path");
    path.setAttribute("d", shape.d(shape.w, shape.h));
    path.setAttribute("transform", `translate(${spot.x.toFixed(1)} ${spot.y.toFixed(1)}) scale(${scale.toFixed(2)})`);
    path.classList.add("doodle");
    this.ink.append(path);
    this.doodles.push({ ...spot, path });
    await this.pens.draw(this.pen, path, rand(900, 1500));
  }

  async erase() {
    this.pen.flyOff();
    const eraser = this.doc.createElement("span");
    eraser.className = "eraser";
    eraser.setAttribute("aria-hidden", "true");
    eraser.style.setProperty("--far", `${Math.max(120, this.list.offsetWidth - 40)}px`);
    this.list.append(eraser);
    this.list.classList.add("erasing");
    await sleep(ERASE_MS * 0.55);
    this.arrive();
    await sleep(ERASE_MS * 0.45);
    this.list.hidden = true;
  }

  arrive() {
    this.app.classList.add("arrived");
    this.app.setAttribute("aria-busy", "false");
    this.writeIn(this.app);
  }

  // Every text in `root` that shows is written in, each by its own pen, a little apart.
  writeIn(root) {
    const targets = [...(root.matches?.(WRITTEN) ? [root] : []), ...root.querySelectorAll(WRITTEN)];
    let i = 0;
    for (const el of targets) {
      el.closest(".fresh")?.classList.remove("fresh");
      if (!el.getClientRects().length) continue;
      this.pens.write(el, { delay: i++ * 45 + rand(0, 120) });
    }
  }

  // After the arrival: what shows again, a meeting new to the list, and text that changes.
  watch() {
    new MutationObserver((records) => {
      if (!this.app.classList.contains("arrived")) return;
      for (const r of records) {
        if (r.oldValue === null || r.target.hidden) continue;
        if (r.target.closest("#notebook-card, [data-view=meeting], #loading")) continue;
        this.writeIn(r.target);
      }
    }).observe(this.app, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true, subtree: true });
    const meetings = this.doc.querySelector("#meetings");
    if (meetings) {
      new MutationObserver(() => {
        if (!this.app.classList.contains("arrived")) return;
        let i = 0;
        for (const fresh of meetings.querySelectorAll(".fresh")) {
          fresh.classList.remove("fresh");
          const parts = fresh.matches(".sidehead") ? [fresh] : [...fresh.children];
          for (const el of parts) this.pens.write(el, { delay: i++ * 120 });
        }
      }).observe(meetings, { childList: true });
    }
    for (const el of REWRITTEN.map((s) => this.doc.querySelector(s)).filter(Boolean)) {
      let text = el.textContent;
      new MutationObserver(() => {
        if (el.textContent === text) return;
        text = el.textContent;
        if (text) this.pens.write(el);
      }).observe(el, { childList: true, characterData: true, subtree: true });
    }
  }
}

if (typeof document !== "undefined") new Arrival(document).start();
