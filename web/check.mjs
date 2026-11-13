// Runs clai in the page in headless Chromium and checks that it printed its usage, that it
// reads what is typed on its terminal, and, with bash installed, that lines run in bash, that
// clai calls an MCP server uvx starts, that its async commands run, that slivingdoc serves
// with libgit2 behind it, and that ffmpeg and clai's meeting-transcriber profile record the
// page's microphone.
import { createHash } from "node:crypto";
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
// with the test models: it lists the inputs, records the microphone and the computer's monitor
// until its four seconds are up, and transcribes the recording without the network. Then a
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
  // Shared (by SHARE below), a screen is a sink's monitor too.
  { line: "ffmpeg -hide_banner -sources pulse", status: 0, prints: "browser-tab.monitor [Monitor of Shared screen or tab (browser)]" },
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

// slivingdoc's sign-in and sign-out against the stub site on the page's own origin (server.mjs):
// every request of the CLI's is one host call, and the page's fetch makes it, so a guest with no
// TLS of its own logs in and out (2026-11-04 research/http-host-call/PROMPT.md).
const SIGNIN = (port) => [
  {
    line: `SLIVINGDOC_SITE=http://localhost:${port} slivingdoc login --no-browser --force </dev/null 2>&1 | cat`,
    status: 0,
    prints: "check-notes",
  },
  { line: "slivingdoc space </dev/null 2>&1 | cat", status: 0, prints: "check-notes" },
  { line: "slivingdoc logout </dev/null 2>&1 | cat", status: 0, prints: "Logged out of" },
  { line: "cat ~/.config/slivingdoc/credentials.json", status: 0, prints: '"logins": []' },
];

// Sign in with OpenRouter against a stand-in for its two endpoints: the sign-in page sends the
// tab back to the callback page with a code, which the app trades, with the verifier of the
// challenge it sent, for a key. Disconnect forgets the key and links to where it is deleted.
async function checkOpenRouterSignin(context, page) {
  const KEY = "sk-or-v1-check-not-a-key";
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
  const sent = { challenge: null, exchange: null };
  const authPage = (url) => url.hostname === "openrouter.ai" && url.pathname === "/auth";
  const keysApi = (url) => url.hostname === "openrouter.ai" && url.pathname === "/api/v1/auth/keys";
  await context.route(authPage, (route) => {
    const url = new URL(route.request().url());
    sent.challenge = url.searchParams.get("code_challenge");
    const back = new URL(url.searchParams.get("callback_url"));
    back.search = new URLSearchParams({ code: "check-code", state: url.searchParams.get("state") }).toString();
    return route.fulfill({ status: 302, headers: { location: back.href } });
  });
  await context.route(keysApi, (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    sent.exchange = route.request().postDataJSON();
    return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ key: KEY }) });
  });
  const fail = (why) => {
    console.error(`\nFAIL: Sign in with OpenRouter: ${why}`);
    process.exitCode = 1;
  };
  try {
    await page.click("#signin-openrouter");
    const signed = await page
      .waitForFunction((key) => window.minutes.env.get("OPENROUTER_API_KEY") === key, KEY, { timeout: 20_000 })
      .then(() => true, () => false);
    if (!signed) return fail(`no key reached the agents' env (exchange sent ${JSON.stringify(sent.exchange)})`);
    const verifier = sent.exchange?.code_verifier ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (sent.exchange.code !== "check-code" || sent.exchange.code_challenge_method !== "S256" || challenge !== sent.challenge) {
      return fail(`the exchange did not prove the challenge: ${JSON.stringify(sent.exchange)}, challenge ${sent.challenge}`);
    }
    const state = await page.evaluate(() => ({
      kept: localStorage.getItem("minutes.openrouter-key"),
      chip: document.querySelector("#key-chip").textContent,
      card: document.querySelector("#provider-card").hidden,
      line: window.minutes.agentLine("q", false),
    }));
    console.log(`openrouter: ${state.chip}`);
    if (state.kept !== KEY || !state.chip.startsWith("OpenRouter:") || !state.card || !state.line.includes("-cm 'or:openai/gpt-5.6-luna' -am ")) {
      return fail(`after the sign-in: ${JSON.stringify(state)}`);
    }
    await page.click("#change-key");
    const manage = `https://openrouter.ai/keys/${createHash("sha256").update(KEY).digest("hex")}`;
    const linked = await page
      .waitForFunction((href) => document.querySelector("#provider-manage").href === href && !document.querySelector("#provider-manage").hidden, manage, { timeout: 5_000 })
      .then(() => true, () => false);
    const forgot = await page.evaluate(() => [window.minutes.env.has("OPENROUTER_API_KEY"), localStorage.getItem("minutes.openrouter-key")]);
    if (!linked || forgot[0] || forgot[1] !== null) fail(`Disconnect left ${JSON.stringify(forgot)} or no link to ${manage}`);
  } finally {
    await context.unroute(authPage);
    await context.unroute(keysApi);
  }
}

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
  page.on("pageerror", (error) => console.error("page error:", error.stack ?? error.message));
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
  // Nothing shared yet: ffmpeg leaves the shared input out. Then the page shares a screen, as
  // Allow mic and computer audio does: here a stand-in for getDisplayMedia, an oscillator's audio
  // and a canvas's video, since headless Chromium shows no picker.
  if (bash) {
    const line = "ffmpeg -hide_banner -sources pulse | grep -q browser-tab || echo no-shared-input";
    const before = await page.evaluate(() => window.terminalText());
    await page.evaluate((line) => window.runCommand(line), line);
    if (!(await page.evaluate(() => window.terminalText())).slice(before.length).includes("no-shared-input")) {
      console.error("\nFAIL: ffmpeg lists the shared input before anything is shared");
      process.exitCode = 1;
    }
    await page.evaluate(async () => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const context = new AudioContext();
        const destination = context.createMediaStreamDestination();
        const tone = context.createOscillator();
        // Silent until the check turns it up: nobody has spoken yet.
        window.shareVolume = context.createGain();
        window.shareVolume.gain.value = 0;
        tone.connect(window.shareVolume).connect(destination);
        tone.start();
        const video = document.createElement("canvas").captureStream().getVideoTracks();
        return new MediaStream([...destination.stream.getAudioTracks(), ...video]);
      };
    });
    // The checklist's share line asks for it (here, past the fake monitor that already ticks it).
    // A silent share already lets a recording start; the tone then ticks off its sound.
    await page.evaluate(() => window.minutes.shareComputer());
    if (!(await page.textContent("#access-computer")).includes("Shared screen or tab")) {
      console.error("\nFAIL: the checklist does not say a screen is shared");
      process.exitCode = 1;
    }
    const early = await page.evaluate(() => ({
      heard: document.querySelector("#access-sound").classList.contains("allowed"),
      start: !document.querySelector("#record-form > .primary").disabled,
    }));
    if (early.heard || !early.start) {
      console.error(`\nFAIL: before any sound, Start recording should be on and the sound unticked: ${JSON.stringify(early)}`);
      process.exitCode = 1;
    }
    await page.evaluate(() => { window.shareVolume.gain.value = 1; });
    const heard = await page.waitForSelector("#access-sound.allowed", { timeout: 20_000 }).then(() => true, () => false);
    if (!heard || (await page.isDisabled("#record-form > .primary"))) {
      console.error("\nFAIL: the checklist did not hear the share once it played, or Start recording went off");
      process.exitCode = 1;
    }
  }
  for (const { line, status: want, prints } of bash ? [...MCP, ...AUDIO, ...SIGNIN(server.address().port)] : []) {
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
    await checkOpenRouterSignin(context, page);
    await page.fill("#key-input", "sk-test-not-a-key");
    await page.click("#key-form button");
    // The key stays in this browser for this site, so a return to it needs no paste.
    const kept = await page.evaluate(() => [localStorage.getItem("minutes.openai-key"), window.minutes.env.get("OPENAI_API_KEY")]);
    if (kept[0] !== "sk-test-not-a-key" || kept[1] !== "sk-test-not-a-key") {
      console.error(`\nFAIL: the browser did not keep the OpenAI key (localStorage ${kept[0]}, env ${kept[1]})`);
      process.exitCode = 1;
    }
    const changeable = await page.isVisible("#change-key");
    if (!changeable) {
      console.error("\nFAIL: no way to change the key the browser kept");
      process.exitCode = 1;
    }
    await page.fill("#title", "Daily sync");
    await page.click("#record-form > .primary");
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
    // The recording is copied out of the machine once the agent is done, whatever it said.
    await page.waitForSelector("#recording-download:not([hidden])", { timeout: 30_000 }).catch(() => {});
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
        // The recording is kept in the browser and can be downloaded.
        download: document.querySelector("#recording-download").hidden ? null : document.querySelector("#recording-download").textContent,
      };
    });
    console.log(`Minutes, Record: ${JSON.stringify(result)}`);
    if (!stop || !replied || result.status !== 0 || !result.stages.includes("recorded") ||
      result.ffmpegUnder !== "clai" || !result.command.includes("clai -json -reply-only -n -profile-path /tmp/meeting.json") ||
      !/^Download the recording \(\d/.test(result.download ?? "")) {
      console.error("\nFAIL: Minutes' Record did not show Stop, run ffmpeg under clai, bring the agent's reply back, or keep the recording for download");
      process.exitCode = 1;
    }
    // A run that fails: clai's error record becomes a note hung under the peek button, which
    // opens the terminal, where the record itself is.
    {
      const ran = await page.evaluate(async () => {
        window.minutes.config.flags = "-cm no-such-model";
        const { status, reply, problem } = await window.minutes.runAgent("Answer", window.minutes.agentLine("hello", false));
        return { status, reply, level: problem?.level };
      });
      const note = await page.waitForSelector(".note.error", { timeout: 30_000 }).then(() => true, () => false);
      const shown = await page.evaluate(() => {
        const el = document.querySelector(".note.error");
        const anchor = document.querySelector("#peek").getBoundingClientRect();
        const at = el?.getBoundingClientRect();
        return {
          title: el?.querySelector("strong")?.textContent,
          detail: el?.querySelector(".note-detail")?.textContent,
          nudged: document.querySelector("#peek").classList.contains("nudge"),
          under: Boolean(at) && at.top >= anchor.bottom && at.right <= anchor.right + 1,
        };
      });
      if (note) await page.click(".note.error .note-peek");
      const opened = await page.evaluate(() => ({
        hood: document.querySelector("#hood").classList.contains("open"),
        tab: document.querySelector("[role=tab][aria-selected=true]")?.dataset.tab,
        // The record drawn, not its JSON, and the note's link selects it.
        record: window.terminalText().includes("error: failed to create text querier") && !window.terminalText().includes('{"type":"error"'),
        selected: window.terminalSelection(),
      }));
      console.log(`Minutes, a failed run: ${JSON.stringify({ ...ran, ...shown, ...opened })}`);
      if (!note || ran.status === 0 || ran.level !== "error" || shown.title !== "The agent stopped with an error" || !shown.detail?.includes("no-such-model") ||
        !shown.nudged || !shown.under || !opened.hood || opened.tab !== "terminal" || !opened.record ||
        !opened.selected.includes("no-such-model")) {
        console.error("\nFAIL: a failed run did not hang a note under the peek button that opens the terminal with clai's error selected");
        process.exitCode = 1;
      }
      await page.click(".note.error .note-close");
      await page.click("#peek-close");
      await page.evaluate(() => { window.minutes.config.flags = "-cm mock_test"; });
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
    // A correction: the line's words open in place, Enter keeps them, and Save writes the file.
    if (opened) {
      await page.click("#transcript .utt-words");
      await page.fill("#transcript textarea.utt-edit", "Ship it on Friday.");
      await page.keyboard.press("Enter");
      const counted = await page.textContent("#fixes-count");
      await page.click("#fixes-save");
      const saved = await page
        .waitForFunction(() => document.querySelector("#fixes-count").textContent === "Saved", null, { timeout: 30_000 })
        .then(() => true, () => false);
      const file = await page.evaluate(async () =>
        (await window.minutes.readMeeting("meetings/summaries/2026-10-28T09-00Z_design-review.md", "Check", true))?.transcript);
      console.log(`Minutes, a correction: ${JSON.stringify({ counted, saved, file })}`);
      if (counted !== "1 correction" || !saved || file !== "**Speaker A** [00:12]: Ship it on Friday.\n") {
        console.error("\nFAIL: a correction to the transcript did not show on the post-it or did not reach the file");
        process.exitCode = 1;
      }
    }
    // Penelope, the red pen: her bubble runs clai with her own profile on copies of the meeting, and answers.
    if (opened) {
      await page.$eval("#penelope-pen", (el) => el.click());
      await page.fill("#penelope-input", "hello");
      await page.press("#penelope-input", "Enter");
      const answered = await page
        .waitForFunction(() => document.querySelectorAll("#penelope-log li.penelope-her").length >= 2 && !document.querySelector("#penelope").classList.contains("busy"), null, { timeout: 60_000 })
        .then(() => true, () => false);
      const her = await page.evaluate(() => {
        const action = [...window.hoodModel.procs.values()].find((p) => p.action.startsWith("minutes:Ask Penelope"))?.action;
        return {
          said: [...document.querySelectorAll("#penelope-log li.penelope-her")].at(-1)?.textContent,
          errors: document.querySelectorAll(".note.error").length,
          command: action ? window.hoodModel.tree(action).map((n) => n.proc.argv[2]).join(" ") : "",
        };
      });
      console.log(`Minutes, Penelope: ${JSON.stringify(her)}`);
      if (!answered || her.errors || !her.command.includes("-profile-path /tmp/penelope/profile.json")) {
        console.error("\nFAIL: Penelope did not answer in her bubble, or did not run clai with her profile");
        process.exitCode = 1;
      }
      await page.click("#penelope-close");
    }
  }
  // Minutes' sign-out of a session that pasted a token: the app forgets the token, says the key
  // itself stays valid, and the chip returns to the notebook in this tab (2026-11-04
  // research/http-host-call/PROMPT.md). A stored login's sign-out runs `slivingdoc logout`, which
  // the rows above prove on its own.
  if (bash) {
    // The stub site stands in for the hosted endpoint too, so the pull a token asks for stays on
    // this machine.
    await page.evaluate(
      (endpoint) => window.minutes.env.set("SLIVINGDOC_ENDPOINT", endpoint),
      `http://localhost:${server.address().port}`,
    );
    await page.evaluate(() => {
      if (document.querySelector("#notebook-card").hidden) document.querySelector("#connect").click();
    });
    await page.fill("#token-input", "sld_check_token_only");
    await page.click("#notebook-form button");
    const offered = await page
      .waitForSelector("#signout:not([hidden])", { timeout: 30_000 })
      .then(() => true, () => false);
    await page.click("#signout");
    const local = await page
      .waitForFunction(() => document.querySelector("#notebook-chip").textContent === "slivingdoc: local notebook", null, {
        timeout: 30_000,
      })
      .then(() => true, () => false);
    const said = await page.evaluate(() => document.querySelector("#signout-said").textContent);
    console.log(`Minutes, Sign out: ${JSON.stringify({ offered, local, said })}`);
    if (!offered || !local || !said.includes("stays valid")) {
      console.error("\nFAIL: Minutes did not offer Sign out, forget the token, or say the key stays valid");
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
