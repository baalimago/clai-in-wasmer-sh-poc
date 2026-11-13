// What the agent said, from clai's -json records: one JSON object a line, each with a `type`
// (reply_delta, reply, tool_call, tool_result, progress, prompt, diagnostic, error, output).
// The app shows the reply; what went wrong becomes a note that points under the hood, where
// the terminal has every record.

const firstLine = (text) => (text ?? "").split("\n").find((line) => line.trim()) ?? "";

// One run of the agent, a line at a time.
export class AgentRun {
  constructor() {
    this.reply = null;
    this.deltas = "";
    this.errors = [];
    this.warnings = [];
    this.failures = [];
    this.prompts = [];
    // Lines that are no record: -json promises none, so each is worth a look.
    this.stray = [];
  }

  // Takes a line clai printed and returns its record, or null for a line that holds none.
  take(line) {
    const text = line.trim();
    if (!text) return null;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      record = null;
    }
    if (record === null || typeof record !== "object" || typeof record.type !== "string") {
      this.stray.push(text);
      return null;
    }
    switch (record.type) {
      case "reply_delta":
        this.deltas += record.text ?? "";
        break;
      case "reply":
        // A reply closes its deltas; the last one is the agent's answer.
        this.reply = record.text ?? "";
        this.deltas = "";
        break;
      case "tool_result":
        if (record.ok === false) {
          this.failures.push({ name: record.name ?? "tool", error: record.error || firstLine(record.output) });
        }
        break;
      case "diagnostic":
        if (record.level === "error" || record.level === "warn") this.warnings.push(record);
        break;
      case "error":
        this.errors.push(record);
        break;
      case "prompt":
        this.prompts.push(record);
        break;
      default:
        break;
    }
    return record;
  }

  // The agent's answer: its last reply, or what streamed of one that never closed.
  get text() {
    return (this.reply ?? this.deltas).trim();
  }
}

// An error's message without clai's plumbing in front and the provider's raw body behind.
export function brief(message, limit = 220) {
  let text = firstLine(message)
    .replace(/, body: .*$/s, "")
    .replace(/^(?:[\w.-]+: )?run step \d+: /, "")
    .replace(/^execute tool step \d+: /, "")
    .replace(/^(?:completion stream error|stream completions): /, "")
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
  return text;
}

const BY_STATUS = [
  [(s) => s === 401 || s === 403, "The provider rejected the API key"],
  [(s) => s === 402, "The provider's account is out of credits"],
  [(s) => s === 404, "The provider does not know the model"],
  [(s) => s === 429, "The provider is rate limiting"],
  [(s) => s >= 500, "The provider is unavailable"],
];

function headline(cause, message) {
  if (/^interrupted by signal/.test(message)) return "The agent was interrupted";
  const byStatus = BY_STATUS.find(([matches]) => matches(cause.status))?.[1];
  if (byStatus) return byStatus;
  if (/insufficient credits|insufficient_quota/.test(message)) return "The provider's account is out of credits";
  if (/missing \w+_API_KEY|'\w+_API_KEY' not set/.test(message)) return "An API key is missing";
  if (/returned no completion/.test(message)) return "The provider sent no reply";
  if (/the reply is truncated/.test(message)) return "The reply was cut off";
  return "The agent stopped with an error";
}

// What stopped a run, as `{ level, title, detail, hint, code }`, or null when nothing did.
// `hint` is clai's first remedy; `code` the provider's own word for it.
export function problemOf(run, status) {
  const error = run.errors.at(-1);
  if (error) {
    const causes = error.causes ?? [];
    const cause = causes.find((c) => c.status || c.provider_code) ?? causes[0] ?? {};
    const message = cause.message ?? error.message ?? "";
    return {
      level: "error",
      title: headline(cause, message),
      detail: brief(message),
      hint: cause.remedies?.[0] ?? null,
      code: cause.provider_code ?? null,
    };
  }
  // A run that ended without a word but printed lines that are no record died on the way: a
  // panic, or a program that never started.
  const died = status === 0 && run.stray.length > 0 && run.text === "";
  if (status === 0 && !died) return null;
  if (died) return { level: "error", title: "The agent stopped unexpectedly", detail: brief(run.stray.at(-1)), hint: null, code: null };
  const said = run.stray.at(-1) ?? run.warnings.at(-1)?.message ?? run.failures.at(-1)?.error ?? "";
  return { level: "error", title: `The agent stopped with exit status ${status}`, detail: brief(said), hint: null, code: null };
}

const MISSING_PROGRAM = /exit status 127|No such file or directory|executable file not found|command not found/;

// A tool that failed: the agent may go on, so this is a warning.
export function toolProblem({ name, error }) {
  return {
    level: "warn",
    title: `The agent's ${name} tool failed`,
    detail: brief(error),
    hint: MISSING_PROGRAM.test(error ?? "") ? "A program the tool starts is missing on the machine." : null,
    code: null,
  };
}
