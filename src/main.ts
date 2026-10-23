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
 *
 * `npm run keep` is the same, then keeps the bridge running from login (`keep.ts`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect, fileStore, helloOnce, JoinError, join as joinChips, reportStep } from "@chipschat/harness";
import { Bridge, type BridgeState } from "./bridge.js";
import { keepIfAsked, stopIfAsked, words } from "./keep.js";
import { type Config, checkedWords, checkHermes, readConfig, SetupError } from "./setup.js";

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const link = process.env["CHIPS_JOIN_LINK"] || undefined;

const LABEL = "chat.chips.hermes";
stopIfAsked(LABEL);
const configPath = resolve(home(words[0] ?? "~/.chips-hermes/config.json"));
// What it needs, checked before a link is taken up, which works once. Started without a link, a
// bridge up before Hermes waits for it, and says so in Chips meanwhile.
let config: Config;
try {
  config = readConfig(configPath);
  if (link !== undefined) {
    reportStep("checking", { detail: "Looking for its API server" });
    await checkHermes(config);
    reportStep("checked", { detail: checkedWords(config) });
  }
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  // Where it stopped, in a few words for Chips for Mac's sheet; the whole sentence for a terminal.
  reportStep("failed", error.words);
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const name = config.name ?? "Hermes";
const folder = dirname(configPath);
const statePath = join(folder, "sessions.json");
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

/** A link Chips refuses (spent, expired, not a link), said plainly: its words, no stack. */
const refused = (error: unknown): never => {
  if (!(error instanceof JoinError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
};
const joined = await joinChips({
  link,
  url: process.env["CHIPS_URL"],
  name,
  software: "chips-hermes 1.0.0",
  wants: ["agents", "new_agents"],
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
}).catch(refused);
// Joined, `npm run keep` hands over to a copy kept running, which says the hello.
keepIfAsked(LABEL, joined.url, ["HERMES_HOME", ...config.agents.map((agent) => agent.keyEnv ?? "API_SERVER_KEY")], log);

const state: BridgeState = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as BridgeState)
  : { sessions: {} };

const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-hermes", version: "1.0.0" },
  store: fileStore(join(folder, "chips-state.json")),
});

const bridge = new Bridge({
  folders: config.folders,
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
