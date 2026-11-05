// While the machine boots, the login is checked and the notes are fetched, the pencil writes each
// step on the pad, taps beside it while it lasts and ticks it off; then an eraser rubs the list
// out and the app arrives on the pad (pad.css): the sticky note is put down, the meetings are
// written in. Minutes says how far it got in #app's data-phase; the app shows once #app has the
// class "arrived". Text the header chips and the status line change to is written in again.

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

const WRITE_MS = 750;
// A step that is already over is written faster, to catch up.
const CATCH_UP_MS = 380;
const TICK_MS = 260;
const ERASE_MS = 900;
const RULE = 32;
const REWRITTEN = ["#machine-chip", "#notebook-chip", "#key-chip", "#status"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Arrival {
  constructor(doc) {
    this.doc = doc;
    this.app = doc.querySelector("#app");
    this.list = doc.querySelector("#loading");
    this.phases = [];
    this.waiting = null;
    this.calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      const wake = this.waiting;
      this.waiting = null;
      wake?.();
    }).observe(this.app, { attributes: true, attributeFilter: ["data-phase"], attributeOldValue: true });
    this.rewrite();
    this.run();
  }

  async run() {
    if (this.calm) {
      while (!this.phases.includes("ready")) await new Promise((resolve) => (this.waiting = resolve));
      return this.arrive();
    }
    await Promise.race([this.doc.fonts?.ready, sleep(1500)]);
    this.pencil = this.doc.createElement("span");
    this.pencil.className = "loader-pencil";
    this.list.append(this.pencil);
    const written = [];
    let seen = 0;
    for (;;) {
      if (seen >= this.phases.length) {
        this.pencil.classList.add("tapping");
        await new Promise((resolve) => (this.waiting = resolve));
        this.pencil.classList.remove("tapping");
        continue;
      }
      const phase = this.phases[seen++];
      const text = stepsFor([phase])[0];
      const ready = phase === "ready";
      if (!ready && (!text || written.some((li) => li.dataset.text === text))) continue;
      if (written.length) {
        written.at(-1).classList.add("done");
        await sleep(TICK_MS);
      }
      if (ready) break;
      const ms = seen < this.phases.length ? CATCH_UP_MS : WRITE_MS;
      written.push(await this.write(text, written.length, ms));
    }
    await this.erase();
  }

  async write(text, index, ms) {
    const li = this.doc.createElement("li");
    li.dataset.text = text;
    li.style.setProperty("--ms", `${ms}ms`);
    const ink = this.doc.createElement("span");
    ink.className = "ink";
    ink.textContent = text;
    const tick = this.doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    tick.classList.add("tick");
    tick.setAttribute("viewBox", "0 0 30 24");
    tick.setAttribute("aria-hidden", "true");
    tick.innerHTML = '<path d="M3 13 L11 21 L27 3"/>';
    li.append(ink, tick);
    this.list.insertBefore(li, this.pencil);
    const y = index * RULE + 21;
    this.pencil.style.transition = "none";
    this.pencil.style.transform = `translate(0px, ${y}px) rotate(28deg)`;
    this.pencil.classList.add("writing");
    void this.pencil.offsetWidth;
    this.pencil.style.transition = `transform ${ms}ms linear`;
    this.pencil.style.transform = `translate(${ink.offsetWidth}px, ${y}px) rotate(28deg)`;
    await sleep(ms);
    this.pencil.classList.remove("writing");
    return li;
  }

  async erase() {
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
  }

  // The chips and the status line, written in again when their text changes.
  rewrite() {
    for (const el of REWRITTEN.map((s) => this.doc.querySelector(s)).filter(Boolean)) {
      let text = el.textContent;
      new MutationObserver(() => {
        if (el.textContent === text) return;
        text = el.textContent;
        el.classList.remove("rewritten");
        void el.offsetWidth;
        if (text) el.classList.add("rewritten");
      }).observe(el, { childList: true, characterData: true, subtree: true });
    }
  }
}

if (typeof document !== "undefined") new Arrival(document).start();
