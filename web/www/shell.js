// The page's shell: a line editor over the terminal and a word splitter for its commands.

// Splits a command line into words the way a POSIX shell does for quotes and backslashes,
// without expansions.
export function split(line) {
  const words = [];
  let word = null;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

// Reads lines from the terminal, with backspace, ^C, ^L and history on the arrow keys, and
// hands each to `run`, which resolves when the command is done. What is typed meanwhile goes
// to `passthrough`.
export class LineEditor {
  constructor(term, prompt, run, passthrough) {
    this.term = term;
    this.prompt = prompt;
    this.run = run;
    this.passthrough = passthrough;
    this.line = "";
    this.history = [];
    this.recalled = 0;
    this.busy = false;
    term.onData((data) => this.input(data));
    term.write(prompt);
  }

  input(data) {
    if (this.busy) return this.passthrough(data);
    switch (data) {
      case "\r":
        this.term.write("\r\n");
        this.submit(this.line);
        return;
      case "\x7f":
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.term.write("\b \b");
        }
        return;
      case "\x03":
        this.term.write("^C\r\n" + this.prompt);
        this.line = "";
        return;
      case "\x0c":
        this.term.clear();
        return;
      case "\x1b[A":
        return this.recall(1);
      case "\x1b[B":
        return this.recall(-1);
    }
    const printable = [...data].filter((c) => c >= " " && c !== "\x7f").join("");
    if (printable !== data) return;
    this.line += data;
    this.term.write(data);
  }

  recall(step) {
    const index = this.recalled + step;
    if (index < 0 || index > this.history.length) return;
    this.recalled = index;
    const line = index === 0 ? "" : this.history[this.history.length - index];
    this.term.write("\r\x1b[K" + this.prompt + line);
    this.line = line;
  }

  async submit(line) {
    this.busy = true;
    this.line = "";
    this.recalled = 0;
    if (line.trim() !== "" && this.history.at(-1) !== line) this.history.push(line);
    try {
      return await this.run(line);
    } finally {
      this.busy = false;
      this.term.write(this.prompt);
    }
  }
}
