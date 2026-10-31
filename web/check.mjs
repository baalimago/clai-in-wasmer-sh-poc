// Runs clai in the page in headless Chromium and checks that it printed its usage, that it
// reads what is typed on its terminal, and, with bash installed, that lines run in bash, that
// clai calls an MCP server uvx starts, that its async commands run, that slivingdoc serves
// with libgit2 behind it, and that ffmpeg and clai's meeting-transcriber profile record the
// page's microphone.
import { readFile } from "node:fs/promises";

import { chromium } from "playwright";

import { startServer } from "./server.mjs";

const COMMANDS = [
  // `h` is not a command, so clai says so, prints its usage and exits with 1, as it does natively.
  { line: "clai h", status: 1 },
  { line: "clai help", status: 0 },
];

// With the registry packages, lines run in bash, whose pipelines are WASIX v1 programs, and
// clai's tools start programs the same way.
const SHELL = [
  { line: "echo hello | tr a-z A-Z", prints: "HELLO" },
  { line: "ls /bin | grep -x clai", prints: "clai" },
  { line: "cd /usr/bin", prints: "" },
  { line: "pwd", prints: "/usr/bin" },
];

// The Go toolchain the page mounts at /go when it is opened with ?go: it compiles a program that
// imports the standard library and a package of the module's own, links it, and the machine then
// runs what it built. The first build is the slow one: an empty GOCACHE compiles every package
// the program imports, on the kernel, in the tab.
const GO_FILES = [
  ["/tmp/go-demo/go.mod", "module demo\n\ngo 1.26\n"],
  [
    "/tmp/go-demo/words/words.go",
    'package words\n\nimport "strings"\n\n// Up shouts, through the standard library.\nfunc Up(s string) string { return strings.ToUpper(s) }\n',
  ],
  [
    "/tmp/go-demo/main.go",
    'package main\n\nimport (\n\t"fmt"\n\t"sort"\n\n\t"demo/words"\n)\n\nfunc main() {\n\txs := []string{"b", "a"}\n' +
      '\tsort.Strings(xs)\n\tfmt.Println(words.Up("hello"), xs)\n}\n',
  ],
];
const GO = [
  { line: "go version", status: 0, prints: "wasix/wasm" },
  { line: "cd /tmp/go-demo", status: 0, prints: "" },
  { line: "go build -o hello . && ls hello", status: 0, prints: "hello" },
  { line: "./hello", status: 0, prints: "HELLO [a b]" },
];
// The examples the page writes into the guest's home (main.js), so a reader has a program to
// build without writing one. `go run` builds into a temp dir, so the sources stay as shipped.
const EXAMPLE = [
  { line: "ls ~/examples", status: 0, prints: "words" },
  { line: "cd ~/examples/hello && go run .", status: 0, prints: "hello from the tab" },
];

// npx and uvx start the MCP server ports in /bin, and clai talks MCP to them over pipes. The
// profile has the shape of cchub:clai/researcher's ddg server; the test model calls the tools
// its prompt names, with no arguments, so the port's answer is that the query is missing. The
// terminal wraps long lines, so the expected texts are short.
const PROFILE = JSON.stringify({
  use_tools: true,
  tools: ["mcp_ddg*", "cmd", "async_cmd*"],
  mcp_servers: { ddg: { command: "uvx", args: ["duckduckgo-mcp-server==0.7.0"], startup: "lazy" } },
});
const FS_PROFILE = JSON.stringify({
  use_tools: true,
  tools: ["mcp_Filesystem*"],
  mcp_servers: { Filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "./"] } },
});
// An async command that writes its own id where the test model reads it, while `cmd` sleeps
// to let it run.
const ASYNC = [
  `ls /tmp | sed -n "s/^clai-async-cmd-\\(async_cmd_[0-9a-f]*\\)-stdout.log$/\\1/p" > /tmp/id.tmp`,
  "mv /tmp/id.tmp /tmp/id",
  "echo async-done",
];
const MCP = [
  {
    line: `printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | uvx duckduckgo-mcp-server==0.7.0`,
    status: 0,
    prints: '"name":"ddg-search"',
  },
  { line: "npx -y left-pad@1.3.0", status: 127, prints: "left-pad is not available" },
  // slivingdoc-git2 answers a version request (op 3, framed as length 1) with libgit2's: 1.9.6.
  {
    line: "printf '\\001\\000\\000\\000\\003' | slivingdoc-git2 | od -An -tx1 | tr -d ' \\n'",
    status: 0,
    prints: "0d00000000010000000900000006000000",
  },
  { line: "npx -y slivingdoc@1.3.1 version", status: 0, prints: "slivingdoc 1.3.1" },
  // serve stops at the end of its input, so the input stays open until it has answered.
  {
    line:
      `(printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18",` +
      `"capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'; sleep 3) | ` +
      `npx -y slivingdoc@1.3.1 serve 2>/dev/null | grep -o '"serverInfo":{"name":"slivingdoc"'`,
    status: 0,
    prints: '"serverInfo":{"name":"slivingdoc"',
  },
  // The filesystem server meeting-transcriber starts, confined to the directory it is given.
  { line: `printf '%s' '${FS_PROFILE}' > /tmp/fs.json`, status: 0, prints: "" },
  {
    line: "mkdir -p /tmp/notes && cd /tmp/notes && clai -profile-path /tmp/fs.json -cm test query tool_mcp_Filesystem_list_allowed_directories 2>&1 | cat",
    status: 0,
    prints: "Allowed directories:",
  },
  { line: `printf '%s' '${PROFILE}' > /tmp/mcp.json`, status: 0, prints: "" },
  {
    line: "clai -profile-path /tmp/mcp.json -cm test query tool_mcp_ddg_search 2>&1 | cat",
    status: 0,
    prints: "missing required argument",
  },
  { line: `printf '%s\\n' ${ASYNC.map((l) => `'${l.replaceAll("'", "'\\''")}'`).join(" ")} > /tmp/async.sh`, status: 0, prints: "" },
  {
    line:
      "CLAI_MOCK_CMD_COMMAND='sleep 2' CLAI_MOCK_ASYNC_CMD_RUN_COMMAND=sh CLAI_MOCK_ASYNC_CMD_RUN_ARGS=/tmp/async.sh " +
      "CLAI_MOCK_ASYNC_CMD_ID_FILE=/tmp/id clai -profile-path /tmp/mcp.json -cm test " +
      "query tool_async_cmd tool_cmd tool_async_cmd_await tool_async_cmd_logs 2>&1 | cat",
    status: 0,
    prints: '"preview":"async-done',
  },
];

// The page's microphone is Chromium's fake one, which beeps. ffmpeg records it from the files in
// /run/audio through the wrapper in /usr/local/bin, and clai runs the meeting-transcriber profile
// with the test models: it lists the inputs, records the microphone and the (unshared, so silent)
// tab until its four seconds are up, and transcribes the recording without the network. Then a
// recording stops on Enter, as a user stops a meeting's.
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const MEETING = await readFile(new URL("../components/clai/examples/profiles/meeting-transcriber.json", import.meta.url), "utf8");
const audioConfig = (maxSeconds) => JSON.stringify({
  transcribe: { model: "test" },
  capture: { dir: "/tmp/rec", "max-seconds": maxSeconds, "silence-timeout": 0, calibrated: true },
});
const writeAudioConfig = (maxSeconds) =>
  `mkdir -p "$(clai confdir)" && printf '%s' ${quote(audioConfig(maxSeconds))} > "$(clai confdir)/audioConfig.json"`;
const RECORD = "CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav clai -cm mock_test -prp /tmp/meeting.json " +
  "q tool_audio_sources tool_audio_record tool_audio_transcribe";
const AUDIO = [
  { line: "ls /run/audio", status: 0, prints: "mic" },
  { line: "ffmpeg -hide_banner -sources pulse", status: 0, prints: "browser-tab.monitor" },
  // Every audio input of the browser's, the computer's monitor among them, is a pulse device.
  { line: "ffmpeg -hide_banner -sources pulse", status: 0, prints: "browser-dev2.monitor [Monitor of Built-in Audio Analog Stereo]" },
  { line: "ffmpeg -hide_banner -sinks pulse", status: 0, prints: "* browser-dev2 [Built-in Audio Analog Stereo]" },
  {
    line: "ffmpeg -hide_banner -nostdin -loglevel error -f pulse -i browser-dev2.monitor -t 1 -ac 1 -ar 16000 -y /tmp/monitor.wav && echo bytes=$(wc -c < /tmp/monitor.wav)",
    status: 0,
    prints: "bytes=32078",
  },
  {
    line: "ffmpeg -hide_banner -nostdin -loglevel error -f pulse -i browser-mic -t 2 -ac 1 -ar 16000 -y /tmp/mic.wav && echo bytes=$(wc -c < /tmp/mic.wav)",
    status: 0,
    prints: "bytes=64",
  },
  { line: "play /tmp/mic.wav", status: 0, prints: "in the player" },
  { line: `printf '%s' ${quote(MEETING)} > /tmp/meeting.json`, status: 0, prints: "" },
  { line: writeAudioConfig(4), status: 0, prints: "" },
  // The agent records the microphone and the computer's monitor, mixed.
  { line: `${RECORD} 2>&1 | cat`, status: 0, prints: "sources: sink=Monitor of Built-in Audio Analog Stereo; mic=" },
  { line: writeAudioConfig(60), status: 0, prints: "" },
];

// A meeting in the notebook, as the agent files one.
const NOTEBOOK = "mkdir -p ~/notebook/meetings/summaries ~/notebook/meetings/transcripts && cd ~/notebook/meetings && " +
  `printf '%s' ${quote("---\ntitle: Design review\ndate: 2026-10-28T09:00:00Z\nduration: 38\n---\n## Decisions\n\n- Ship the peek\n")} ` +
  "> summaries/2026-10-28T09-00Z_design-review.md && " +
  `printf '%s' ${quote("**Speaker A** [00:12]: Ship it.\n")} > transcripts/2026-10-28T09-00Z_design-review.md`;

// `clai setup` asks for a category on /dev/tty. `keys` are typed once it does.
const INTERACTIVE = [
  // The terminal's line editing: the x is erased before clai reads the line, so it quits.
  { name: "a line, edited", keys: ["x", "Backspace", "q", "Enter"], status: 0 },
  // ^C is SIGINT for the foreground process, which the Go port cannot catch yet, so it dies of it.
  { name: "^C", keys: ["Control+C"], status: 128 + 2 },
];

const server = await startServer();
const browser = await chromium.launch({
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  // Minutes runs its agent with the test models and the meeting-transcriber profile the AUDIO
  // rows write, as they do.
  // Chromium's fake devices have no monitor source, so the second fake input plays one: on Linux,
  // PipeWire's "Monitor of ..." inputs hold what the computer plays.
  await page.addInitScript(() => {
    const enumerate = MediaDevices.prototype.enumerateDevices;
    MediaDevices.prototype.enumerateDevices = async function () {
      return (await enumerate.call(this)).map((d) => d.kind === "audioinput" && d.label === "Fake Audio Input 2"
        ? { deviceId: d.deviceId, groupId: d.groupId, kind: d.kind, label: "Monitor of Built-in Audio Analog Stereo" }
        : d);
    };
  });
  await page.addInitScript(() => {
    window.minutesConfig = {
      profile: "/tmp/meeting.json",
      flags: "-cm mock_test",
      env: "CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav",
      query: () => "tool_audio_sources tool_audio_record tool_audio_transcribe",
    };
  });
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.goto(`http://localhost:${server.address().port}/?go`);
  await page.waitForSelector("body[data-ready]", { timeout: 120_000 });
  for (const { line, status: want } of COMMANDS) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want || !printed.includes("Usage: clai")) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or printed no usage`);
      process.exitCode = 1;
    }
  }
  const bash = await page.evaluate(() => document.body.dataset.bash === "true");
  for (const { line, prints } of bash ? SHELL : []) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== 0 || !printed.includes(prints)) {
      console.error(`\nFAIL: ${line} exited with ${status} or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  // The kernel's events reach the page: the line's bash, tagged as the terminal's, and the file
  // it writes.
  if (bash) {
    await page.evaluate((line) => window.runCommand(line), "echo hood > /tmp/hood.txt");
    const seen = await page
      .waitForFunction(() => {
        const procs = [...window.hoodModel.procs.values()];
        const shell = procs.find((p) => p.name === "bash" && p.argv[2]?.includes("/tmp/hood.txt"));
        const wrote = window.hoodModel.resources.get("file:/tmp/hood.txt");
        return shell?.action === "terminal" && wrote?.procs.has("bash") && wrote.out === 5;
      }, null, { timeout: 10_000 })
      .then(() => true, () => false);
    console.log(`under the hood: ${seen ? "saw" : "missed"} bash write /tmp/hood.txt`);
    if (!seen) {
      console.error("\nFAIL: the under-the-hood model did not see bash, tagged terminal, write 5 bytes to /tmp/hood.txt");
      process.exitCode = 1;
    }
  }
  for (const [path, text] of bash ? GO_FILES : []) {
    const status = await page.evaluate(([file, body]) => window.writeFile(file, body), [path, text]);
    if (status !== 0) {
      console.error(`\nFAIL: writing ${path} exited with ${status}`);
      process.exitCode = 1;
    }
  }
  for (const { line, status: want, prints } of bash ? GO : []) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want || !printed.includes(prints)) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  for (const { line, status: want, prints } of bash ? EXAMPLE : []) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want || !printed.includes(prints)) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  for (const { line, status: want, prints } of bash ? [...MCP, ...AUDIO] : []) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((line) => window.runCommand(line), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want || !printed.includes(prints)) {
      console.error(`\nFAIL: ${line} exited with ${status} (want ${want}) or did not print ${prints}`);
      process.exitCode = 1;
    }
  }
  if (!bash) console.log("\nskipped the shell and MCP rows: no bash (make packages)");
  // `play` put the 2 s recording in a player the browser can decode.
  if (bash) {
    const seconds = await page.evaluate(async () => {
      const element = document.querySelector(".player audio");
      if (!element) return 0;
      if (element.readyState < 1) await new Promise((loaded) => (element.onloadedmetadata = loaded));
      return element.duration;
    });
    console.log(`player: ${seconds} s`);
    if (!(Math.abs(seconds - 2) < 0.1)) {
      console.error(`\nFAIL: play: the page's player holds ${seconds} s, want 2 s`);
      process.exitCode = 1;
    }
  }
  // Minutes' Record: the agent starts ffmpeg through its audio_record tool, the page shows Stop,
  // which ends the recording as Enter does, and the agent's reply comes back to the app. Then
  // a meeting of the notebook opens as its summary and transcript, rendered.
  if (bash) {
    await page.evaluate((line) => window.runCommand(line), NOTEBOOK);
    await page.fill("#key-input", "sk-test-not-a-key");
    await page.click("#key-form button");
    await page.fill("#title", "Daily sync");
    await page.click("#record-form button");
    const stop = await page
      .waitForSelector("#stop:not([hidden])", { timeout: 60_000 })
      .then(() => true, () => false);
    if (stop) {
      await page.waitForTimeout(2000);
      await page.click("#stop");
    }
    const replied = await page
      .waitForSelector("#agent:not([hidden])", { timeout: 60_000 })
      .then(() => true, () => false);
    const result = await page.evaluate(() => {
      const r = window.minutes.recording;
      const action = [...window.hoodModel.procs.values()].find((p) => p.action.startsWith("minutes:Record"))?.action;
      // ffmpeg's wrapper in /usr/local/bin runs ffmpeg itself.
      const ancestors = [];
      for (let p = window.hoodModel.find(action, "ffmpeg").at(-1); p; p = window.hoodModel.procs.get(p.ppid)) {
        ancestors.push(p.name);
      }
      return {
        status: r.status,
        reply: r.reply,
        stages: [...r.stages],
        ffmpegUnder: ancestors.find((name) => name !== "ffmpeg" && name !== "bash"),
        command: window.hoodModel.tree(action).map((n) => n.proc.argv[2]).join(" "),
      };
    });
    console.log(`Minutes, Record: ${JSON.stringify(result)}`);
    if (!stop || !replied || result.status !== 0 || !result.stages.includes("recorded") ||
      result.ffmpegUnder !== "clai" || !result.command.includes("clai -reply-only -profile-path /tmp/meeting.json")) {
      console.error("\nFAIL: Minutes' Record did not show Stop, run ffmpeg under clai, or bring the agent's reply back");
      process.exitCode = 1;
    }
    await page.click(".meeting >> text=Design review");
    const opened = await page
      .waitForFunction(() => document.querySelector("#transcript").textContent.includes("Speaker A"), null, { timeout: 30_000 })
      .then(() => true, () => false);
    const meeting = await page.evaluate(() => ({
      title: document.querySelector("#meeting-title").textContent,
      item: document.querySelector("#summary ul > li")?.textContent,
      path: document.querySelector("#saved-path").textContent,
    }));
    console.log(`Minutes, a meeting: ${JSON.stringify(meeting)}`);
    if (!opened || meeting.title !== "Design review" || meeting.item !== "Ship the peek") {
      console.error("\nFAIL: the notebook's meeting did not open as its rendered summary and transcript");
      process.exitCode = 1;
    }
  }
  // The keyboard goes to the terminal, in its tab.
  await page.evaluate(() => window.showTab("terminal"));
  for (const { name, keys, status: want } of INTERACTIVE) {
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate(() => {
      window.running = window.runCommand("clai setup");
    });
    await page.waitForFunction(
      (length) => window.terminalText().slice(length).includes("[q]uit"),
      before.length,
      { timeout: 60_000 },
    ).catch(async (error) => {
      const text = await page.evaluate(() => window.terminalText());
      console.error(`the terminal, which never showed the menu:\n${JSON.stringify(text.slice(-1500))}`);
      throw error;
    });
    for (const key of keys) await page.keyboard.press(key);
    const status = await page.evaluate(() => window.running);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== want) {
      console.error(`\nFAIL: clai setup, then ${name}: exited with ${status} (want ${want})`);
      process.exitCode = 1;
    }
  }
  if (bash) {
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate((line) => {
      window.running = window.runCommand(line);
    }, `${RECORD} 2>&1 | cat`);
    await page.waitForFunction(() => window.terminalText().includes("stops: [Enter], max 1m"), null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(2000);
    await page.keyboard.press("Enter");
    const status = await page.evaluate(() => window.running);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(printed.trimEnd());
    if (status !== 0 || !printed.includes("stopped_because: enter")) {
      console.error(`\nFAIL: a recording, then Enter: exited with ${status} or did not stop on Enter`);
      process.exitCode = 1;
    }
  }
  if (!process.exitCode) {
    console.log("\nok: clai printed its usage, read its terminal and recorded the page's microphone on WASIX v2 in Chromium");
  }
} finally {
  await browser.close();
  server.close();
}
