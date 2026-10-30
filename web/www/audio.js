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
  // `send(name, bytes)` hands captured samples to the machine; `notice(text)` tells the user.
  constructor(send, notice) {
    this.send = send;
    this.notice = notice;
    this.context = null;
    this.ready = null;
    this.active = new Map();
    this.button = null;
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
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
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
    if (name === "mic") this.attach(name, input, navigator.mediaDevices.getUserMedia({ audio: true }));
    if (name === "tab") this.offerTab(name, input);
  }

  async attach(name, input, request) {
    let stream;
    try {
      stream = await request;
    } catch (error) {
      this.notice(`no ${name === "mic" ? "microphone" : "shared audio"}: ${error.message}; recording silence`);
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
  }

  // getDisplayMedia needs a click, so a button asks for the tab whose audio to record.
  offerTab(name, input) {
    const button = document.createElement("button");
    button.className = "share-audio";
    button.textContent = "🔊 Share a tab's audio for the recording (a meeting tab, say)";
    button.onclick = () => {
      button.remove();
      this.attach(name, input, navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false },
        preferCurrentTab: false,
      }));
    };
    document.body.append(button);
    input.button = button;
  }

  stop(name, input) {
    this.active.delete(name);
    input.button?.remove();
    input.source?.disconnect();
    input.node?.disconnect();
    if (input.node) input.node.port.onmessage = null;
    input.stream?.getTracks().forEach((t) => t.stop());
  }
}
