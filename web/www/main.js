// The page: Minutes on the left, the machine under it on the right. The machine runs in a Web
// Worker (worker.js); its console is the terminal in the right half's Terminal tab, where every
// line runs, typed or sent by a button of the app.
import { Terminal } from "./node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "./node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { LineEditor, split } from "./shell.js";
import { AudioInputs } from "./audio.js";
import { HoodView, Machine } from "./hood.js";
import { Minutes } from "./minutes.js";

// No convertEol: clai's output comes through the machine's terminal, which turns "\n" into
// "\r\n" itself unless the program asked for raw output.
const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 10_000 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.querySelector("#terminal"));
fit.fit();
addEventListener("resize", () => fit.fit());

const tabs = document.querySelectorAll("[role=tab]");
const showTab = (name) => {
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll("[data-panel]")) {
    panel.classList.toggle("active", panel.dataset.panel === name);
  }
  if (name === "terminal") {
    fit.fit();
    term.focus();
  }
};
for (const tab of tabs) tab.onclick = () => showTab(tab.dataset.tab);
window.showTab = showTab;

const model = new Machine();
const hood = new HoodView(model, document.querySelector("#hood"));
window.hoodModel = model;

term.writeln("Booting a WASIX v2 machine…");
const worker = new Worker("./worker.js", { type: "module" });
const size = () => ({ rows: term.rows, cols: term.cols });
worker.postMessage({ size: size() });
let finished = null;
let minutes = null;
const level = document.querySelector("#level");
const audio = new AudioInputs(
  (name, bytes) => {
    if (name === "mic") {
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
      let peak = 0;
      for (const s of samples) peak = Math.max(peak, Math.abs(s));
      level.style.width = `${Math.min(100, (peak / 32768) * 160)}%`;
    }
    worker.postMessage({ samples: { name, bytes } }, [bytes.buffer]);
  },
  (text) => term.write(`\r\n\x1b[33m${text}\x1b[0m\r\n`),
);
// What `play` (audio/play.sh) wrote to /run/audio/play, in a player until it is closed.
const play = (bytes) => {
  const url = URL.createObjectURL(new Blob([bytes]));
  const player = document.createElement("div");
  player.className = "player";
  const element = new Audio(url);
  element.controls = true;
  const close = document.createElement("button");
  close.textContent = "✕";
  close.title = "Close";
  close.onclick = () => {
    element.pause();
    URL.revokeObjectURL(url);
    player.remove();
  };
  player.append(element, close);
  document.querySelector(".players").append(player);
  element.play().catch(() => {});
};
worker.onerror = (event) => term.writeln(`\x1b[31mworker failed: ${event.message}\x1b[0m`);
const { bash, home } = await new Promise((ready) => {
  worker.onmessage = ({ data }) => {
    if (data.log) term.writeln(data.log);
    if (data.ready) ready(data);
    if (data.output) term.write(data.output);
    if (data.events) model.add(JSON.parse(data.events));
    if (data.outbox) for (const message of data.outbox) minutes?.receive(message);
    if (data.audio) audio.want(data.audio);
    if (data.play) play(data.play);
    if (data.error) term.writeln(`\x1b[31m${data.error}\x1b[0m`);
    if ("status" in data) finished(data.status);
  };
});
term.writeln(bash
  ? "Ready. Try \x1b[1mls /bin\x1b[0m, \x1b[1mclai h\x1b[0m, or \x1b[1mhelp\x1b[0m.\r\n"
  : "Ready, without bash: run \x1b[1mmake packages\x1b[0m for it. Try \x1b[1mclai h\x1b[0m.\r\n");
document.querySelector("#machine-chip").textContent = "wasmer · WASIX v2: running";
term.onResize(() => worker.postMessage({ size: size() }));

// Runs `args` from `path`, resolving to its exit status and streaming what it prints.
const env = new Map();
const exec = (path, args) => new Promise((resolve) => {
  finished = (status) => {
    // As bash does, the prompt goes on a new line after ^C killed the program.
    if (status === 128 + 2) term.write("\r\n");
    resolve(status);
  };
  worker.postMessage({ path, args, env: [...env].map(([key, value]) => `${key}=${value}`) });
});

// Each line is a new `bash -c` in the page's working directory, so `cd` and `export` are
// the page's. Its $0 says who asked for it, which the under-the-hood view follows.
let cwd = home;
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const resolvePath = (target) => {
  const path = target.startsWith("/") ? target : target === "~" || target.startsWith("~/")
    ? home + target.slice(1) : `${cwd}/${target}`;
  const parts = [];
  for (const part of path.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
};

const builtins = {
  help: () => term.writeln(
    (bash ? "<line>              run the line with bash; /bin has coreutils, grep, rg, git…\r\n"
      : "clai <args>         run clai on the WASIX v2 machine\r\n") +
    "cd DIR              change the directory the next lines start in\r\n" +
    "export KEY=VALUE    set a variable for every program, such as OPENAI_API_KEY\r\n" +
    (bash ? "play FILE           play a sound file, such as a recording, in the page\r\n" : "") +
    "clear               clear the screen"),
  clear: () => term.clear(),
  export: (...assignments) => {
    for (const assignment of assignments) {
      const at = assignment.indexOf("=");
      if (at > 0) env.set(assignment.slice(0, at), assignment.slice(at + 1));
      else term.writeln(`export: want KEY=VALUE, got ${assignment}`);
    }
    minutes?.render();
    return 0;
  },
  cd: async (target = "~") => {
    const dir = resolvePath(target);
    const status = bash ? await exec("/bin/bash", ["bash", "-c", 'cd -- "$1"', "cd", dir]) : 0;
    if (status === 0) cwd = dir;
    return status;
  },
};

async function run(line, tag = "terminal") {
  const args = split(line);
  if (args.length === 0) return 0;
  if (builtins[args[0]]) return (await builtins[args[0]](...args.slice(1))) ?? 0;
  if (bash) return exec("/bin/bash", ["bash", "-c", `cd -- ${quote(cwd)} || exit\n${line}`, tag]);
  return exec(args[0].includes("/") ? args[0] : `/bin/${args[0]}`, args);
}

// While a program runs, what is typed goes to the machine's terminal as it is.
const encoder = new TextEncoder();
const type = (data) => worker.postMessage({ input: encoder.encode(data) });
const editor = new LineEditor(term, "$ ", run, type);
// The screen's text, with the lines the terminal wrapped joined again.
window.terminalText = () => {
  const buffer = term.buffer.active;
  let text = "";
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    const continued = buffer.getLine(i + 1)?.isWrapped ?? false;
    text += (i > 0 && !line.isWrapped ? "\n" : "") + line.translateToString(!continued);
  }
  return text;
};

// Lines from the app and from scripts run one at a time, after what the terminal runs.
let queue = Promise.resolve();
const serially = (task) => {
  const next = queue.then(async () => {
    while (editor.busy) await new Promise((r) => setTimeout(r, 100));
    return task();
  });
  queue = next.catch(() => {});
  return next;
};
window.runCommand = (line) => serially(() => editor.submit(line));
// The app's lines show in the terminal as if typed, with the button that sent them.
const machine = {
  run: (line, action, label) => serially(() => {
    term.write(`\x1b[2m# ${label}, from Minutes\x1b[0m\r\n${line.replaceAll("\n", "\r\n")}\r\n`);
    return editor.submit(line, action);
  }),
  type,
};
minutes = new Minutes({
  root: document.querySelector("#app"),
  machine,
  hood,
  model,
  env,
  showTab,
  config: window.minutesConfig ?? {},
});
window.minutes = minutes;

if (bash) document.body.dataset.bash = "true";
document.body.dataset.ready = "true";
