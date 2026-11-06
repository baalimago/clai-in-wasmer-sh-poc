// The page's audio inputs for the machine's /run/audio files: "mic" is the microphone
// (getUserMedia), "tab" the audio of a screen or tab the user shares (getDisplayMedia, which
// needs a click, so a button asks for it before a recording). An input is captured while the
// machine has its file open. Both run on one AudioContext at 48 kHz, so every open input delivers samples at the
// same pace, silence until its stream arrives: ffmpeg mixing the two never waits on one.

const SAMPLE_RATE = 48000;

// Mono, 16-bit little-endian, about 40 ms per message.
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(2048);
    this.filled = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    const frames = channels[0]?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (const channel of channels) sum += channel[i];
      const value = channels.length ? sum / channels.length : 0;
      this.samples[this.filled++] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
      if (this.filled === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(2048);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture", Capture);
`;

// What the browser shared, by the displaySurface of its video.
const SURFACES = { monitor: "Shared screen", window: "Shared window", browser: "Shared tab" };

export class AudioInputs {
  // `send(name, bytes)` hands captured samples to the machine; `notice(text)` tells the user;
  // `changed()` follows what is captured and shared; `relist()` follows `listing()`, which the
  // machine's /run/audio/devices holds. `media` and `Context` are the browser's mediaDevices and
  // AudioContext.
  constructor({ send, notice, changed = () => {}, relist = () => {}, media = globalThis.navigator?.mediaDevices, Context = globalThis.AudioContext }) {
    this.send = send;
    this.notice = notice;
    this.changed = changed;
    this.relist = relist;
    this.media = media;
    this.Context = Context;
    this.context = null;
    this.ready = null;
    this.active = new Map();
    this.mic = null;
    // The browser's other audio inputs by the name of their file: their deviceId and label.
    this.devices = new Map();
    // The screen or tab shared from the button: its stream and what it is, until it ends.
    this.shared = null;
  }

  // Asks for the microphone, which lets the browser name its audio inputs: "mic", the default,
  // and "devN" for the others, on Linux the "Monitor of ..." sources of PipeWire and PulseAudio
  // among them.
  async discover() {
    let stream;
    try {
      stream = await this.media.getUserMedia({ audio: true });
    } catch (error) {
      this.mic = null;
      this.notice(`no microphone: ${error.message}`);
      return;
    }
    const trackLabel = stream.getAudioTracks()[0]?.label ?? "";
    stream.getTracks().forEach((t) => t.stop());
    const inputs = (await this.media.enumerateDevices()).filter((d) => d.kind === "audioinput");
    // Chrome lists the default again as "Default - <its label>".
    const preferred = inputs.find((d) => d.deviceId === "default")?.label.replace(/^Default - /, "") ?? trackLabel;
    this.mic = clean(preferred) || "Microphone (browser)";
    for (const device of inputs) {
      if (["default", "communications", ""].includes(device.deviceId) || device.label === preferred) continue;
      if ([...this.devices.values()].some((d) => d.deviceId === device.deviceId)) continue;
      this.devices.set(`dev${this.devices.size + 1}`, { deviceId: device.deviceId, label: clean(device.label) });
    }
  }

  // The inputs for the machine, `{ name, label }`. The shared one's label is empty until a screen
  // or tab is shared, and "Monitor of ..." after, so that ffmpeg.sh lists it as a sink only then.
  listing() {
    const list = this.mic ? [{ name: "mic", label: this.mic }] : [];
    for (const [name, device] of this.devices) list.push({ name, label: device.label || name });
    list.push({ name: "tab", label: this.shared ? `Monitor of ${this.shared.label} (browser)` : "" });
    return list;
  }

  // What can be recorded: the microphone's label, and where the computer's audio comes from.
  access() {
    const monitor = [...this.devices.values()].find((d) => d.label.startsWith("Monitor of "));
    const computer = this.shared
      ? { label: this.shared.label, via: "share" }
      : monitor ? { label: monitor.label, via: "monitor" } : null;
    return { mic: this.mic, computer };
  }

  // From a click: asks the browser for a screen or tab to share, whose audio stays an input
  // until the share ends. Answers "shared", "refused" or "no-audio".
  async share() {
    let stream;
    try {
      stream = await this.media.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        // Sharing a whole screen then carries what the computer plays, where the browser can:
        // Chromium on Windows and ChromeOS, and on macOS from Chrome 141 on macOS 14.2. A tab
        // carries its own audio in every Chromium.
        systemAudio: "include",
      });
    } catch (error) {
      this.notice(`nothing shared: ${error.message}`);
      return "refused";
    }
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      this.notice("the share has no audio: share a tab, or the whole screen with its audio ticked");
      return "no-audio";
    }
    this.unshare();
    const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    const shared = { stream, label: SURFACES[surface] ?? "Shared screen or tab" };
    this.shared = shared;
    // Stopped from the browser's own bar, or the tab closed.
    for (const track of stream.getTracks()) track.addEventListener("ended", () => this.shared === shared && this.unshare());
    this.relist();
    this.changed();
    return "shared";
  }

  // Ends the share, if there is one.
  unshare() {
    if (!this.shared) return;
    const { stream } = this.shared;
    this.shared = null;
    stream.getTracks().forEach((t) => t.stop());
    this.relist();
    this.changed();
  }

  // The label the page gave input `name`.
  label(name) {
    if (name === "mic") return "Mic";
    if (name === "tab") return this.shared?.label ?? "Shared screen or tab";
    return this.devices.get(name)?.label ?? name;
  }

  // Captures exactly the inputs `names` lists.
  async want(names) {
    for (const [name, input] of this.active) {
      if (!names.includes(name)) this.stop(name, input);
    }
    for (const name of names) {
      if (!this.active.has(name)) await this.start(name);
    }
    if (this.active.size === 0 && this.context) {
      const context = this.context;
      this.context = null;
      this.ready = null;
      await context.close();
    }
  }

  async start(name) {
    const input = { node: null, source: null, stream: null, owned: true };
    this.active.set(name, input);
    if (!this.context) {
      this.context = new this.Context({ sampleRate: SAMPLE_RATE });
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      this.ready = this.context.audioWorklet.addModule(url);
    }
    const context = this.context;
    await this.ready;
    await context.resume();
    if (this.active.get(name) !== input) return;
    input.node = new AudioWorkletNode(context, "capture", { numberOfOutputs: 1 });
    input.node.port.onmessage = ({ data }) => this.send(name, new Uint8Array(data));
    // Silent: the node only runs while something pulls on it.
    input.node.connect(context.destination);
    if (name === "mic") await this.attach(name, input, this.media.getUserMedia({ audio: true }));
    if (name === "tab") {
      // The share outlives the recording: it is the button's to end.
      input.owned = false;
      if (this.shared) await this.attach(name, input, Promise.resolve(this.shared.stream));
      else this.notice("no screen or tab is shared; recording silence for it");
    }
    const device = this.devices.get(name);
    if (device) {
      // A monitor carries what the computer plays: as it is, without a microphone's processing.
      const raw = device.label.startsWith("Monitor of ");
      await this.attach(name, input, this.media.getUserMedia({
        audio: { deviceId: { exact: device.deviceId }, echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw },
      }));
    }
    this.changed();
  }

  async attach(name, input, request) {
    let stream;
    try {
      stream = await request;
    } catch (error) {
      this.notice(`no ${this.label(name)}: ${error.message}; recording silence`);
      return;
    }
    if (this.active.get(name) !== input) {
      if (input.owned) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    input.stream = stream;
    input.source = this.context.createMediaStreamSource(stream);
    input.source.connect(input.node);
    this.changed();
  }

  // The inputs captured now, and whether each has a source yet.
  inputs() {
    return [...this.active].map(([name, input]) => ({ name, label: this.label(name), live: input.stream !== null }));
  }

  stop(name, input) {
    this.active.delete(name);
    input.source?.disconnect();
    input.node?.disconnect();
    if (input.node) input.node.port.onmessage = null;
    if (input.owned) input.stream?.getTracks().forEach((t) => t.stop());
    this.changed();
  }
}

const clean = (label) => label.replace(/[\t\n]/g, " ");

// The OS and browser engine `navigator` reports, for what its audio capture can do.
export function platformOf({ userAgent = "" }) {
  const os = /CrOS/.test(userAgent) ? "chromeos"
    : /Windows/.test(userAgent) ? "windows"
    : /Macintosh|Mac OS X/.test(userAgent) ? "mac"
    : /Linux|X11/.test(userAgent) ? "linux" : "other";
  const browser = /Firefox\//.test(userAgent) ? "firefox"
    : /Chrome\/|Chromium\/|Edg\//.test(userAgent) ? "chromium"
    : /Safari\//.test(userAgent) ? "safari" : "other";
  return { os, browser };
}

const NAMES = { firefox: "Firefox", safari: "Safari", other: "This browser" };

// What the browser on `platform` can record of the computer's sound, in plain words, and the words
// of the button that asks for a share, or null where a share carries no sound. `monitor` is the
// label of an input that already carries the computer's sound, if there is one.
export function audioLimits({ os, browser }, monitor = null) {
  if (monitor) {
    return {
      share: browser === "chromium" ? "Share a tab or the screen" : null,
      text: [`This browser hands Minutes your computer's sound through "${monitor}": desktop apps are recorded too, no share needed.`],
    };
  }
  if (browser !== "chromium") {
    return {
      share: null,
      text: [
        `${NAMES[browser]} cannot record a tab's sound or your computer's sound: only your mic is recorded, so the other side of a call is lost.`,
        "To record a call, open Minutes in Chrome or Edge.",
      ],
    };
  }
  if (os === "windows" || os === "chromeos") {
    return {
      share: "Share a tab or the screen",
      text: [
        "Share your entire screen and tick \"Also share system audio\" to record everything the computer plays, desktop apps such as Zoom or Teams included.",
        "Or share only the meeting's tab.",
      ],
    };
  }
  if (os === "mac") {
    return {
      share: "Share a tab or the screen",
      text: [
        "Chrome on macOS records your computer's sound only from Chrome 141 on macOS 14.2 or newer, when you share the entire screen with its audio.",
        "Otherwise it records only a browser tab's sound: a call in the Zoom or Teams desktop app is not recorded, only your voice. Join the call in a Chrome tab and share that tab.",
      ],
    };
  }
  return {
    share: "Share the meeting's tab",
    text: [
      "Chrome on Linux cannot record your computer's sound, only a browser tab's. Sharing a window or the screen gives no sound.",
      "A call in the Zoom, Teams or Slack desktop app is not recorded, only your voice. Join the call in a Chrome tab and share that tab.",
    ],
  };
}
