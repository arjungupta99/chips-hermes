/**
 * Hermes's gateway restarted from Chips (Chips ADR 0094), and started with the bridge, on a
 * machine of the test's own: every process, signal, start and file is a fake's, so nothing here
 * can stop or start anything real.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  EXPAT,
  expand,
  type GatewayAt,
  gatewayRunArgs,
  Gateways,
  gatewaysOf,
  isLocal,
  type Launched,
  type ProcessInfo,
  restarter,
  serviceOf,
  type System,
  whyFrom,
  wrapperOf,
} from "../src/gateway.ts";

const HOME = "/Users/someone";
const ROOT = `${HOME}/.hermes`;
const HERMES = "/opt/homebrew/bin/hermes";
const URL = "http://127.0.0.1:8642";
const LOG = `${HOME}/Library/Logs/chips-hermes-gateway.log`;
const PLIST = `${HOME}/Library/LaunchAgents/ai.hermes.gateway.plist`;
const CELLAR = "/opt/homebrew/Cellar/hermes-agent/0.22.0";
const ENTRY = `${CELLAR}/libexec/bin/hermes`;
const RUN = `/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python ${ENTRY} gateway run`;

/** Homebrew's wrapper as Hermes 0.22.0 installs it, its line cut short. */
const WRAPPER = [
  "#!/bin/bash",
  `HERMES_BUNDLED_SKILLS="${CELLAR}/share/hermes-agent/skills" HERMES_BIN="\${HERMES_BIN:-${CELLAR}/bin/hermes}" HERMES_PYTHON="${CELLAR}/libexec/bin/python3" HERMES_REVISION="v0.22.0" HERMES_LAZY_INSTALL_TARGET="\${HERMES_LAZY_INSTALL_TARGET:-\${HERMES_HOME:-$HOME/.hermes}/lazy-packages}" exec "${ENTRY}"  "$@"`,
  "",
].join("\n");

/** What Hermes says as it dies on this Mac's Python (27 October 2026). */
const EXPAT_DEATH = [
  "⚠ install out of sync (ffmpeg: not installed or outdated; ripgrep: not installed or outdated)",
  "Traceback (most recent call last):",
  '  File "/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/lib/python3.14/xml/parsers/expat.py", line 4, in <module>',
  "    from pyexpat import *",
  "ImportError: dlopen(/opt/homebrew/Cellar/python@3.14/3.14.8_2/Frameworks/Python.framework/Versions/3.14/lib/python3.14/lib-dynload/pyexpat.cpython-314-darwin.so, 0x0002): Symbol not found: _XML_SetAllocTrackerActivationThreshold",
  "  Referenced from: <3E5EDC6B> /opt/homebrew/Cellar/python@3.14/3.14.8_2/lib-dynload/pyexpat.cpython-314-darwin.so",
  "  Expected in:     <4D62FA9D> /usr/lib/libexpat.1.dylib",
  "",
].join("\n");

interface Proc {
  readonly pid: number;
  readonly uid: number;
  readonly command: string;
  readonly cwd: string;
  readonly port: number;
  /** Whether its API server answers (from `servesAt` on). */
  servesAt: number;
  alive: boolean;
  /** What stops it: SIGTERM, only SIGKILL, or nothing. */
  readonly stopsOn: "SIGTERM" | "SIGKILL" | "never";
  end?: (code: number | null) => void;
}

/** How a program the bridge starts behaves: answers after a while, or dies saying something. */
type Behaviour =
  | { readonly serves: number }
  | { readonly dies: number; readonly says: string; readonly code?: number }
  | { readonly silent: true };

/** A machine of the test's own, with a clock that moves only as the bridge waits. */
class Machine implements System {
  platform: NodeJS.Platform = "darwin";
  readonly uid = 501;
  readonly home = HOME;
  clock = 1_000_000;
  readonly files = new Map<string, string>([[HERMES, WRAPPER]]);
  readonly procs = new Map<number, Proc>();
  readonly signals: [number, string][] = [];
  readonly launches: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  readonly runs: { command: string; args: readonly string[] }[] = [];
  log = "";
  /** The port a program started listens on. */
  launchPort = 8642;
  private nextPid = 70_000;
  private readonly due: { at: number; act: () => void }[] = [];
  /** How each program started behaves, in turn; the last one again after. */
  behaviours: Behaviour[] = [{ serves: 2000 }];
  /** What `hermes gateway restart|start` does, and its exit. */
  onRun: (args: readonly string[]) => { code: number; output: string } = () => ({ code: 0, output: "" });

  gateway(over: Partial<Proc> = {}): Proc {
    const proc: Proc = { pid: 52215, uid: 501, command: RUN, cwd: `${HOME}/work`, port: 8642, servesAt: 0, alive: true, stopsOn: "SIGTERM", ...over };
    this.procs.set(proc.pid, proc);
    return proc;
  }

  at(delay: number, act: () => void): void {
    this.due.push({ at: this.clock + delay, act });
  }

  exists = (path: string) => this.files.has(path);
  read = (path: string) => this.files.get(path);
  which = (command: string, env: NodeJS.ProcessEnv) =>
    command === "hermes" && (env["PATH"] ?? "").split(":").includes("/opt/homebrew/bin") && this.files.has(HERMES) ? HERMES : undefined;
  listener = async (port: number) => [...this.procs.values()].find((proc) => proc.alive && proc.port === port)?.pid;
  describe = async (pid: number): Promise<ProcessInfo | undefined> => {
    const proc = this.procs.get(pid);
    return proc?.alive ? { uid: proc.uid, command: proc.command, cwd: proc.cwd } : undefined;
  };
  alive = (pid: number) => this.procs.get(pid)?.alive === true;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.signals.push([pid, signal]);
    const proc = this.procs.get(pid);
    if (proc === undefined || proc.stopsOn === "never") return;
    if (signal === "SIGKILL" || proc.stopsOn === "SIGTERM") this.stop(proc, null);
  }
  stop(proc: Proc, code: number | null): void {
    proc.alive = false;
    proc.end?.(code);
  }
  run = async (command: string, args: readonly string[]) => {
    this.runs.push({ command, args });
    return this.onRun(args);
  };
  launch(spec: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string; log: string }): Launched {
    this.launches.push(spec);
    const behaviour = this.behaviours[Math.min(this.launches.length - 1, this.behaviours.length - 1)] ?? { serves: 0 };
    const proc: Proc = {
      pid: (this.nextPid += 1),
      uid: this.uid,
      command: `Python ${spec.command} ${spec.args.join(" ")}`,
      cwd: spec.cwd,
      port: this.launchPort,
      servesAt: "serves" in behaviour ? this.clock + behaviour.serves : Number.POSITIVE_INFINITY,
      alive: true,
      stopsOn: "SIGTERM",
    };
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
      proc.end = (code) => done({ code, signal: null });
    });
    this.procs.set(proc.pid, proc);
    if ("dies" in behaviour) {
      this.at(behaviour.dies, () => {
        this.log += behaviour.says;
        this.stop(proc, behaviour.code ?? 1);
      });
    }
    return { pid: proc.pid, exited };
  }
  note = (_log: string, line: string) => {
    this.log += `${line}\n`;
  };
  size = () => this.log.length;
  since = (_log: string, from: number) => this.log.slice(from);
  healthy = async (url: string) => {
    const port = Number(new globalThis.URL(url).port);
    return [...this.procs.values()].some((proc) => proc.alive && proc.port === port && proc.servesAt <= this.clock);
  };
  sleep = async (ms: number) => {
    this.clock += ms;
    for (const each of this.due.filter((one) => one.at <= this.clock)) {
      this.due.splice(this.due.indexOf(each), 1);
      each.act();
    }
    await new Promise((done) => setImmediate(done));
  };
  now = () => this.clock;
}

const ENV = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME, CHIPS_URL: "https://chips.example", CHIPS_NO_KEYCHAIN: "1" };

function gateways(machine: Machine, over: { gateways?: GatewayAt[]; env?: NodeJS.ProcessEnv; root?: string } = {}) {
  const logs: string[] = [];
  const kept = new Gateways({
    gateways: over.gateways ?? [{ url: URL }],
    root: over.root ?? ROOT,
    env: over.env ?? ENV,
    system: machine,
    log: (line) => void logs.push(line),
    logFile: LOG,
  });
  return { kept, logs };
}

describe("a restart of a gateway run by hand", () => {
  it("stops this user's hermes gateway run, starts it again in its folder with its own words, and waits for it to answer", async () => {
    const machine = new Machine();
    machine.gateway({ command: `${RUN} --replace` });
    const { kept, logs } = gateways(machine);
    assert.equal(await kept.restart(), undefined);
    assert.deepEqual(machine.signals, [[52215, "SIGTERM"]]);
    assert.equal(machine.launches.length, 1);
    const [started] = machine.launches;
    assert.equal(started?.command, HERMES);
    assert.deepEqual(started?.args, ["gateway", "run", "--replace"]);
    assert.equal(started?.cwd, `${HOME}/work`);
    // The bridge's own environment goes with it, without what is Chips's.
    assert.equal(started?.env["PATH"], ENV.PATH);
    assert.equal(started?.env["CHIPS_URL"], undefined);
    assert.equal(started?.env["DYLD_LIBRARY_PATH"], undefined);
    assert.match(machine.log, /^--- .* chips-hermes started hermes gateway run --replace\n$/);
    assert.ok(logs.some((line) => /answers on port 8642\. It logs to .*chips-hermes-gateway\.log\./.test(line)), logs.join("\n"));
  });

  it("sends SIGKILL only once the gateway has had its time after SIGTERM", async () => {
    const machine = new Machine();
    machine.gateway({ stopsOn: "SIGKILL" });
    const begun = machine.clock;
    const { kept } = gateways(machine);
    assert.equal(await kept.restart(), undefined);
    assert.deepEqual(machine.signals, [
      [52215, "SIGTERM"],
      [52215, "SIGKILL"],
    ]);
    assert.ok(machine.clock - begun >= 15_000, "fifteen seconds after SIGTERM");
    assert.equal(machine.launches.length, 1);
  });

  it("says so, and starts nothing, when the gateway won't stop", async () => {
    const machine = new Machine();
    machine.gateway({ stopsOn: "never" });
    const { kept } = gateways(machine);
    assert.equal(await kept.restart(), "Hermes's gateway (pid 52215) didn't stop, so it wasn't started again.");
    assert.equal(machine.launches.length, 0);
  });

  it("leaves anything on the port that isn't this user's hermes gateway run alone", async () => {
    const machine = new Machine();
    machine.gateway({ command: "/usr/local/bin/node server.js --port 8642" });
    const { kept, logs } = gateways(machine);
    assert.equal(
      await kept.restart(),
      "Port 8642 is held by something other than hermes gateway run (pid 52215), so nothing was restarted.",
    );
    assert.ok(logs.some((line) => line.includes("node server.js")));

    const theirs = new Machine();
    theirs.gateway({ uid: 502 });
    const other = gateways(theirs);
    assert.match((await other.kept.restart()) ?? "", /something other than hermes gateway run \(pid 52215\)/);
    for (const each of [machine, theirs]) {
      assert.deepEqual(each.signals, []);
      assert.deepEqual(each.launches, []);
    }
  });

  it("starts one when nothing is there, and says when it can't tell what answers", async () => {
    const machine = new Machine();
    const { kept } = gateways(machine);
    assert.equal(await kept.restart(), undefined);
    assert.equal(machine.launches[0]?.cwd, HOME);
    assert.deepEqual(machine.launches[0]?.args, ["gateway", "run"]);

    // Something answers that no listener names (no lsof): nothing done.
    const blind = new Machine();
    blind.listener = async () => undefined;
    blind.gateway();
    assert.equal(await gateways(blind).kept.restart(), "Can't tell what answers on port 8642, so nothing was restarted.");
    assert.deepEqual(blind.signals, []);
    assert.deepEqual(blind.launches, []);
  });

  it("says when a restart never comes back: started but silent, or stopped as it started", async () => {
    const silent = new Machine();
    silent.gateway();
    silent.behaviours = [{ silent: true }];
    assert.equal(await gateways(silent).kept.restart(), "Hermes's gateway started, but nothing answers on port 8642.");
    assert.ok(silent.clock - 1_000_000 >= 90_000, "after a minute and a half");

    const dies = new Machine();
    dies.gateway();
    dies.behaviours = [{ dies: 3000, says: "Traceback …\nRuntimeError: API_SERVER_KEY is not set\n" }];
    assert.equal(await gateways(dies).kept.restart(), "Hermes's gateway stopped as it started: RuntimeError: API_SERVER_KEY is not set");

    const missing = new Machine();
    missing.gateway();
    assert.equal(
      await gateways(missing, { env: { PATH: "/usr/bin:/bin" } }).kept.restart(),
      "The hermes command isn't on this machine's PATH, so Hermes's gateway can't be started.",
    );
    assert.deepEqual(missing.signals, [], "nothing stopped that can't be started again");
  });

  it("can't restart a gateway on another machine", async () => {
    const machine = new Machine();
    const { kept } = gateways(machine, { gateways: [{ url: "http://hermes.lan:8642" }] });
    assert.equal(await kept.restart(), "Hermes's gateway at hermes.lan:8642 isn't on this machine, so it can't be restarted from here.");
    assert.deepEqual(machine.signals, []);
    assert.deepEqual(machine.launches, []);
  });
});

describe("a restart of Hermes's own service", () => {
  it("runs hermes gateway restart, signals nothing itself, and waits for a new gateway to answer", async () => {
    const machine = new Machine();
    machine.files.set(PLIST, "<plist/>");
    const old = machine.gateway();
    machine.onRun = (args) => {
      // Hermes's restart only asks: the old gateway goes a while later, and launchd starts another.
      machine.at(4000, () => {
        machine.stop(old, 0);
        machine.gateway({ pid: 52300, servesAt: machine.clock + 3000 });
      });
      return { code: 0, output: `✓ Service ${args[1]} requested` };
    };
    const begun = machine.clock;
    const { kept } = gateways(machine);
    assert.equal(await kept.restart(), undefined);
    assert.deepEqual(machine.runs, [{ command: HERMES, args: ["gateway", "restart"] }]);
    assert.deepEqual(machine.signals, []);
    assert.deepEqual(machine.launches, []);
    assert.ok(machine.clock - begun >= 7000, "not the old gateway's answer");
  });

  it("says what Hermes said when its restart fails, and when the service never answers", async () => {
    const failing = new Machine();
    failing.files.set(PLIST, "<plist/>");
    failing.gateway();
    failing.onRun = () => ({ code: 1, output: EXPAT_DEATH });
    assert.equal(
      await gateways(failing).kept.restart(),
      "hermes gateway restart failed: ImportError: dlopen(pyexpat.cpython-314-darwin.so, 0x0002): Symbol not found: _XML_SetAllocTrackerActivationThreshold",
    );
    assert.deepEqual(failing.launches, [], "no fallback for Hermes's own restart");

    const silent = new Machine();
    silent.files.set(PLIST, "<plist/>");
    const old = silent.gateway();
    silent.onRun = () => {
      silent.stop(old, 0);
      return { code: 0, output: "" };
    };
    assert.equal(await gateways(silent).kept.restart(), "Hermes's service restarted, but nothing answers on port 8642.");
  });

  it("is the Main agent's gateway only: another address is run by hand", async () => {
    const machine = new Machine();
    machine.files.set(PLIST, "<plist/>");
    machine.gateway({ pid: 60000, port: 8643, command: `${RUN.replace("gateway run", "-p alice gateway run")}` });
    const old = machine.gateway();
    machine.onRun = () => {
      machine.stop(old, 0);
      machine.gateway({ pid: 52300 });
      return { code: 0, output: "" };
    };
    machine.launchPort = 8643;
    const { kept } = gateways(machine, { gateways: [{ url: URL }, { url: "http://127.0.0.1:8643" }] });
    assert.equal(await kept.restart(), undefined);
    assert.equal(machine.runs.length, 1);
    assert.deepEqual(machine.signals, [[60000, "SIGTERM"]]);
    assert.deepEqual(machine.launches[0]?.args, ["-p", "alice", "gateway", "run"]);
  });
});

describe("the gateway started with the bridge", () => {
  it("starts hermes gateway run when nothing answers at a local address, in the home", async () => {
    const machine = new Machine();
    const { kept, logs } = gateways(machine);
    await kept.startIfDown();
    assert.equal(machine.launches.length, 1);
    assert.equal(machine.launches[0]?.cwd, HOME);
    assert.deepEqual(machine.launches[0]?.args, ["gateway", "run"]);
    assert.ok(logs[0]?.startsWith("Hermes isn't answering on port 8642: starting hermes gateway run"));
    assert.ok(await machine.healthy(URL));
  });

  it("starts nothing when Hermes answers, when the address isn't this machine's, or when something else holds the port", async () => {
    const up = new Machine();
    up.gateway();
    await gateways(up).kept.startIfDown();
    const away = new Machine();
    await gateways(away, { gateways: [{ url: "http://10.0.0.5:8642" }] }).kept.startIfDown();
    const held = new Machine();
    held.gateway({ servesAt: Number.POSITIVE_INFINITY });
    const { kept, logs } = gateways(held);
    await kept.startIfDown();
    assert.deepEqual(logs, ["Hermes isn't answering on port 8642, but pid 52215 listens there: no second gateway started"]);
    for (const each of [up, away, held]) {
      assert.deepEqual(each.launches, []);
      assert.deepEqual(each.signals, []);
      assert.deepEqual(each.runs, []);
    }
  });

  it("starts Hermes's service with hermes gateway start, not a second process", async () => {
    const machine = new Machine();
    machine.files.set(PLIST, "<plist/>");
    machine.onRun = () => {
      machine.gateway({ servesAt: machine.clock + 1000 });
      return { code: 0, output: "✓ Service started" };
    };
    await gateways(machine).kept.startIfDown();
    assert.deepEqual(machine.runs, [{ command: HERMES, args: ["gateway", "start"] }]);
    assert.deepEqual(machine.launches, []);
  });

  it("logs, and goes on, when the start fails", async () => {
    const machine = new Machine();
    machine.behaviours = [{ dies: 500, says: "ValueError: bad config\n" }];
    const { kept, logs } = gateways(machine);
    await kept.startIfDown();
    assert.equal(logs.at(-1), "Hermes's gateway stopped as it started: ValueError: bad config");
  });
});

describe("Homebrew's expat, for the one failure that needs it", () => {
  it("starts Hermes's entry point directly with DYLD_LIBRARY_PATH and the wrapper's variables when it died at once of macOS's expat", async () => {
    const machine = new Machine();
    machine.files.set(EXPAT, "");
    machine.behaviours = [{ dies: 1500, says: EXPAT_DEATH }, { serves: 4000 }];
    const { kept, logs } = gateways(machine, { env: { ...ENV, HERMES_HOME: `${HOME}/elsewhere` } });
    await kept.startIfDown();
    assert.equal(machine.launches.length, 2);
    const [plain, direct] = machine.launches;
    assert.equal(plain?.command, HERMES);
    assert.equal(direct?.command, ENTRY);
    assert.deepEqual(direct?.args, ["gateway", "run"]);
    assert.equal(direct?.env["DYLD_LIBRARY_PATH"], "/opt/homebrew/opt/expat/lib");
    assert.equal(direct?.env["HERMES_BIN"], `${CELLAR}/bin/hermes`);
    assert.equal(direct?.env["HERMES_REVISION"], "v0.22.0");
    assert.equal(direct?.env["HERMES_LAZY_INSTALL_TARGET"], `${HOME}/elsewhere/lazy-packages`);
    assert.equal(direct?.env["CHIPS_URL"], undefined);
    assert.equal(direct?.cwd, HOME);
    assert.deepEqual(
      logs.filter((line) => line.includes("expat")),
      [
        `hermes gateway run stopped at once: Homebrew's Python can't load macOS's expat (_XML_SetAllocTrackerActivationThreshold). Starting ${ENTRY} directly with DYLD_LIBRARY_PATH=/opt/homebrew/opt/expat/lib.`,
      ],
    );
    assert.ok(await machine.healthy(URL));
  });

  it("takes it on a restart too, with the gateway's own words and folder", async () => {
    const machine = new Machine();
    machine.files.set(EXPAT, "");
    machine.gateway();
    machine.behaviours = [{ dies: 1500, says: EXPAT_DEATH }, { serves: 4000 }];
    assert.equal(await gateways(machine).kept.restart(), undefined);
    assert.equal(machine.launches[1]?.command, ENTRY);
    assert.equal(machine.launches[1]?.cwd, `${HOME}/work`);
  });

  it("is not taken without Homebrew's expat, for another failure, or for a gateway that died later", async () => {
    const noExpat = new Machine();
    noExpat.behaviours = [{ dies: 1500, says: EXPAT_DEATH }];
    assert.equal(
      await gateways(noExpat).kept.restart(),
      "Hermes's gateway stopped as it started: ImportError: dlopen(pyexpat.cpython-314-darwin.so, 0x0002): Symbol not found: _XML_SetAllocTrackerActivationThreshold",
    );

    const other = new Machine();
    other.files.set(EXPAT, "");
    other.behaviours = [{ dies: 1500, says: "ImportError: No module named 'yaml'\n" }];
    assert.equal(await gateways(other).kept.restart(), "Hermes's gateway stopped as it started: ImportError: No module named 'yaml'");

    const later = new Machine();
    later.files.set(EXPAT, "");
    later.behaviours = [{ dies: 30_000, says: EXPAT_DEATH }];
    assert.match((await gateways(later).kept.restart()) ?? "", /^Hermes's gateway stopped as it started: ImportError/);

    const unwrapped = new Machine();
    unwrapped.files.set(EXPAT, "");
    unwrapped.files.set(HERMES, "#!/opt/homebrew/opt/python@3.14/bin/python3.14\nfrom hermes_cli.main import main\n");
    unwrapped.behaviours = [{ dies: 1500, says: EXPAT_DEATH }];
    assert.match((await gateways(unwrapped).kept.restart()) ?? "", /^Hermes's gateway stopped as it started: ImportError/);

    for (const each of [noExpat, other, later, unwrapped]) assert.equal(each.launches.length, 1);
  });
});

describe("a person's Restart", () => {
  it("holds the health watch, runs once while asked again, and says how it went", async () => {
    const holds: boolean[] = [];
    const said: (string | undefined)[] = [];
    let runs = 0;
    let release: (trouble: string | undefined) => void = () => undefined;
    const restart = restarter({
      restart: () => {
        runs += 1;
        return new Promise((done) => {
          release = done;
        });
      },
      hold: (held) => void holds.push(held),
      say: async (trouble) => void said.push(trouble),
      log: () => undefined,
    });
    const ask = { askedBy: "usr_arjun", askedAt: "2026-10-27T22:00:00.000Z" };
    const first = restart(ask);
    const second = restart(ask);
    await new Promise((done) => setImmediate(done));
    assert.equal(runs, 1);
    assert.equal(said.length, 0, "nothing said while it runs");
    release("Hermes's gateway started, but nothing answers on port 8642.");
    await Promise.all([first, second]);
    assert.deepEqual(holds, [true, false]);
    assert.deepEqual([...said], ["Hermes's gateway started, but nothing answers on port 8642."]);

    // Done, a new ask is a new restart; one that throws says so.
    const broken = restarter({
      restart: async () => {
        throw new Error("spawn lsof ENOENT");
      },
      hold: () => undefined,
      say: async (trouble) => void said.push(trouble),
      log: () => undefined,
    });
    await broken(ask);
    assert.equal(said.at(-1), "Restart failed: spawn lsof ENOENT");
  });
});

describe("what it reads", () => {
  it("knows hermes gateway run, with Hermes's own options, from anything else", () => {
    assert.deepEqual(gatewayRunArgs(RUN), ["gateway", "run"]);
    assert.deepEqual(gatewayRunArgs("/opt/homebrew/bin/hermes -p alice gateway run --replace"), ["-p", "alice", "gateway", "run", "--replace"]);
    assert.deepEqual(gatewayRunArgs("hermes --profile alice gateway run"), ["--profile", "alice", "gateway", "run"]);
    assert.equal(gatewayRunArgs("/opt/homebrew/bin/hermes gateway status"), undefined);
    assert.equal(gatewayRunArgs("hermes chat run gateway"), undefined);
    assert.equal(gatewayRunArgs("/usr/bin/python3 -m http.server 8642"), undefined);
    assert.equal(gatewayRunArgs("/opt/hermes-agent/bin/gateway run"), undefined);
  });

  it("reads Homebrew's wrapper: its entry point, and its variables as bash sets them", () => {
    const read = wrapperOf(WRAPPER, { HOME, HERMES_BIN: "/custom/hermes" });
    assert.equal(read?.entry, ENTRY);
    assert.deepEqual(read?.vars, {
      HERMES_BUNDLED_SKILLS: `${CELLAR}/share/hermes-agent/skills`,
      HERMES_BIN: "/custom/hermes",
      HERMES_PYTHON: `${CELLAR}/libexec/bin/python3`,
      HERMES_REVISION: "v0.22.0",
      HERMES_LAZY_INSTALL_TARGET: `${HOME}/.hermes/lazy-packages`,
    });
    assert.equal(wrapperOf("#!/usr/bin/env python3\nprint('hi')\n", {}), undefined);
    assert.equal(expand("${A:-x}|${A-y}|$B/${C}", { A: "", B: "b" }), "x||b/");
  });

  it("says why from the last error Python raised, with paths cut short only on a long line", () => {
    assert.equal(
      whyFrom(EXPAT_DEATH),
      "ImportError: dlopen(pyexpat.cpython-314-darwin.so, 0x0002): Symbol not found: _XML_SetAllocTrackerActivationThreshold",
    );
    assert.equal(whyFrom("starting\nno such file: /etc/hermes.yaml\n"), "no such file: /etc/hermes.yaml");
    assert.equal(whyFrom("", 3), "it exited 3");
    assert.equal(whyFrom("", null), "it was stopped");
  });

  it("finds Hermes's service as hermes gateway install names it", () => {
    const mac = { platform: "darwin" as const, home: HOME, exists: (path: string) => path.includes("LaunchAgents") };
    assert.equal(serviceOf(mac, ROOT)?.path, PLIST);
    assert.equal(serviceOf(mac, `${ROOT}/profiles/alice`)?.path, `${HOME}/Library/LaunchAgents/ai.hermes.gateway-alice.plist`);
    assert.match(serviceOf(mac, "/srv/hermes")?.path ?? "", /ai\.hermes\.gateway-[0-9a-f]{8}\.plist$/);
    assert.equal(serviceOf({ ...mac, exists: () => false }, ROOT), undefined);
    const linux = { platform: "linux" as const, home: "/home/someone", exists: (path: string) => path.startsWith("/home") };
    assert.deepEqual(serviceOf(linux, "/home/someone/.hermes"), {
      kind: "systemd",
      path: "/home/someone/.config/systemd/user/hermes-gateway.service",
    });
  });

  it("takes one gateway per address, the Main agent's first, and only this machine's as local", () => {
    const at = (url: string, profile?: string) => ({ address: { url, key: "k", ...(profile ? { profile } : {}) } });
    assert.deepEqual(gatewaysOf([at(`${URL}/`), at(URL, "alice"), at("http://127.0.0.1:8643")]), [
      { url: URL },
      { url: "http://127.0.0.1:8643" },
    ]);
    assert.ok(isLocal(URL) && isLocal("http://localhost:8642") && isLocal("http://[::1]:8642"));
    assert.ok(!isLocal("http://192.168.1.4:8642") && !isLocal("not a url"));
  });
});
