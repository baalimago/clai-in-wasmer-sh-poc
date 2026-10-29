// Runs clai in the page in headless Chromium and checks that it printed its usage.
import { chromium } from "playwright";

import { startServer } from "./server.mjs";

const COMMANDS = [
  // `h` is not a command, so clai says so, prints its usage and exits with 1, as it does natively.
  { line: "clai h", status: 1 },
  { line: "clai help", status: 0 },
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
  if (!process.exitCode) console.log("\nok: clai printed its usage on WASIX v2 in Chromium");
} finally {
  await browser.close();
  server.close();
}
