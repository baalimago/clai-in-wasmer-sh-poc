// The page's audio inputs for the machine's /run/audio files: "mic" is the microphone
// (getUserMedia), "tab" the audio of a tab, window or screen the user shares (getDisplayMedia,
// which needs a click, so a button asks for it). An input is captured while the machine has its
// file open. Both run on one AudioContext at 48 kHz, so every open input delivers samples at the
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

export class AudioInputs {
  // `send(name, bytes)` hands captured samples to the machine; `notice(text)` tells the user;
  // `offer(share)` puts a button up that calls `share` (from a click: the browser asks for
  // the tab), and `offer(null)` takes it down. `changed()` follows what is captured. `media` and
  // `Context` are the browser's mediaDevices and AudioContext.
  constructor(send, notice, offer, changed = () => {}, { media = globalThis.navigator?.mediaDevices, Context = globalThis.AudioContext } = {}) {
    this.send = send;
    this.notice = notice;
    this.offer = offer;
    this.changed = changed;
    this.media = media;
    this.Context = Context;
    // The share asked for with the click that started a recording, which "tab" records once open.
    this.shared = null;
    this.context = null;
    this.ready = null;
    this.active = new Map();
    // The browser's other audio inputs by the name of their file: their deviceId and label.
    this.devices = new Map();
  }

  // Asks for the microphone, which lets the browser name its audio inputs, and returns them as
  // inputs for the machine, `{ name, label }`: "mic", the default, and "devN" for the others,
  // on Linux the "Monitor of ..." sources of PipeWire and PulseAudio among them.
  async discover() {
    let stream;
    try {
      stream = await this.media.getUserMedia({ audio: true });
    } catch (error) {
      this.notice(`no microphone: ${error.message}`);
      return [];
    }
    const trackLabel = stream.getAudioTracks()[0]?.label ?? "";
    stream.getTracks().forEach((t) => t.stop());
    const inputs = (await this.media.enumerateDevices()).filter((d) => d.kind === "audioinput");
    // Chrome lists the default again as "Default - <its label>".
    const preferred = inputs.find((d) => d.deviceId === "default")?.label.replace(/^Default - /, "") ?? trackLabel;
    const found = [{ name: "mic", label: preferred || "Microphone (browser)" }];
    for (const device of inputs) {
      if (["default", "communications", ""].includes(device.deviceId) || device.label === preferred) continue;
      let name = [...this.devices].find(([, d]) => d.deviceId === device.deviceId)?.[0];
      if (!name) {
        name = `dev${this.devices.size + 1}`;
        this.devices.set(name, { deviceId: device.deviceId, label: device.label });
      }
      found.push({ name, label: (device.label || name).replace(/[\t\n]/g, " ") });
    }
    return found;
  }

  // The label the page gave input `name`.
  label(name) {
    if (name === "mic") return "Mic";
    if (name === "tab") return "Shared tab";
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
    const input = { node: null, source: null, stream: null };
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
    if (name === "mic") this.attach(name, input, this.media.getUserMedia({ audio: true }));
    if (name === "tab") {
      const shared = this.shared;
      this.shared = null;
      if (shared) this.attach(name, input, shared, () => this.offerTab(name, input));
      else this.offerTab(name, input);
    }
    const device = this.devices.get(name);
    if (device) {
      // A monitor carries what the computer plays: as it is, without a microphone's processing.
      const raw = device.label.startsWith("Monitor of ");
      this.attach(name, input, this.media.getUserMedia({
        audio: { deviceId: { exact: device.deviceId }, echoCancellation: !raw, noiseSuppression: !raw, autoGainControl: !raw },
      }));
    }
    this.changed();
  }

  // `retry()`, when the request fails, asks again.
  async attach(name, input, request, retry = null) {
    let stream;
    try {
      stream = await request;
    } catch (error) {
      this.notice(`no ${name === "tab" ? "shared audio" : this.label(name)}: ${error.message}; ${retry ? "share it with the button" : "recording silence"}`);
      if (retry && this.active.get(name) === input) retry();
      return;
    }
    if (this.active.get(name) !== input) return stream.getTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      return this.notice("the shared tab or screen has no audio; recording silence for it");
    }
    input.stream = stream;
    input.source = this.context.createMediaStreamSource(stream);
    input.source.connect(input.node);
    this.changed();
  }

  // getDisplayMedia needs a click, so a button asks for the tab whose audio to record.
  offerTab(name, input) {
    input.offered = true;
    this.offer(() => {
      this.offer(null);
      input.offered = false;
      this.attach(name, input, this.askDisplay());
    });
  }

  askDisplay() {
    return this.media.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      // Sharing a whole screen then carries what the computer plays, where the browser can:
      // Chromium on Windows and ChromeOS, and on macOS from Chrome 141 on macOS 14.2. A tab carries
      // its own audio in every Chromium.
      systemAudio: "include",
    });
  }

  // Whether the computer's audio needs a share: "monitor" when an input of the browser's already
  // carries what the computer plays (PipeWire's or PulseAudio's "Monitor of ..." on Linux), which
  // ffmpeg.sh makes the default sink; otherwise "asked", having asked for a share now, from the
  // click that calls this, so the browser's prompt comes with it and not on a later button.
  shareAhead() {
    if ([...this.devices.values()].some((d) => d.label.startsWith("Monitor of "))) return "monitor";
    this.dropShared();
    this.shared = this.askDisplay();
    // Turned down, the share is told when "tab" opens.
    this.shared.catch(() => {});
    return "asked";
  }

  // Stops a share asked for ahead that no recording took.
  async dropShared() {
    const shared = this.shared;
    this.shared = null;
    const stream = await shared?.catch(() => null);
    stream?.getTracks().forEach((t) => t.stop());
  }

  // The inputs captured now, and whether each has a source yet.
  inputs() {
    return [...this.active].map(([name, input]) => ({ name, label: this.label(name), live: input.stream !== null }));
  }

  stop(name, input) {
    this.active.delete(name);
    if (input.offered) this.offer(null);
    input.source?.disconnect();
    input.node?.disconnect();
    if (input.node) input.node.port.onmessage = null;
    input.stream?.getTracks().forEach((t) => t.stop());
    this.changed();
  }
}
