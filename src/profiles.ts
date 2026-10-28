/**
 * A Hermes profile for each agent a person makes in Chips (Chips ADR 0241), so it remembers only
 * its own conversations. As Hermes 0.22.0 does it (read 28 October 2026, and tried on a scratch home
 * and gateway the same day):
 *
 * - `hermes profile create <name> --clone-from <the Main agent's> --no-alias` makes it: the source's
 *   `config.yaml`, its `.env` without messaging channels, `SOUL.md`, skills, plugins and memory
 *   files, built beside `profiles/` and renamed into place (`hermes_cli/profiles.py`,
 *   `create_profile`). No shell alias: `hermes -p <name>` reaches it.
 * - Hermes counts its API server as a messaging channel, so the clone has no `API_SERVER_*` line;
 *   and a multiplexing gateway answers `/p/<profile>/…` only with that profile's own
 *   `API_SERVER_KEY`, read from its `.env` at each request (`_expected_api_key`). So the profile is
 *   given a key of its own.
 * - The clone's memory files are the Main agent's: they go, and its memory starts empty.
 * - The clone's `config.yaml` has Chips's webhook at the source's address
 *   (`/chips-hermes/<source>`), which is moved to its own.
 *
 * One gateway serves every profile under `/p/<profile>` once it multiplexes, which it decides as
 * it starts (`hermes_cli/gateway_multiplex_mode.py`): with only one profile it serves that one
 * alone ("only one profile exists"), and its rescans change nothing until it starts again. A
 * multiplexing gateway takes a new profile at once when asked over its control socket
 * (`rescan-profiles`, which `hermes profile create` sends too), and again after the bridge's
 * changes, else within its 30 s rescan.
 *
 * Hermes keeps a session to the profile it was made in: `POST /api/sessions/{id}/fork` copies one
 * within its profile, and `--clone-all` copies memory but no sessions. So a copy of an agent (Fork)
 * stays on its original's profile (`bridge.ts`).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { writeWhole } from "./context.js";
import { runHermes, type System, whyFrom } from "./gateway.js";
import { appendEnv, envValue } from "./home.js";
import { addHook, type HookOutcome, hookUrl } from "./hooks.js";

/** Where a profile's key for its API server is, in its `.env`. */
export const KEY_ENV = "API_SERVER_KEY";

/** The names `hermes profile create` refuses (`_RESERVED_NAMES`). */
const RESERVED: ReadonlySet<string> = new Set(["hermes", "default", "test", "tmp", "root", "sudo"]);

/** How long `hermes profile create` may take: it copies the source's skills. */
const CREATE_MS = 120_000;

/**
 * A profile name for an agent, as Hermes takes one (`^[a-z0-9][a-z0-9_-]{0,63}$`, and none it
 * keeps for itself): its name in lowercase letters and digits, `-` between words, then `-2` and on
 * when Hermes has a profile of that name, or the bridge has taken it.
 */
export function freeProfile(root: string, name: string, taken: readonly string[]): string {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 56)
      .replace(/^-+|-+$/g, "") || "agent";
  for (let count = 1; ; count += 1) {
    if (count === 1 && RESERVED.has(slug)) continue;
    const profile = count === 1 ? slug : `${slug}-${count}`;
    if (!taken.includes(profile) && !existsSync(join(root, "profiles", profile))) return profile;
  }
}

/**
 * A profile Hermes just cloned for an agent, made its own: its memory files gone, a key of its own
 * for its API server, and Chips's webhook at its own address when the bridge listens for it. What
 * became of the webhook, for the log; nothing when there is none to add.
 */
export function readyProfile(
  home: string,
  names: { readonly from: string; readonly profile: string },
  hook?: { readonly port: number; readonly secret: string } | undefined,
): HookOutcome | undefined {
  for (const file of ["MEMORY.md", "USER.md"]) rmSync(join(home, "memories", file), { force: true });
  if (envValue(home, KEY_ENV) === undefined) appendEnv(home, KEY_ENV, randomBytes(32).toString("hex"));
  if (hook === undefined) return undefined;
  const path = join(home, "config.yaml");
  if (existsSync(path)) {
    const theirs = hookUrl(hook.port, names.from).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const entry = new RegExp(`^(\\s*(?:-\\s*)?url:\\s*["']?)${theirs}(["']?\\s*(?:#.*)?)$`, "m");
    const text = readFileSync(path, "utf8");
    if (entry.test(text)) writeWhole(path, text.replace(entry, `$1${hookUrl(hook.port, names.profile)}$2`));
  }
  return addHook(home, hook.port, names.profile, hook.secret);
}

/** What makes the profiles and has them served: Hermes itself, unless a test hands in its own. */
export interface ProfileMaker {
  /** A profile `name` cloned from `from`, as `hermes profile create` makes one; refused in Hermes's words. */
  create(name: string, from: string): Promise<void>;
  /**
   * Hermes's gateway asked to serve the profiles there are now: true when it serves each under
   * `/p/<profile>`, false when it serves only the one it started with, nothing when no gateway
   * answered.
   */
  serve(): Promise<boolean | undefined>;
}

/** Hermes's own CLI and gateway, on this machine. */
export function hermesProfiles(options: {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly system: Pick<System, "which" | "read" | "exists" | "run">;
  readonly log: (line: string) => void;
}): ProfileMaker {
  return {
    async create(name, from) {
      const args = ["profile", "create", name, "--clone-from", from, "--no-alias"];
      const ran = await runHermes(options.system, options.env, args, CREATE_MS, options.log);
      // Hermes says why as `Error: …`: the reason alone.
      if (ran.code !== 0) throw new Error(whyFrom(ran.output, ran.code).replace(/^Error:\s*/, ""));
    },
    async serve() {
      const result = await askGateway(options.root, "rescan-profiles");
      return typeof result?.["multiplex"] === "boolean" ? result["multiplex"] : undefined;
    },
  };
}

/**
 * Where Hermes's gateway hears its control verbs (`gateway/control_socket.py`): `gateway.sock` in
 * its home, or where `gateway.sock.path` points when that path is too long for a socket.
 */
export function controlSocketOf(root: string): string | undefined {
  const direct = join(root, "gateway.sock");
  if (existsSync(direct)) return direct;
  try {
    const pointed = readFileSync(join(root, "gateway.sock.path"), "utf8").trim();
    return pointed !== "" && existsSync(pointed) ? pointed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One control verb, as Hermes's own `query_gateway_control` asks it: one JSON line out, one back,
 * then the gateway closes. Its `result`, or nothing for no answer, a refusal or a timeout.
 */
export function askGateway(root: string, verb: string, timeoutMs = 8000): Promise<Record<string, unknown> | undefined> {
  const path = controlSocketOf(root);
  if (path === undefined) return Promise.resolve(undefined);
  return new Promise((done) => {
    let heard = "";
    let over = false;
    const socket = createConnection(path);
    const finish = (line: string | undefined) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      socket.destroy();
      done(line === undefined ? undefined : resultOf(line));
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb, id: 1, protocol: 1 })}\n`));
    socket.on("data", (chunk) => {
      heard += String(chunk);
      const end = heard.indexOf("\n");
      if (end >= 0) finish(heard.slice(0, end));
    });
    socket.on("end", () => finish(heard));
    socket.on("error", () => finish(undefined));
  });
}

function resultOf(line: string): Record<string, unknown> | undefined {
  try {
    const answer = JSON.parse(line) as { ok?: unknown; result?: unknown };
    return answer.ok === true && typeof answer.result === "object" && answer.result !== null
      ? (answer.result as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
