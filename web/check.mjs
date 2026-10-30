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

// npx and uvx start the MCP server ports in /bin, and clai talks MCP to them over pipes. The
// profile has the shape of cchub:clai/researcher's ddg server; the test model calls the tools
// its prompt names, with no arguments, so the port's answer is that the query is missing. The
// terminal wraps long lines, so the expected texts are short.
const PROFILE = JSON.stringify({
  use_tools: true,
  tools: ["mcp_ddg*", "cmd", "async_cmd*"],
  mcp_servers: { ddg: { command: "uvx", args: ["duckduckgo-mcp-server==0.7.0"], startup: "lazy" } },
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
  {
    line: "ffmpeg -hide_banner -nostdin -loglevel error -f pulse -i browser-mic -t 2 -ac 1 -ar 16000 -y /tmp/mic.wav && echo bytes=$(wc -c < /tmp/mic.wav)",
    status: 0,
    prints: "bytes=64",
  },
  { line: `printf '%s' ${quote(MEETING)} > /tmp/meeting.json`, status: 0, prints: "" },
  { line: writeAudioConfig(4), status: 0, prints: "" },
  { line: `${RECORD} 2>&1 | cat`, status: 0, prints: "stopped_because: max_seconds" },
  { line: writeAudioConfig(60), status: 0, prints: "" },
];

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
  page.on("pageerror", (error) => console.error("page error:", error.message));
  await page.goto(`http://localhost:${server.address().port}/`);
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
  for (const { name, keys, status: want } of INTERACTIVE) {
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate(() => {
      window.running = window.runCommand("clai setup");
    });
    await page.waitForFunction(
      (length) => window.terminalText().slice(length).includes("[q]uit"),
      before.length,
      { timeout: 60_000 },
    );
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
