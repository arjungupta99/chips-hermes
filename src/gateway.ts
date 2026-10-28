/**
 * Hermes's gateway, restarted from Chips (Chips ADR 0094) and started with the bridge. The gateway
 * is the process serving Hermes's API server at the agents' address, `hermes gateway run`.
 *
 * A person presses Restart on Hermes's page in Chips, Chips sends `restart` down this bridge's
 * socket, which stays up while Hermes doesn't, and the bridge restarts each gateway its agents use
 * on this machine, the way it is kept:
 * - The Main agent's, installed as Hermes's own service (a launchd agent on a Mac, a systemd unit on
 *   Linux, which is how `hermes gateway status` tells one from a gateway run by hand: the file is
 *   there), Hermes's own `hermes gateway restart`.
 * - Run by hand, the process listening on the API's port, only when it is a `hermes gateway run`
 *   of this user's: stopped (SIGTERM, and SIGKILL only when it is still there after a while), then
 *   started again in the folder it worked in, on its own (its own session, no terminal), its output
 *   added to a log. Anything else on the port is left alone.
 * Then it waits for the API server to answer, and says fine, or what went wrong in a line.
 *
 * When the bridge starts and nothing answers at a local address, it starts the gateway the same
 * way (`hermes gateway start` for a service), so the bridge, kept running from login, brings
 * Hermes back after a reboot too.
 *
 * One fallback, for one failure (27 October 2026): Homebrew's python@3.14 3.14.8_2 links its
 * `pyexpat` to macOS 26.2's /usr/lib/libexpat, which lacks `XML_SetAllocTrackerActivationThreshold`,
 * so Hermes dies on `import plistlib` as it starts. Homebrew's own expat works, through
 * `DYLD_LIBRARY_PATH`, which macOS drops at a protected program such as /bin/bash, the `hermes`
 * wrapper. So when the gateway dies in its first seconds saying that symbol, and Homebrew's expat
 * is there, the wrapper's entry point is started directly, with the variables the wrapper sets and
 * `DYLD_LIBRARY_PATH`.
 *
 * Everything done to a process goes through `System`, handed in, so a test starts and signals
 * nothing real.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, closeSync, constants, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import type { AgentConfig } from "./bridge.js";
import { HermesClient } from "./hermes.js";
import { processFolder } from "./home.js";

/** A gateway the agents use: where its API server answers. */
export interface GatewayAt {
  readonly url: string;
}

/** What `System.describe` reads of a process. */
export interface ProcessInfo {
  readonly uid: number;
  readonly command: string;
  readonly cwd?: string | undefined;
}

/** A program started on its own, and when it ends. */
export interface Launched {
  readonly pid: number | undefined;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>;
}

/** Everything the gateway's restart does outside the bridge: the machine's own, or a test's. */
export interface System {
  readonly platform: NodeJS.Platform;
  /** The user the bridge runs as. */
  readonly uid: number;
  readonly home: string;
  exists(path: string): boolean;
  /** A text file, or nothing. */
  read(path: string): string | undefined;
  /** A command on the `PATH` of `env`, as a whole path. */
  which(command: string, env: NodeJS.ProcessEnv): string | undefined;
  /** The process listening on a TCP port here, or nothing. */
  listener(port: number): Promise<number | undefined>;
  /** A process's owner, command line and working folder; nothing once it is gone. */
  describe(pid: number): Promise<ProcessInfo | undefined>;
  alive(pid: number): boolean;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
  /** A command run to its end, for at most `timeoutMs`: its exit code, and the last of its output. */
  run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; output: string }>;
  /** A program started on its own session, stdin `/dev/null`, its output appended to `log`. */
  launch(spec: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly log: string;
  }): Launched;
  /** A line added to the log. */
  note(log: string, line: string): void;
  /** How long the log is now. */
  size(log: string): number;
  /** What was added to the log since `from`. */
  since(log: string, from: number): string;
  /** Whether a gateway answers: `GET /health`, as the setup check asks. */
  healthy(url: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** How long each part may take. */
export interface Timing {
  /** After SIGTERM, before SIGKILL. */
  readonly stopMs: number;
  /** After SIGKILL, before giving up. */
  readonly killMs: number;
  /** A gateway that ends this soon after it starts died "at once". */
  readonly earlyMs: number;
  /** For a gateway started to answer. */
  readonly upMs: number;
  /** For Hermes's own `hermes gateway restart|start`, and a service's gateway to answer after it. */
  readonly serviceMs: number;
  readonly pollMs: number;
}

export const TIMING: Timing = {
  stopMs: 15_000,
  killMs: 5_000,
  earlyMs: 10_000,
  upMs: 90_000,
  serviceMs: 150_000,
  pollMs: 500,
};

/** Homebrew's own expat, which Homebrew's python@3.14 needs where macOS's is too old. */
export const EXPAT = "/opt/homebrew/opt/expat/lib/libexpat.1.dylib";
/** What Python says when it loads macOS's older expat. */
const EXPAT_SYMBOL = "_XML_SetAllocTrackerActivationThreshold";

/**
 * The gateways the agents use, one per address, the Main agent's first. A profile other than the
 * default is reached under `/p/<profile>` of its gateway, so each is a gateway of the root's.
 */
export function gatewaysOf(agents: readonly Pick<AgentConfig, "address">[]): GatewayAt[] {
  return [...new Set(agents.map(({ address }) => address.url.replace(/\/+$/, "")))].map((url) => ({ url }));
}

/** Whether an address is this machine's. */
export function isLocal(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function portOf(url: string): number {
  const parsed = new URL(url);
  return Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
}

/** One line, as Chips takes it: up to 200 characters. */
export function line(words: string): string {
  const one = words.replace(/\s+/g, " ").trim();
  return one.length <= 200 ? one : `${one.slice(0, 199)}…`;
}

/**
 * Why a program stopped, from what it said: the last error Python raised, else its last line,
 * with whole paths cut to their file names when the line is long.
 */
export function whyFrom(output: string, code?: number | null): string {
  const lines = output
    .split("\n")
    .map((each) => each.trim())
    .filter((each) => each !== "");
  const why = lines.findLast((each) => /^[A-Za-z_][\w.]*(Error|Exception)\b/.test(each)) ?? lines.at(-1);
  if (why === undefined) return code === null || code === undefined ? "it was stopped" : `it exited ${code}`;
  return why.length <= 200 ? why : why.replace(/\/(?:[^\s/(),:'"]+\/)+([^\s/(),:'"]+)/g, "$1");
}

/**
 * What a command line asks `hermes` for, when it is `hermes gateway run`: the words after `hermes`
 * (`gateway run`, `-p alice gateway run`), to start it again with. Nothing for anything else.
 */
export function gatewayRunArgs(command: string): string[] | undefined {
  const words = command.trim().split(/\s+/);
  const at = words.findIndex((word) => basename(word) === "hermes");
  if (at === -1) return undefined;
  const args = words.slice(at + 1);
  const plain: string[] = [];
  for (let next = 0; next < args.length; next += 1) {
    const word = args[next] ?? "";
    if (word === "-p" || word === "--profile") next += 1;
    else if (!word.startsWith("-")) plain.push(word);
  }
  return plain[0] === "gateway" && plain[1] === "run" ? args : undefined;
}

/**
 * The service file Hermes installs for the gateway of its root (`$HERMES_HOME`, else `~/.hermes`),
 * as `hermes gateway install` names it: when it is there, `hermes gateway status` reports the
 * service, else a gateway run by hand (Hermes 0.22.0's `_installed_service_kind`).
 */
export function serviceOf(
  system: Pick<System, "platform" | "home" | "exists">,
  root: string,
  env: NodeJS.ProcessEnv = {},
): { readonly kind: "launchd" | "systemd"; readonly path: string; readonly system?: boolean } | undefined {
  const home = resolve(root);
  const native = resolve(system.home, ".hermes");
  // `""` for ~/.hermes, a profile's name for ~/.hermes/profiles/<name>, else a hash of the home.
  const suffix =
    home === native
      ? ""
      : dirname(home) === join(native, "profiles")
        ? basename(home)
        : createHash("sha256").update(home).digest("hex").slice(0, 8);
  if (system.platform === "darwin") {
    const path = join(system.home, "Library", "LaunchAgents", `ai.hermes.gateway${suffix ? `-${suffix}` : ""}.plist`);
    return system.exists(path) ? { kind: "launchd", path } : undefined;
  }
  if (system.platform === "linux") {
    const unit = `hermes-gateway${suffix ? `-${suffix}` : ""}.service`;
    const user = join(env["XDG_CONFIG_HOME"] || join(system.home, ".config"), "systemd", "user", unit);
    if (system.exists(user)) return { kind: "systemd", path: user };
    const machine = join("/etc/systemd/system", unit);
    if (system.exists(machine)) return { kind: "systemd", path: machine, system: true };
  }
  return undefined;
}

/**
 * A shell word as bash expands it inside double quotes, for the wrapper's values: `$NAME`,
 * `${NAME}`, `${NAME:-word}` and `${NAME-word}`, nested.
 */
export function expand(text: string, env: NodeJS.ProcessEnv): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    if (char === "\\" && at + 1 < text.length) {
      out += text[at + 1];
      at += 2;
    } else if (char !== "$") {
      out += char;
      at += 1;
    } else if (text[at + 1] === "{") {
      let depth = 1;
      let end = at + 2;
      for (; end < text.length; end += 1) {
        if (text[end] === "{") depth += 1;
        else if (text[end] === "}" && --depth === 0) break;
      }
      const inner = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([\s\S]*))?$/.exec(text.slice(at + 2, end));
      if (inner !== null) {
        const value = env[inner[1] ?? ""];
        const unset = inner[2] === ":" ? value === undefined || value === "" : value === undefined;
        out += inner[3] !== undefined && unset ? expand(inner[3], env) : (value ?? "");
      }
      at = end + 1;
    } else {
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at + 1))?.[0];
      out += name === undefined ? "$" : (env[name] ?? "");
      at += 1 + (name?.length ?? 0);
    }
  }
  return out;
}

/**
 * Homebrew's `hermes` wrapper, read: the line `VAR="value" … exec "<entry>" "$@"`, as the entry it
 * runs and the variables it sets, expanded against `env`. Nothing for a file that isn't one.
 */
export function wrapperOf(text: string, env: NodeJS.ProcessEnv): { readonly entry: string; readonly vars: Record<string, string> } | undefined {
  for (const each of text.split("\n")) {
    const found = /^\s*((?:[A-Za-z_][A-Za-z0-9_]*="(?:[^"\\]|\\.)*"\s+)*)exec\s+"([^"]+)"/.exec(each);
    if (found === null) continue;
    const vars: Record<string, string> = {};
    for (const set of (found[1] ?? "").matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      vars[set[1] ?? ""] = expand(set[2] ?? "", env);
    }
    return { entry: expand(found[2] ?? "", env), vars };
  }
  return undefined;
}

const NO_HERMES = "The hermes command isn't on this machine's PATH, so Hermes's gateway can't be started.";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The gateway's environment: the bridge's, without what is Chips's. */
function gatewayEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("CHIPS_")));
}

export interface GatewayOptions {
  readonly gateways: readonly GatewayAt[];
  /** Hermes's root, `$HERMES_HOME` else `~/.hermes`. */
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly system: System;
  readonly log: (line: string) => void;
  /** Where a gateway the bridge starts writes what it says. */
  readonly logFile: string;
}

/** How a gateway started went: it answers, it ended (soon or not), or it runs and doesn't answer. */
type Outcome =
  | { readonly state: "up"; readonly pid: number | undefined }
  | { readonly state: "ended"; readonly early: boolean; readonly output: string; readonly code: number | null }
  | { readonly state: "silent" };

export class Gateways {
  private readonly timing: Timing = TIMING;

  constructor(private readonly options: GatewayOptions) {}

  /** Each gateway restarted, one after another: what went wrong, in a line, or nothing. */
  async restart(): Promise<string | undefined> {
    const troubles: string[] = [];
    for (const gateway of this.options.gateways) {
      let trouble: string | undefined;
      try {
        trouble = await this.restartOne(gateway);
      } catch (error) {
        trouble = `Restart failed: ${messageOf(error)}`;
      }
      if (trouble !== undefined) troubles.push(trouble);
    }
    return troubles.length === 0 ? undefined : line(troubles.join(" "));
  }

  /** Each local gateway that doesn't answer, started: the bridge is starting. */
  async startIfDown(): Promise<void> {
    const { system, log } = this.options;
    for (const gateway of this.options.gateways) {
      if (!isLocal(gateway.url)) continue;
      const port = portOf(gateway.url);
      try {
        if (await system.healthy(gateway.url)) continue;
        let trouble: string | undefined;
        if (this.serviceFor(gateway) !== undefined) {
          log(`Hermes isn't answering on port ${port}: starting its service, hermes gateway start`);
          trouble = await this.byService(gateway, "start", undefined);
        } else {
          const pid = await system.listener(port);
          if (pid !== undefined) {
            log(`Hermes isn't answering on port ${port}, but pid ${pid} listens there: no second gateway started`);
            continue;
          }
          log(`Hermes isn't answering on port ${port}: starting hermes gateway run`);
          trouble = await this.start(gateway, ["gateway", "run"], undefined);
        }
        if (trouble !== undefined) log(trouble);
      } catch (error) {
        log(`Hermes's gateway on port ${port} couldn't be started: ${messageOf(error)}`);
      }
    }
  }

  /**
   * The service of Hermes's root, for the Main agent's gateway: a gateway at another address is
   * another profile's own, which `hermes gateway status` of the root doesn't speak for.
   */
  private serviceFor(gateway: GatewayAt) {
    if (gateway !== this.options.gateways[0]) return undefined;
    return serviceOf(this.options.system, this.options.root, this.options.env);
  }

  private async restartOne(gateway: GatewayAt): Promise<string | undefined> {
    const { system, log } = this.options;
    if (!isLocal(gateway.url)) {
      return `Hermes's gateway at ${new URL(gateway.url).host} isn't on this machine, so it can't be restarted from here.`;
    }
    const port = portOf(gateway.url);
    const pid = await system.listener(port);
    if (this.serviceFor(gateway) !== undefined) {
      log("restarting Hermes's service: hermes gateway restart");
      return this.byService(gateway, "restart", pid);
    }
    if (pid === undefined) {
      if (await system.healthy(gateway.url)) return `Can't tell what answers on port ${port}, so nothing was restarted.`;
      log(`nothing listens on port ${port}: starting hermes gateway run`);
      return this.start(gateway, ["gateway", "run"], undefined);
    }
    const info = await system.describe(pid);
    // Gone already: started again as it is started from nothing.
    if (info === undefined) return this.start(gateway, ["gateway", "run"], undefined);
    const args = this.ours(info);
    if (args === undefined) {
      log(`pid ${pid} on port ${port} isn't this user's hermes gateway run, so it was left alone: ${info.command.slice(0, 160)}`);
      return `Port ${port} is held by something other than hermes gateway run (pid ${pid}), so nothing was restarted.`;
    }
    // Nothing is stopped that can't be started again.
    if (system.which("hermes", this.options.env) === undefined) return NO_HERMES;
    log(`stopping Hermes's gateway, pid ${pid}`);
    if (!(await this.stop(pid))) return `Hermes's gateway (pid ${pid}) didn't stop, so it wasn't started again.`;
    return this.start(gateway, args, info.cwd);
  }

  /** A `hermes gateway run` of this user's: the words to start it again with. */
  private ours(info: ProcessInfo): string[] | undefined {
    return info.uid === this.options.system.uid ? gatewayRunArgs(info.command) : undefined;
  }

  /** SIGTERM, then SIGKILL once it has had a while, and only while it is still that gateway. */
  private async stop(pid: number): Promise<boolean> {
    const { system, log } = this.options;
    system.signal(pid, "SIGTERM");
    if (await this.gone(pid, this.timing.stopMs)) return true;
    const still = await system.describe(pid);
    if (still === undefined) return true;
    if (this.ours(still) === undefined) return false;
    log(`Hermes's gateway, pid ${pid}, is still running ${this.timing.stopMs / 1000} s after SIGTERM: SIGKILL`);
    system.signal(pid, "SIGKILL");
    return this.gone(pid, this.timing.killMs);
  }

  private async gone(pid: number, withinMs: number): Promise<boolean> {
    const { system } = this.options;
    const by = system.now() + withinMs;
    while (system.alive(pid)) {
      if (system.now() >= by) return false;
      await system.sleep(this.timing.pollMs);
    }
    return true;
  }

  /** Hermes's own `hermes gateway restart|start`, then the gateway answering, from a new process. */
  private async byService(gateway: GatewayAt, verb: "restart" | "start", before: number | undefined): Promise<string | undefined> {
    const { system, env } = this.options;
    const hermes = system.which("hermes", env);
    if (hermes === undefined) return NO_HERMES;
    const scope = this.serviceFor(gateway)?.system === true ? ["--system"] : [];
    const ran = await system.run(hermes, ["gateway", verb, ...scope], gatewayEnv(env), this.timing.serviceMs);
    if (ran.code !== 0) return line(`hermes gateway ${verb} failed: ${whyFrom(ran.output, ran.code)}`);
    // Hermes's restart only asks: the old gateway finishes what it is doing first, then goes.
    const by = system.now() + this.timing.serviceMs;
    for (;;) {
      const old = before !== undefined && system.alive(before);
      if (!old && (await system.healthy(gateway.url))) return undefined;
      if (system.now() >= by) {
        if (await system.healthy(gateway.url)) return undefined;
        return `Hermes's service ${verb === "start" ? "started" : "restarted"}, but nothing answers on port ${portOf(gateway.url)}.`;
      }
      await system.sleep(this.timing.pollMs);
    }
  }

  /**
   * `hermes <args>` (`gateway run`), on its own, in `cwd` (else the home), then through Homebrew's
   * expat when it died of macOS's.
   */
  private async start(gateway: GatewayAt, args: readonly string[], cwd: string | undefined): Promise<string | undefined> {
    const { system, env, log } = this.options;
    const port = portOf(gateway.url);
    const hermes = system.which("hermes", env);
    if (hermes === undefined) return NO_HERMES;
    const folder = cwd ?? system.home;
    const plain = gatewayEnv(env);
    let outcome = await this.launch(gateway, hermes, args, plain, folder, `hermes ${args.join(" ")}`);
    if (outcome.state === "ended" && outcome.early && outcome.output.includes(EXPAT_SYMBOL) && system.exists(EXPAT)) {
      const wrapper = wrapperOf(system.read(hermes) ?? "", plain);
      if (wrapper !== undefined) {
        const expat = dirname(EXPAT);
        log(
          `hermes gateway run stopped at once: Homebrew's Python can't load macOS's expat (${EXPAT_SYMBOL}). Starting ${wrapper.entry} directly with DYLD_LIBRARY_PATH=${expat}.`,
        );
        const libraries = [expat, plain["DYLD_LIBRARY_PATH"]].filter((each) => each !== undefined && each !== "").join(":");
        outcome = await this.launch(
          gateway,
          wrapper.entry,
          args,
          { ...plain, ...wrapper.vars, DYLD_LIBRARY_PATH: libraries },
          folder,
          `${wrapper.entry} ${args.join(" ")} with DYLD_LIBRARY_PATH=${expat}`,
        );
      }
    }
    if (outcome.state === "up") {
      log(`Hermes's gateway${outcome.pid === undefined ? "" : `, pid ${outcome.pid},`} answers on port ${port}. It logs to ${this.options.logFile}.`);
      return undefined;
    }
    if (outcome.state === "silent") return `Hermes's gateway started, but nothing answers on port ${port}.`;
    return line(`Hermes's gateway stopped as it started: ${whyFrom(outcome.output, outcome.code)}`);
  }

  /** A program started, and watched until it answers, ends, or has had its time. */
  private async launch(
    gateway: GatewayAt,
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    what: string,
  ): Promise<Outcome> {
    const { system, logFile } = this.options;
    system.note(logFile, `--- ${new Date(system.now()).toISOString()} chips-hermes started ${what}`);
    const from = system.size(logFile);
    const startedAt = system.now();
    const child = system.launch({ command, args, env, cwd, log: logFile });
    let ended: { readonly code: number | null; readonly at: number } | undefined;
    void child.exited.then(({ code }) => {
      ended = { code, at: system.now() };
    });
    for (;;) {
      // A turn first, so an end already known is heard before anything else.
      await Promise.resolve();
      if (ended !== undefined) {
        return { state: "ended", early: ended.at - startedAt <= this.timing.earlyMs, output: system.since(logFile, from), code: ended.code };
      }
      if (await system.healthy(gateway.url)) return { state: "up", pid: child.pid };
      if (system.now() - startedAt >= this.timing.upMs) return { state: "silent" };
      await system.sleep(this.timing.pollMs);
    }
  }
}

// ------------------------------------------------------------------ a person's Restart

export interface RestartAsk {
  readonly askedBy: string;
  readonly askedAt: string;
}

export interface RestarterDeps {
  /** The restart: what went wrong, in a line, or nothing. */
  readonly restart: () => Promise<string | undefined>;
  /** Hold the health watch's words while it runs, and let them go after. */
  readonly hold: (held: boolean) => void;
  /** Tell Chips how it went: fine, or the line. */
  readonly say: (trouble: string | undefined) => Promise<void>;
  readonly log: (line: string) => void;
}

/**
 * What runs when a person asks for a restart (ADR 0094): nothing said until it is over, then how
 * it went. Asked again while one runs, it is the same restart.
 */
export function restarter(deps: RestarterDeps): (ask: RestartAsk) => Promise<void> {
  let running: Promise<void> | undefined;
  return (ask) => {
    if (running !== undefined) {
      deps.log(`restart asked by ${ask.askedBy} while one runs: it is the same restart`);
      return running;
    }
    running = (async () => {
      deps.log(`restart asked by ${ask.askedBy}: restarting Hermes's gateway`);
      deps.hold(true);
      let trouble: string | undefined;
      try {
        trouble = await deps.restart();
      } catch (error) {
        trouble = line(`Restart failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      deps.log(trouble === undefined ? "restarted, and Hermes answers" : `restart: ${trouble}`);
      try {
        await deps.say(trouble);
      } catch (error) {
        deps.log(`could not tell Chips how the restart went: ${String(error)}`);
      } finally {
        deps.hold(false);
      }
    })().finally(() => {
      running = undefined;
    });
    return running;
  };
}

// ------------------------------------------------------------------ this machine

/** Where a gateway the bridge starts logs: `~/Library/Logs` on a Mac, else beside the bridge's config. */
export function gatewayLog(configFolder: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin"
    ? join(homedir(), "Library", "Logs", "chips-hermes-gateway.log")
    : join(configFolder, "gateway.log");
}

/** A program run to its end, its output kept. */
function runToEnd(command: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number }) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn(command, args, { env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (data: Buffer) => {
      output = (output + String(data)).slice(-8000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const limit = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.on("error", (error) => {
      clearTimeout(limit);
      done({ code: null, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(limit);
      done({ code, output });
    });
  });
}

/** This machine, for the bridge itself. */
export function thisMachine(): System {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? -1,
    home: homedir(),
    exists: existsSync,
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    which(command, env) {
      for (const folder of (env["PATH"] ?? "").split(delimiter)) {
        if (folder === "") continue;
        const path = join(folder, command);
        try {
          accessSync(path, constants.X_OK);
          return path;
        } catch {}
      }
      return undefined;
    },
    async listener(port) {
      const { output } = await runToEnd("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], { timeoutMs: 5000 });
      const pid = Number(/^p(\d+)$/m.exec(output)?.[1]);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    },
    async describe(pid) {
      const { code, output } = await runToEnd("ps", ["-ww", "-o", "uid=", "-o", "command=", "-p", String(pid)], { timeoutMs: 5000 });
      const found = /^\s*(\d+)\s+(.*)$/m.exec(output);
      if (code !== 0 || found === null) return undefined;
      return { uid: Number(found[1]), command: found[2] ?? "", cwd: processFolder(pid) };
    },
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    signal(pid, signal) {
      try {
        process.kill(pid, signal);
      } catch {}
    },
    run: (command, args, env, timeoutMs) => runToEnd(command, args, { env, timeoutMs }),
    launch({ command, args, env, cwd, log }) {
      const out = openSync(log, "a");
      try {
        const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", out, out] });
        const exited = new Promise<{ code: number | null; signal: string | null }>((done) => {
          child.once("exit", (code, signal) => done({ code, signal }));
          child.once("error", (error) => {
            appendFileSync(log, `${error.message}\n`);
            done({ code: null, signal: null });
          });
        });
        child.unref();
        return { pid: child.pid, exited };
      } finally {
        closeSync(out);
      }
    },
    note(log, words) {
      appendFileSync(log, `${words}\n`);
    },
    size(log) {
      try {
        return statSync(log).size;
      } catch {
        return 0;
      }
    },
    since(log, from) {
      try {
        const to = statSync(log).size;
        const start = Math.max(from, to - 64_000);
        const buffer = Buffer.alloc(Math.max(0, to - start));
        const fd = openSync(log, "r");
        try {
          readSync(fd, buffer, 0, buffer.length, start);
        } finally {
          closeSync(fd);
        }
        return buffer.toString("utf8");
      } catch {
        return "";
      }
    },
    healthy: (url) =>
      new HermesClient({ url, key: "" }, (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) })).healthy(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
  };
}
