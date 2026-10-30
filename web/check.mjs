// Runs clai in the page in headless Chromium and checks that it printed its usage, that it
// reads what is typed on its terminal, and, with bash installed, that lines run in bash, that
// clai calls an MCP server uvx starts, and that its async commands run.
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
// tab for a few seconds, and transcribes the recording without the network.
const MEETING = await readFile(new URL("../components/clai/examples/profiles/meeting-transcriber.json", import.meta.url), "utf8");
const AUDIO_CONFIG = JSON.stringify({
  transcribe: { model: "test" },
  capture: { dir: "/tmp/rec", "max-seconds": 4, "silence-timeout": 0, calibrated: true },
});
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const AUDIO = [
  { line: "ls /run/audio", status: 0, prints: "mic" },
  { line: "ffmpeg -hide_banner -sources pulse", status: 0, prints: "browser-tab.monitor" },
  {
    line: "ffmpeg -hide_banner -nostdin -loglevel error -f pulse -i browser-mic -t 2 -ac 1 -ar 16000 -y /tmp/mic.wav && echo bytes=$(wc -c < /tmp/mic.wav)",
    status: 0,
    prints: "bytes=64",
  },
  { line: `printf '%s' ${quote(MEETING)} > /tmp/meeting.json`, status: 0, prints: "" },
  { line: `printf '%s' ${quote(AUDIO_CONFIG)} > "$(clai confdir)/audioConfig.json"`, status: 0, prints: "" },
  {
    line: "CLAI_MOCK_AUDIO_TRANSCRIBE_FILE=/tmp/mic.wav clai -cm mock_test -prp /tmp/meeting.json " +
      "q tool_audio_sources tool_audio_record tool_audio_transcribe 2>&1 | cat",
    status: 0,
    prints: "recorded: /tmp/rec/",
  },
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
  if (!process.exitCode) {
    console.log("\nok: clai printed its usage and read its terminal on WASIX v2 in Chromium");
  }
} finally {
  await browser.close();
  server.close();
}
