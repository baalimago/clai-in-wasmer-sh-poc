// The "under the hood" half: what the machine's processes do, from the kernel's events
// (web/src/observe.rs). Each line the page runs is `bash -c LINE TAG`, so the process's $0, its
// last argument, names who asked for it ("minutes:Record", "terminal"), and its descendants
// inherit that.

// `KEY=sk-...` with only the last four characters of the value.
export function mask(text) {
  return text.replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=(\S+)/g, (_, key, value) =>
    `${key}=${value.length > 8 ? `${value.slice(0, 3)}…${value.slice(-4)}` : "…"}`);
}

const base = (path) => path.split("/").filter(Boolean).at(-1) ?? path;

// What a process runs, in a line: a shell's script, else its arguments.
export function describe(proc) {
  const argv = proc.argv;
  if (argv[0] === "bash" && argv[1] === "-c" && argv.length >= 3) {
    const script = argv[2].split("\n").filter((l) => !l.startsWith("cd -- ")).join("; ");
    return `bash -c ${script}`;
  }
  return [base(proc.path), ...argv.slice(1)].join(" ");
}

export class Machine {
  constructor() {
    this.procs = new Map();
    this.log = [];
    this.fds = new Map();
    this.resources = new Map();
    this.dropped = 0;
    this.listeners = new Set();
  }

  onChange(listener) {
    this.listeners.add(listener);
  }

  add(events) {
    if (events.length === 0) return;
    for (const event of events) this.apply(event);
    for (const listener of this.listeners) listener(events);
  }

  apply(e) {
    if (e.type === "exit" || e.type === "reaped") {
      const pid = e.type === "exit" ? e.pid : e.child;
      for (const key of this.fds.keys()) if (key.startsWith(`${pid}:`)) this.fds.delete(key);
    }
    switch (e.type) {
      case "exec": {
        const parent = this.procs.get(e.ppid);
        const tag = e.argv[0] === "bash" && e.argv[1] === "-c" ? e.argv[3] : undefined;
        const known = this.procs.get(e.pid);
        const proc = known ?? { pid: e.pid, start: e.t, end: null, status: null, files: new Set() };
        proc.ppid = e.ppid;
        proc.path = e.path;
        proc.argv = e.argv;
        proc.action = tag ?? known?.action ?? parent?.action ?? "machine";
        proc.name = base(e.path);
        this.procs.set(e.pid, proc);
        // A forked child has its parent's descriptors, but for those it changed before execve.
        if (!known) {
          for (const [key, fd] of this.fds) {
            const [pid, n] = key.split(":");
            if (fd && Number(pid) === e.ppid && !this.fds.has(`${e.pid}:${n}`)) this.fds.set(`${e.pid}:${n}`, fd);
          }
        }
        this.note(e, "exec", describe(proc), proc);
        break;
      }
      case "exit": {
        const proc = this.procs.get(e.pid);
        if (proc && proc.end === null) {
          proc.end = e.t;
          proc.status = `exit ${e.code}`;
          this.note(e, "exit", `${proc.name} exited with ${e.code}`, proc);
        }
        break;
      }
      case "reaped": {
        const proc = this.procs.get(e.child);
        if (proc) {
          const status = e.end === "killed" ? `killed by signal ${e.n}` : `exit ${e.n}`;
          if (proc.end === null) {
            proc.end = e.t;
            this.note(e, "exit", `${proc.name} ${e.end === "killed" ? status : `exited with ${e.n}`}`, proc);
          }
          proc.status = status;
        }
        break;
      }
      case "open": {
        this.fds.set(`${e.pid}:${e.fd}`, { kind: "file", name: e.path, write: e.write });
        if (e.write) {
          const proc = this.procs.get(e.pid);
          const r = this.resource("file", e.path, proc);
          r.writes += 1;
          this.note(e, "fs", `${proc?.name ?? e.pid} writes ${e.path}`, proc);
        } else if (e.path.startsWith("/run/audio/") && !e.path.endsWith("/play")) {
          this.note(e, "audio", `${this.procs.get(e.pid)?.name ?? e.pid} opens ${e.path}: the page captures it`,
            this.procs.get(e.pid));
        }
        break;
      }
      case "connect": {
        const name = `${e.host}:${e.port}`;
        this.fds.set(`${e.pid}:${e.fd}`, { kind: "net", name });
        const proc = this.procs.get(e.pid);
        this.resource("net", name, proc).connects += 1;
        this.note(e, "net", `${proc?.name ?? e.pid} connects to ${name}`, proc);
        break;
      }
      // A descriptor that is closed, or now refers to something unknown, is null: a child that
      // changed it does not get its parent's when it execs.
      case "close":
        this.fds.set(`${e.pid}:${e.fd}`, null);
        break;
      case "dup":
        this.fds.set(`${e.pid}:${e.to}`, this.fds.get(`${e.pid}:${e.from}`) ?? null);
        break;
      case "io": {
        const fd = this.fds.get(`${e.pid}:${e.fd}`);
        if (!fd) break;
        if (fd.kind === "file" && !fd.write) break;
        const r = this.resource(fd.kind, fd.name, this.procs.get(e.pid));
        r[e.dir] += e.bytes;
        r.last = e.t;
        break;
      }
      case "mkdir":
      case "unlink":
        this.note(e, "fs", `${this.procs.get(e.pid)?.name ?? e.pid} ${e.type === "mkdir" ? "makes" : "removes"} ${e.path}`,
          this.procs.get(e.pid));
        break;
      case "rename": {
        // A file written whole, then renamed into place, is the file it became.
        const r = this.resources.get(`file:${e.from}`);
        if (r) {
          this.resources.delete(`file:${e.from}`);
          const into = this.resources.get(`file:${e.to}`);
          if (into) {
            into.out += r.out;
            into.writes += r.writes;
            into.last = Math.max(into.last, r.last);
            for (const name of r.procs) into.procs.add(name);
          } else {
            r.name = e.to;
            this.resources.set(`file:${e.to}`, r);
          }
        }
        this.note(e, "fs", `${this.procs.get(e.pid)?.name ?? e.pid} renames ${e.from} to ${e.to}`, this.procs.get(e.pid));
        break;
      }
      case "dropped":
        this.dropped += e.count;
        break;
    }
  }

  note(e, kind, text, proc) {
    this.log.push({ t: e.t, kind, text: mask(text), pid: e.pid, action: proc?.action ?? "machine" });
    if (this.log.length > 2000) this.log.splice(0, this.log.length - 2000);
  }

  resource(kind, name, proc) {
    const key = `${kind}:${name}`;
    let r = this.resources.get(key);
    if (!r) {
      r = { kind, name, in: 0, out: 0, writes: 0, connects: 0, procs: new Set(), last: 0 };
      this.resources.set(key, r);
    }
    if (proc) r.procs.add(proc.name);
    return r;
  }

  // The processes an action started, as a tree: [{proc, children}].
  tree(action) {
    const mine = [...this.procs.values()].filter((p) => p.action === action);
    const byParent = new Map();
    for (const p of mine) {
      const siblings = byParent.get(p.ppid) ?? [];
      siblings.push(p);
      byParent.set(p.ppid, siblings);
    }
    const build = (p) => ({ proc: p, children: (byParent.get(p.pid) ?? []).map(build) });
    return mine.filter((p) => !mine.some((q) => q.pid === p.ppid)).map(build);
  }

  // The processes of `action` named `name`, newest first.
  find(action, name) {
    return [...this.procs.values()].filter((p) => p.action === action && p.name === name).reverse();
  }
}

const KINDS = ["exec", "exit", "net", "fs", "audio"];

// Renders `machine` into the hood's elements.
export class HoodView {
  constructor(machine, root) {
    this.machine = machine;
    this.root = root;
    this.action = null;
    this.command = "";
    this.filters = new Set(KINDS);
    this.pending = false;
    // The log keeps to its newest entry until scrolled up.
    this.follow = true;
    const log = root.querySelector("#hood-log");
    log.onscroll = () => {
      this.follow = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
    };
    for (const chip of root.querySelectorAll("[data-kind]")) {
      chip.onclick = () => {
        const kind = chip.dataset.kind;
        if (this.filters.has(kind)) this.filters.delete(kind);
        else this.filters.add(kind);
        chip.setAttribute("aria-pressed", String(this.filters.has(kind)));
        this.render();
      };
    }
    machine.onChange(() => this.schedule());
  }

  // The app ran `command` for the button `label`.
  ran(label, action, command) {
    this.action = action;
    this.label = label;
    this.command = command;
    this.schedule();
  }

  schedule() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.render();
    });
  }

  render() {
    const $ = (s) => this.root.querySelector(s);
    if (this.action) {
      $("#hood-label").textContent = this.label;
      $("#hood-command").textContent = mask(this.command);
      $("#hood-last").hidden = false;
    }
    this.renderTree($("#hood-tree"));
    this.renderLog($("#hood-log"));
    this.renderResources($("#hood-net"), "net");
    this.renderResources($("#hood-files"), "file");
    $("#hood-dropped").hidden = this.machine.dropped === 0;
    $("#hood-dropped").textContent = `${this.machine.dropped} events dropped: the page fell behind`;
  }

  renderTree(list) {
    list.replaceChildren();
    if (!this.action) return;
    const rows = [];
    const walk = (node, depth) => {
      rows.push([node.proc, depth]);
      for (const child of node.children) walk(child, depth + 1);
    };
    for (const root of this.machine.tree(this.action)) walk(root, 0);
    for (const [proc, depth] of rows.slice(-40)) {
      const li = document.createElement("li");
      li.style.paddingLeft = `${depth * 16}px`;
      const pid = document.createElement("span");
      pid.className = "pid";
      pid.textContent = String(proc.pid);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = mask(describe(proc));
      name.title = mask(proc.argv.join(" "));
      const state = document.createElement("span");
      state.className = `state ${proc.end === null ? "running" : proc.status?.startsWith("exit 0") ? "ok" : "failed"}`;
      state.textContent = proc.end === null ? "running" : proc.status;
      li.append(pid, name, state);
      list.append(li);
    }
  }

  renderLog(list) {
    const entries = this.machine.log.filter((e) => this.filters.has(e.kind)).slice(-300);
    list.replaceChildren();
    for (const e of entries) {
      const li = document.createElement("li");
      li.dataset.kind = e.kind;
      const time = document.createElement("time");
      time.textContent = new Date(e.t).toISOString().slice(11, 23);
      const kind = document.createElement("span");
      kind.className = `tag ${e.kind}`;
      kind.textContent = e.kind;
      const text = document.createElement("span");
      text.textContent = e.text;
      const from = document.createElement("span");
      from.className = "from";
      from.textContent = e.action.replace(/^minutes:/, "");
      li.append(time, kind, text, from);
      list.append(li);
    }
    if (this.follow) list.scrollTop = list.scrollHeight;
  }

  renderResources(table, kind) {
    const body = table.querySelector("tbody");
    body.replaceChildren();
    const rows = [...this.machine.resources.values()].filter((r) => r.kind === kind).sort((a, b) => b.last - a.last);
    for (const r of rows.slice(0, 100)) {
      const tr = document.createElement("tr");
      const cells = kind === "net"
        ? [r.name, [...r.procs].join(", "), bytes(r.out), bytes(r.in)]
        : [r.name, [...r.procs].join(", "), bytes(r.out)];
      for (const text of cells) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      body.append(tr);
    }
  }
}

export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
