// The page: Minutes, and below it, when opened, a peek under the hood of the machine it runs
// on. The machine runs in a Web Worker (worker.js); its console is the peek's terminal, which
// shows what the app's programs print and takes lines of its own.
import { Terminal } from "./node_modules/@xterm/xterm/lib/xterm.mjs";
import { FitAddon } from "./node_modules/@xterm/addon-fit/lib/addon-fit.mjs";
import { LineEditor, split, isShellLine } from "./shell.js";
import { AudioInputs } from "./audio.js";
import { HoodView, Machine } from "./hood.js";
import { Minutes } from "./minutes.js";
import { Doodles } from "./doodles.js";
import { Recordings } from "./recordings.js";

// No convertEol: clai's output comes through the machine's terminal, which turns "\n" into
// "\r\n" itself unless the program asked for raw output.
const term = new Terminal({ cursorBlink: true, fontSize: 13, scrollback: 10_000 });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(document.querySelector("#terminal"));
fit.fit();
addEventListener("resize", () => fit.fit());

const hood = document.querySelector("#hood");
const peekButton = document.querySelector("#peek");
const peek = (open) => {
  hood.classList.toggle("open", open);
  peekButton.setAttribute("aria-expanded", String(open));
  peekButton.lastChild.textContent = open ? " Hide the machine" : " Peek under the hood";
  if (open) fit.fit();
};
peekButton.onclick = () => peek(!hood.classList.contains("open"));
document.querySelector("#peek-close").onclick = () => peek(false);

const tabs = document.querySelectorAll("[role=tab]");
const showTab = (name) => {
  peek(true);
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
const view = new HoodView(model, hood);
window.hoodModel = model;

term.writeln("Booting a WASIX v2 machine…");
const worker = new Worker("./worker.js", { type: "module" });
const size = () => ({ rows: term.rows, cols: term.cols });
// `?go` adds the Go toolchain to the machine (see worker.js), which costs a 40 MB download.
const go = new URLSearchParams(location.search).has("go");
worker.postMessage({ size: size(), go });
let finished = null;
let minutes = null;
// The loudest of each input's latest samples, for the waveform.
const peaks = new Map();
const audio = new AudioInputs(
  (name, bytes) => {
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    peaks.set(name, peak / 32768);
    if (name === "mic") minutes?.level(Math.min(1, Math.max(...peaks.values()) * 1.6));
    worker.postMessage({ samples: { name, bytes } }, [bytes.buffer]);
  },
  (text) => {
    term.write(`\r\n\x1b[33m${text}\x1b[0m\r\n`);
    minutes?.status(text);
  },
  (share) => minutes?.offerShare(share),
  () => minutes?.render(),
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
if (!go) term.writeln("\x1b[2mOpen this page with \x1b[1m?go\x1b[0m\x1b[2m and the machine mounts the Go toolchain at /go.\x1b[0m\r\n");
document.querySelector("#machine-chip").textContent = "wasmer.sh · WASIX v2 kernel: running";
term.onResize(() => worker.postMessage({ size: size() }));

// Runs `args` from `path`, with `env` and `extra` (variables for this run only), resolving to
// its exit status and streaming what it prints.
const env = new Map();
const exec = (path, args, extra = {}) => new Promise((resolve) => {
  finished = (status) => {
    // As bash does, the prompt goes on a new line after ^C killed the program.
    if (status === 128 + 2) term.write("\r\n");
    resolve(status);
  };
  const vars = [...env, ...Object.entries(extra)];
  worker.postMessage({ path, args, env: vars.map(([key, value]) => `${key}=${value}`) });
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
    (go ? "go <args>           build and run Go in the machine's /go toolchain (~/examples has four)\r\n" : "") +
    "clear               clear the screen"),
  clear: () => term.clear(),
  export: (...assignments) => {
    for (const assignment of assignments) {
      const at = assignment.indexOf("=");
      if (at > 0) env.set(assignment.slice(0, at), assignment.slice(at + 1));
      else term.writeln(`export: want KEY=VALUE, got ${assignment}`);
    }
    return 0;
  },
  cd: async (target = "~") => {
    const dir = resolvePath(target);
    const status = bash ? await exec("/bin/bash", ["bash", "-c", 'cd -- "$1"', "cd", dir]) : 0;
    if (status === 0) cwd = dir;
    return status;
  },
};

async function run(line, tag = "terminal", extra = {}) {
  const args = split(line);
  if (args.length === 0) return 0;
  if (builtins[args[0]] && !isShellLine(line)) return (await builtins[args[0]](...args.slice(1))) ?? 0;
  if (bash) return exec("/bin/bash", ["bash", "-c", `cd -- ${quote(cwd)} || exit\n${line}`, tag], extra);
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

// What the app runs and lines from scripts take turns with what is typed: one runs at a time,
// as the console has one foreground program. The app's do not go through the line editor; the
// terminal notes them, as the console shows what they print.
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
// Writes a file in the machine for what the page has in hand and no program does (a program's
// source it is about to build, say). bash writes it, so its directory is the machine's.
window.writeFile = (path, text) => serially(() => exec(
  "/bin/bash",
  ["bash", "-c", 'd=${1%/*}; [ "$d" = "$1" ] && d=.; mkdir -p "$d" && printf %s "$2" > "$1"', "write", path, text],
));
// The examples the page ships for ?go, in the guest's home before it says it is ready: a tab has
// something to build before the reader has a way to write a file.
if (go && bash) {
  const { files } = await (await fetch("./examples/index.json")).json();
  for (const [path, text] of Object.entries(files)) await window.writeFile(`${home}/examples/${path}`, text);
  const names = [...new Set(Object.keys(files).map((path) => path.split("/")[0]))].join(", ");
  term.writeln(`\x1b[2mGo examples in \x1b[0m\x1b[1m~/examples\x1b[0m\x1b[2m (${names}). Try \x1b[0m\x1b[1mcd ~/examples/hello && go run .\x1b[0m\r\n`);
}
const machine = {
  run: (line, action, extra) => serially(async () => {
    editor.busy = true;
    term.write(`\r\x1b[2K\x1b[2m# Minutes ran: ${line.replaceAll("\n", "; ")}\x1b[0m\r\n`);
    try {
      return await run(line, action, extra);
    } finally {
      editor.busy = false;
      term.write(editor.prompt + editor.line);
    }
  }),
  type,
};
minutes = new Minutes({
  root: document.querySelector("#app"),
  machine,
  hood: view,
  model,
  env,
  audio,
  // Storage can be off (a private window, blocked site data): the login then lasts the tab.
  store: {
    get: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Kept for this tab only.
      }
    },
  },
  recordings: new Recordings(globalThis.indexedDB),
  config: window.minutesConfig ?? {},
});
minutes.start();
new Doodles(document, model).start();
window.minutes = minutes;

// The microphone is asked for up front, so that the browser names its audio inputs; ffmpeg in
// the machine then lists them all, and the agent picks which to record (audio/ffmpeg.sh).
const findDevices = async () => worker.postMessage({ devices: await audio.discover() });
navigator.mediaDevices?.addEventListener("devicechange", () => findDevices());
await findDevices();

if (bash) document.body.dataset.bash = "true";
document.body.dataset.ready = "true";
