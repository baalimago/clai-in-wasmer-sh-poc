// clai's -json records drawn for the peek's terminal: what streams in pieces is joined into
// running text, a tool is a line with its result under it, progress redraws one line, and what
// failed is red. The terminal takes "\r\n" for a new line.

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const paint = (code, text) => `${ESC}${code}m${text}${RESET}`;
const dim = (text) => paint("2", text);
const NL = "\r\n";

const lines = (text) => String(text ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
const onTerminal = (text) => lines(text).replaceAll("\n", NL);

const cut = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

// A tool's inputs on its line: key=value, the long ones cut.
function inputsText(inputs) {
  const entries = Object.entries(inputs ?? {});
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}=${cut(typeof value === "string" ? value : JSON.stringify(value), 60)}`).join(" ");
}

// What a tool printed, as its first line and how many more there are.
function outputText(output) {
  const all = lines(output).split("\n").filter((line) => line.trim());
  if (all.length === 0) return "(no output)";
  const more = all.length > 1 ? dim(` (+${all.length - 1} more line${all.length > 2 ? "s" : ""})`) : "";
  return cut(all[0], 160) + more;
}

const LEVEL = { error: "1;31", warn: "33", info: "36", debug: "90", trace: "90" };

// Draws one run's records in order. `print(record)` returns the text to write for it; `end()`
// closes what is still open. Text that streams (a reply, reasoning) and a progress line stay
// open, with no line end, until a record of another kind comes.
export class RecordPrinter {
  constructor() {
    // What the cursor's line holds: "" (nothing), "reply", "reasoning", or "progress:<title>".
    this.open = "";
  }

  close() {
    if (!this.open) return "";
    this.open = "";
    return RESET + NL;
  }

  // Leaves the line open for more of `kind`, closing another kind's first.
  stream(kind, lead, text) {
    const start = this.open === kind ? "" : this.close() + lead;
    this.open = kind;
    return start + onTerminal(text);
  }

  // A line, or lines, of its own.
  line(text) {
    return this.close() + text + NL;
  }

  // A line that is no record, as clai printed it.
  raw(text) {
    return this.line(onTerminal(text));
  }

  print(record) {
    switch (record.type) {
      case "reasoning_delta":
        return this.stream("reasoning", `${ESC}2;3m${"thinking "}`, record.text);
      case "reply_delta":
        return this.stream("reply", "", record.text);
      case "reply":
        // The deltas already wrote it; a reply that came whole is written here.
        return this.open === "reply" ? this.close() : this.line(onTerminal(record.text));
      case "tool_call": {
        const inputs = inputsText(record.inputs);
        return this.line(`${paint("36", "▸")} ${paint("1", record.name)}${inputs ? ` ${dim(inputs)}` : ""}`);
      }
      case "tool_result":
        return record.ok === false
          ? this.line(`  ${paint("1;31", "✗")} ${paint("31", `${record.name}: ${cut(lines(record.error || record.output).split("\n")[0], 400)}`)}`)
          : this.line(`  ${paint("32", "✓")} ${dim(`${record.name}: `)}${outputText(record.output)}`);
      case "progress": {
        const kind = `progress:${record.title}`;
        const text = `${dim("…")} ${record.title}${record.row ? ` ${record.row}` : ""} ${dim(record.state)}${record.detail ? ` ${record.detail}` : ""}`;
        // The same progress redraws its line; its end closes it.
        const redraw = this.open === kind ? `\r${ESC}2K` : this.close();
        this.open = kind;
        const done = record.state === "done" || record.state === "failed";
        return redraw + (record.state === "failed" ? paint("31", text) : text) + (done ? this.close() : "");
      }
      case "prompt": {
        const choices = record.choices?.length ? dim(` [${record.choices.join(" / ")}]`) : "";
        return this.line(`${paint("1;33", "?")} ${onTerminal(record.text)}${choices}`);
      }
      case "diagnostic": {
        const facts = Object.entries(record.facts ?? {}).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ");
        return this.line(`${paint(LEVEL[record.level] ?? "90", record.level)} ${dim(`[${record.subsystem}]`)} ${onTerminal(record.message)}${facts ? ` ${dim(facts)}` : ""}`);
      }
      case "error": {
        const causes = record.causes?.length ? record.causes : [{ message: record.message }];
        const many = causes.length > 1;
        let text = many ? `${paint("1;31", "error")}: ${causes.length} independent errors${NL}` : "";
        for (const cause of causes) {
          text += `${many ? "  - " : `${paint("1;31", "error")}: `}${paint("31", onTerminal(cause.message ?? ""))}${NL}`;
          const facts = [cause.status && `status ${cause.status}`, cause.provider_code].filter(Boolean).join(" · ");
          if (facts) text += `  ${dim(facts)}${NL}`;
          for (const remedy of cause.remedies ?? []) text += `  ${paint("36", "hint")}: ${onTerminal(remedy)}${NL}`;
        }
        return this.close() + text;
      }
      case "child_output":
        return this.line(dim(`${record.source ?? "child"}: ${onTerminal(record.text)}`));
      case "output":
        return this.line(record.stream === "stderr" ? dim(onTerminal(record.text)) : onTerminal(record.text));
      default:
        return this.line(dim(JSON.stringify(record)));
    }
  }

  end() {
    return this.close();
  }
}
