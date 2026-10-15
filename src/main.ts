/**
 * `npm start [config]`: the bridge as a daemon. It joins Chips once — with a link a person made in
 * Chips (`CHIPS_JOIN_LINK`), or with a code a person allows — and keeps its key; then it connects,
 * registers its agents, and answers for them through Hermes until it is stopped.
 *
 * The config is JSON, `~/.chips-hermes/config.json` unless a path is given:
 *
 *     { "url": "http://127.0.0.1:8642",
 *       "agents": [{ "name": "Hermes", "profile": "default", "keyEnv": "API_SERVER_KEY" }] }
 *
 * Each agent is a Hermes profile: `default`, or one reached under `/p/<profile>` when Hermes
 * multiplexes its profiles, or at a `url` of its own when each runs its own gateway. A key is read
 * from the environment variable `keyEnv` names, never written in the file. What it keeps is beside
 * the config: the SDK's state (cursor, unanswered events, runs not ended) and which session each
 * room is.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect, fileStore, join as joinChips } from "@chips/harness";
import { type AgentConfig, Bridge, type BridgeState } from "./bridge.js";

interface Config {
  readonly name?: string;
  readonly agents: readonly AgentConfig[];
}

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

function readConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; url?: unknown; agents?: unknown };
  const url = typeof raw.url === "string" ? raw.url : "http://127.0.0.1:8642";
  if (!Array.isArray(raw.agents) || raw.agents.length === 0) {
    throw new Error(`${path} names no agents: { "agents": [{ "name", "profile", "keyEnv" }] }`);
  }
  const agents = (raw.agents as Record<string, unknown>[]).map((agent) => {
    const keyEnv = typeof agent["keyEnv"] === "string" ? agent["keyEnv"] : "API_SERVER_KEY";
    const key = process.env[keyEnv];
    if (typeof agent["name"] !== "string") throw new Error(`each agent in ${path} has a name`);
    if (key === undefined || key === "") throw new Error(`${agent["name"]}'s key is not in $${keyEnv}`);
    return {
      name: agent["name"],
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

const configPath = resolve(home(process.argv[2] ?? "~/.chips-hermes/config.json"));
const config = readConfig(configPath);
const folder = dirname(configPath);
const statePath = join(folder, "sessions.json");
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

const joined = await joinChips({
  link: process.env["CHIPS_JOIN_LINK"],
  url: process.env["CHIPS_URL"],
  name: config.name ?? "Hermes",
  software: "chips-hermes 0.1.0",
  wants: ["agents"],
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
});

const state: BridgeState = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as BridgeState)
  : { sessions: {} };

const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-hermes", version: "0.1.0" },
  store: fileStore(join(folder, "chips-state.json")),
});

const bridge = new Bridge({
  chips,
  agents: config.agents,
  home: joined.spaceId,
  state,
  saveState: (next) => writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }),
  log,
});
await bridge.start();
log(`answering for ${config.agents.map((agent) => agent.name).join(", ")} through Hermes`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    bridge.stop();
    chips.close();
    process.exit(0);
  });
}
