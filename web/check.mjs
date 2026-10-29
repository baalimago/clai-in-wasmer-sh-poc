// Runs clai in the page in headless Chromium and checks that it printed its usage, that it
// reads what is typed on its terminal, and, with bash installed, that lines run in bash.
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

// `clai setup` asks for a category on /dev/tty. `keys` are typed once it does.
const INTERACTIVE = [
  // The terminal's line editing: the x is erased before clai reads the line, so it quits.
  { name: "a line, edited", keys: ["x", "Backspace", "q", "Enter"], status: 0 },
  // ^C is SIGINT for the foreground process, which the Go port cannot catch yet, so it dies of it.
  { name: "^C", keys: ["Control+C"], status: 128 + 2 },
];

const server = await startServer();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
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
  if (!bash) console.log("\nskipped the shell rows: no bash (make packages)");
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
