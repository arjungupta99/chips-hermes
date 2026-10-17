/**
 * What the bridge checks before it takes up a link, which works once (Chips ADR 0122): the config
 * it reads, each agent's key filled in rather than the `…` the gallery's command was copied with,
 * and Hermes answering at each agent's address and taking its key. Anything missing stops it with
 * what to do, and the link is still good for the same command run again.
 */

import { existsSync, readFileSync } from "node:fs";
import { filledIn } from "@chipschat/harness";
import type { AgentConfig } from "./bridge.js";
import { HermesClient } from "./hermes.js";

export interface Config {
  readonly name?: string;
  readonly agents: readonly AgentConfig[];
}

/** Something to put right before the bridge starts, said so a person can. */
export class SetupError extends Error {
  override readonly name = "SetupError";
}

export const STILL_GOOD = "The link is still good: run the same command again once that's done.";

const EXAMPLE = '{ "agents": [{ "name": "Hermes", "profile": "default", "keyEnv": "API_SERVER_KEY" }] }';

/** The config at `path`, each agent with its key from the environment. */
export function readConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  if (!existsSync(path)) {
    throw new SetupError(`There is no config at ${path}. Write ${EXAMPLE} there. ${STILL_GOOD}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; url?: unknown; agents?: unknown };
  const url = typeof raw.url === "string" ? raw.url : "http://127.0.0.1:8642";
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new SetupError(`${path} names no agents: ${EXAMPLE}. ${STILL_GOOD}`);
  }
  const agents = (raw.agents as Record<string, unknown>[]).map((agent) => {
    const keyEnv = typeof agent["keyEnv"] === "string" ? agent["keyEnv"] : "API_SERVER_KEY";
    const key = env[keyEnv];
    if (typeof agent["name"] !== "string") throw new SetupError(`Each agent in ${path} has a name. ${STILL_GOOD}`);
    if (!filledIn(key)) {
      throw new SetupError(
        `${agent["name"]}'s key isn't in $${keyEnv}: set it to the key Hermes's API server was started with, not the … from the command. ${STILL_GOOD}`,
      );
    }
    return {
      name: agent["name"],
      keyEnv,
      address: {
        url: typeof agent["url"] === "string" ? agent["url"] : url,
        key,
        ...(typeof agent["profile"] === "string" ? { profile: agent["profile"] } : {}),
      },
      ...(typeof agent["model"] === "string" ? { model: agent["model"] } : {}),
    };
  });
  return { ...(typeof raw.name === "string" ? { name: raw.name } : {}), agents };
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
      );
    }
    if (!(await client.takesKey())) {
      throw new SetupError(
        `Hermes at ${agent.address.url} refused ${agent.name}'s key in $${agent.keyEnv ?? "API_SERVER_KEY"}: give it the API_SERVER_KEY its API server was started with. ${STILL_GOOD}`,
      );
    }
  }
}
