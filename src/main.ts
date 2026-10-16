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
import { connect, fileStore, helloOnce, join as joinChips } from "@chipschat/harness";
import { Bridge, type BridgeState } from "./bridge.js";
import { type Config, checkHermes, readConfig, SetupError } from "./setup.js";

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const link = process.env["CHIPS_JOIN_LINK"] || undefined;

const configPath = resolve(home(process.argv[2] ?? "~/.chips-hermes/config.json"));
// What it needs, checked before a link is taken up, which works once. Started without a link, a
// bridge up before Hermes waits for it, and says so in Chips meanwhile.
let config: Config;
try {
  config = readConfig(configPath);
  if (link !== undefined) await checkHermes(config);
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const name = config.name ?? "Hermes";
const folder = dirname(configPath);
const statePath = join(folder, "sessions.json");
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

const joined = await joinChips({
  link,
  url: process.env["CHIPS_URL"],
  name,
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

// Its first words in the room it joined, once: the card that followed its link waits for them.
const main = bridge.mainAgentId;
await helloOnce(joined, {
  name,
  say: (spaceId) =>
    (main === undefined ? chips : chips.as(main)).post({
      spaceId,
      text: `Hi, I'm ${config.agents[0]?.name ?? name}, here through Hermes. Ask me anything.`,
    }),
}).catch((error: unknown) => log(`hello not said: ${String(error)}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    bridge.stop();
    chips.close();
    process.exit(0);
  });
}
