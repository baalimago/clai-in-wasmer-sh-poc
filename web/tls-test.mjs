import { chromium } from "playwright";
import { startServer } from "./server.mjs";

const server = await startServer();
const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  page.on("console", (m) => console.log("console:", m.text()));
  await page.goto(`http://localhost:${server.address().port}/`);
  await page.waitForSelector("body[data-ready]", { timeout: 120_000 });
  const lines = process.argv.slice(2);
  for (const line of lines) {
    const before = await page.evaluate(() => window.terminalText());
    const status = await page.evaluate((l) => window.runCommand(l), line);
    const printed = (await page.evaluate(() => window.terminalText())).slice(before.length);
    console.log(`\n$ ${line}\n[status ${status}]\n${printed.trimEnd()}`);
  }
} finally {
  await browser.close();
  server.close();
}
