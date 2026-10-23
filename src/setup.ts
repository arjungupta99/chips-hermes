/**
 * What the bridge checks before it takes up a link, which works once (Chips ADR 0122): the config
 * it reads, each agent's key filled in rather than the `…` the gallery's command was copied with,
 * and Hermes answering at each agent's address and taking its key. Anything missing stops it with
 * what to do, and the link is still good for the same command run again.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { filledIn, type StopWords } from "@chipschat/harness";
import type { AgentConfig } from "./bridge.js";
import { HermesClient } from "./hermes.js";

export interface Config {
  readonly name?: string;
  readonly agents: readonly AgentConfig[];
  /** Where each agent gets a folder of its own, unless the config names one `folder` for them all. */
  readonly folders: string;
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

/** What the check found, under its step on the sheet. */
export function checkedWords(config: Config): string {
  const urls = new Set(config.agents.map((agent) => agent.address.url));
  const [url] = urls;
  return urls.size === 1 && url !== undefined
    ? `Its API server answers on port ${portOf(url)}`
    : `Its API server answers for each of ${config.agents.length} agents`;
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

/** A folder the config names, `~` at the home of the user the bridge runs as. */
function folderOf(said: unknown): string | undefined {
  if (typeof said !== "string" || said === "") return undefined;
  return resolve(said === "~" || said.startsWith("~/") ? homedir() + said.slice(1) : said);
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
      throw new SetupError(
        `${agent["name"]}'s key isn't in $${keyEnv} or ${hermesEnvPath(env)}. Turn on Hermes's API server: add API_SERVER_ENABLED=true and API_SERVER_KEY=<a long random key> to ${hermesEnvPath(env)}, and start \`hermes gateway\` again. ${STILL_GOOD}`,
        {
          detail: "No key for its API server",
          says: "Hermes's API server isn't set up.",
          doing: `Add API_SERVER_ENABLED=true and an API_SERVER_KEY, a long random key, to ${shown(hermesEnvPath(env))}. Then start Hermes with hermes gateway.`,
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
  return {
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    agents,
    folders: folderOf(raw.folders) ?? resolve(homedir(), "chips-hermes", "agents"),
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
