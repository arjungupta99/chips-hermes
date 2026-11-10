/**
 * What the bridge checks before it takes up a link, which works once (Chips ADR 0122): the config
 * it reads, each agent's key filled in rather than the `…` the gallery's command was copied with,
 * and Hermes answering at each agent's address and taking its key. Anything missing stops it with
 * what to do, and the link is still good for the same command run again.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { filledIn, type StopWords } from "@chipschat/harness";
import type { AgentConfig } from "./bridge.js";
import { HermesClient } from "./hermes.js";
import { profileHome, profileName } from "./home.js";
import { addHook, type HookOutcome } from "./hooks.js";
import { folderPathOf, placesOf } from "./places.js";

export interface Config {
  readonly name?: string;
  readonly agents: readonly AgentConfig[];
  /** Where each agent gets a folder of its own, unless the config names one `folder` for them all. */
  readonly folders: string;
  /** The port Hermes's webhook reaches the bridge on, when the config fixes one. */
  readonly hookPort?: number;
}

/**
 * Something to put right before the bridge starts, said so a person can: the message in a terminal,
 * `words` on Chips for Mac's sheet (Chips ADR 0218, phase 5).
 */
export class SetupError extends Error {
  override readonly name = "SetupError";
  constructor(
    message: string,
    readonly words: StopWords = {},
  ) {
    super(message);
  }
}

/** A path under the home as a person writes it: `~/.hermes/.env`. */
const shown = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/** The port in an address, as a person reads it. */
const portOf = (url: string) => {
  const parsed = new URL(url);
  return parsed.port || (parsed.protocol === "https:" ? "443" : "80");
};

/** What the check found, under its step on the sheet, and the one restart Chips's webhook needs. */
export function checkedWords(config: Config, restart = false): string {
  const urls = new Set(config.agents.map((agent) => agent.address.url));
  const [url] = urls;
  const found =
    urls.size === 1 && url !== undefined
      ? `Its API server answers on port ${portOf(url)}`
      : `Its API server answers for each of ${config.agents.length} agents`;
  return restart ? `${found}. ${RESTART}` : found;
}

/** What a webhook added while Hermes's gateway runs needs: it reads its hooks when it starts. */
export const RESTART = "Start hermes gateway again once, so it tells Chips how full each agent's context is.";

/**
 * Chips's webhook in the config of each profile the agents run on (`hooks.ts`), those made for
 * agents in Chips among them (`made`, Chips ADR 0241), so Hermes says how full each agent's
 * context is, and what a person has to do for it, in lines for the log: a restart of
 * `hermes gateway` once when one was added while it runs, or lines to add by hand to a config the
 * bridge won't change. Nothing stops for it: the bridge works without it.
 */
export function readyHooks(
  config: Config,
  options: {
    readonly root: string;
    readonly port: number;
    readonly secret: string;
    readonly gatewayUp: boolean;
    readonly made?: readonly string[] | undefined;
  },
): { readonly lines: string[]; readonly restart: boolean } {
  const lines: string[] = [];
  let restart = false;
  const done = new Set<string>();
  for (const named of [...config.agents.map((agent) => agent.address.profile), ...(options.made ?? [])]) {
    const profile = profileName(named);
    if (done.has(profile)) continue;
    done.add(profile);
    const home = profileHome(options.root, named);
    let outcome: HookOutcome;
    try {
      outcome = addHook(home, options.port, profile, options.secret);
    } catch (error) {
      lines.push(`Chips's webhook wasn't added to ${shown(join(home, "config.yaml"))}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (outcome.state === "added") {
      lines.push(`Added Chips's webhook to ${shown(outcome.path)}, so Hermes tells Chips how full each agent's context is.`);
      restart ||= options.gatewayUp;
    } else if (outcome.state === "by_hand") {
      lines.push(
        `${shown(outcome.path)} was left as it is: ${outcome.why}. For Chips to show how full each agent's context is, add these lines to it, then start hermes gateway again:\n${outcome.lines}`,
      );
    } else if (outcome.state === "no_home") {
      lines.push(`Hermes has no ${profile} profile at ${shown(home)}, so no webhook was added for it.`);
    }
  }
  if (restart) lines.push(RESTART);
  return { lines, restart };
}

export const STILL_GOOD = "The link is still good: run the same command again once that's done.";

const EXAMPLE = '{ "agents": [{ "name": "Hermes", "profile": "default", "keyEnv": "API_SERVER_KEY" }] }';

/** With no config, the one agent most people have: Hermes's default profile, on its own port. */
const PLAIN = { agents: [{ name: "Hermes", profile: "default", keyEnv: "API_SERVER_KEY" }] };

/** Hermes's own settings file, where its API server's key is (`hermes gateway` reads it). */
export function hermesEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env["HERMES_HOME"] ?? resolve(homedir(), ".hermes"), ".env");
}

/** A value from Hermes's own `.env`, for a key the environment doesn't give. */
function fromHermes(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = hermesEnvPath(env);
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === name) return match[2]?.replace(/^(["'])(.*)\1$/, "$2");
  }
  return undefined;
}

/** The line Hermes's own docs give to install it. */
const INSTALL = "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash";

/**
 * The line that turns on Hermes's API server, to copy: both settings added to Hermes's own `.env`,
 * the key a random one. They were two hand edits with nothing to copy (Chips's onboarding audit,
 * Part 2, item 22).
 */
export function serverOnLine(path: string): string {
  return `printf '\\nAPI_SERVER_ENABLED=true\\nAPI_SERVER_KEY=%s\\n' "$(openssl rand -hex 32)" >> '${path.replace(/'/g, "'\\''")}'`;
}

/** Whether `hermes` is on this PATH. */
function hermesOnPath(env: NodeJS.ProcessEnv): boolean {
  return (env["PATH"] ?? "").split(delimiter).some((dir) => {
    if (dir === "") return false;
    try {
      accessSync(join(dir, "hermes"), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** A folder the config names, `~` at the home of the user the bridge runs as, in the place it is now. */
function folderOf(said: unknown): string | undefined {
  if (typeof said !== "string" || said === "") return undefined;
  return folderPathOf(said);
}

/** The config at `path`, each agent with its key from the environment. */
export function readConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  // No config is Hermes's default profile: a person who runs Hermes need write nothing first.
  const raw = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : PLAIN) as {
    name?: unknown;
    url?: unknown;
    folder?: unknown;
    folders?: unknown;
    agents?: unknown;
  };
  const url = typeof raw.url === "string" ? raw.url : "http://127.0.0.1:8642";
  const folder = folderOf(raw.folder);
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new SetupError(`${path} names no agents: ${EXAMPLE}. ${STILL_GOOD}`);
  }
  const agents = (raw.agents as Record<string, unknown>[]).map((agent) => {
    const keyEnv = typeof agent["keyEnv"] === "string" ? agent["keyEnv"] : "API_SERVER_KEY";
    // The environment's, else the one Hermes's API server was started with, in Hermes's own file.
    const fromEnv = filledIn(env[keyEnv]);
    const key = fromEnv ? env[keyEnv] : fromHermes(keyEnv, env);
    const own = folderOf(agent["folder"]) ?? folder;
    if (typeof agent["name"] !== "string") throw new SetupError(`Each agent in ${path} has a name. ${STILL_GOOD}`);
    if (!filledIn(key)) {
      // Nothing written down and no Hermes to be found: the first thing to do is install it. A
      // config, or Hermes's own file, says it is somewhere, and the key is what's missing.
      if (!existsSync(path) && !existsSync(hermesEnvPath(env)) && !hermesOnPath(env)) {
        throw new SetupError(`Hermes isn't installed on this machine: run \`${INSTALL}\`, then \`hermes setup\`. ${STILL_GOOD}`, {
          detail: "Hermes isn't on this Mac",
          says: "Hermes isn't installed on this Mac.",
          doing: "Run this in Terminal, then run hermes setup and try again.",
          copy: INSTALL,
        });
      }
      throw new SetupError(
        `${agent["name"]}'s key isn't in $${keyEnv} or ${hermesEnvPath(env)}. Turn on Hermes's API server: add API_SERVER_ENABLED=true and API_SERVER_KEY=<a long random key> to ${hermesEnvPath(env)}, and start \`hermes gateway\` again. ${STILL_GOOD}`,
        {
          detail: "No key for its API server",
          says: "Hermes's API server isn't set up.",
          doing: `Run this in Terminal to turn it on in ${shown(hermesEnvPath(env))}, then start Hermes again with hermes gateway and try again.`,
          copy: serverOnLine(hermesEnvPath(env)),
        },
      );
    }
    return {
      name: agent["name"],
      keyEnv,
      keyFrom: fromEnv ? `$${keyEnv}` : hermesEnvPath(env),
      address: {
        url: typeof agent["url"] === "string" ? agent["url"] : url,
        key,
        ...(typeof agent["profile"] === "string" ? { profile: agent["profile"] } : {}),
      },
      ...(typeof agent["model"] === "string" ? { model: agent["model"] } : {}),
      ...(own === undefined ? {} : { folder: own }),
    };
  });
  const hookPort = (raw as { hookPort?: unknown }).hookPort;
  return {
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    agents,
    folders: folderOf(raw.folders) ?? folderPathOf(placesOf().agents),
    ...(typeof hookPort === "number" && Number.isInteger(hookPort) && hookPort > 0 && hookPort < 65536 ? { hookPort } : {}),
  };
}

/** Hermes answering for each agent, and taking its key, before the link is spent. */
export async function checkHermes(
  config: Config,
  clientFor: (agent: AgentConfig) => { healthy(): Promise<boolean>; takesKey(): Promise<boolean> } = (agent) =>
    new HermesClient(agent.address),
): Promise<void> {
  for (const agent of config.agents) {
    const client = clientFor(agent);
    if (!(await client.healthy())) {
      throw new SetupError(
        `Hermes isn't answering for ${agent.name} at ${agent.address.url}: start its API server (API_SERVER_ENABLED=true, then hermes gateway). ${STILL_GOOD}`,
        {
          detail: `Nothing answers on port ${portOf(agent.address.url)}`,
          says: "Hermes's API server is off.",
          doing: `Add this line to ${shown(hermesEnvPath())}, then start Hermes with hermes gateway.`,
          copy: "API_SERVER_ENABLED=true",
        },
      );
    }
    if (!(await client.takesKey())) {
      throw new SetupError(
        `Hermes at ${agent.address.url} refused ${agent.name}'s key, from ${agent.keyFrom ?? `$${agent.keyEnv ?? "API_SERVER_KEY"}`}: it has to be the API_SERVER_KEY Hermes's API server was started with. Start \`hermes gateway\` again after changing it. ${STILL_GOOD}`,
        {
          detail: "Its API server refused the key",
          says: `Hermes refused ${agent.name}'s key.`,
          doing: "The key has to be the API_SERVER_KEY its API server was started with. Start hermes gateway again after changing it.",
        },
      );
    }
  }
}
