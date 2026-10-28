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
 * Each agent's page in Chips shows its context: the files Hermes builds it from, read under
 * `$HERMES_HOME` (else `~/.hermes`), and how full its context window is, which Hermes sends after
 * each model call to a webhook this adds to each profile's `config.yaml` (`hooks.ts`). It listens
 * for it on 127.0.0.1, on `hookPort` from the config, else the port it chose the first time.
 *
 * Hermes's gateway, at a local address, is started with the bridge when nothing answers there, so
 * the bridge kept running from login brings Hermes back after a reboot; and a person's Restart in
 * Chips restarts it (Chips ADR 0094, `gateway.ts`), as does the first agent made in Chips when the
 * gateway serves only the one profile it started with (Chips ADR 0241, `profiles.ts`).
 *
 * `npm run keep` is the same, then keeps the bridge running from login (`keep.ts`).
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkGit, connect, fileStore, helloOnce, JoinError, join as joinChips, reportStep } from "@chipschat/harness";
import { Bridge, type BridgeState, settingsFor, WANTS } from "./bridge.js";
import { Gateways, gatewayLog, gatewaysOf, restarter, thisMachine } from "./gateway.js";
import { HermesClient } from "./hermes.js";
import { hermesRoot, profileHome } from "./home.js";
import { hookPortIn } from "./hooks.js";
import { keepIfAsked, stopIfAsked, words } from "./keep.js";
import { hermesProfiles } from "./profiles.js";
import { type Config, checkedWords, checkHermes, readConfig, readyHooks, SetupError } from "./setup.js";

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const link = process.env["CHIPS_JOIN_LINK"] || undefined;

const LABEL = "chat.chips.hermes";
stopIfAsked(LABEL);
const configPath = resolve(home(words[0] ?? "~/.chips-hermes/config.json"));
// What it needs, checked before a link is taken up, which works once. Started without a link, a
// bridge up before Hermes waits for it, and says so in Chips meanwhile.
const folder = dirname(configPath);
const statePath = join(folder, "sessions.json");
const state: BridgeState = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as BridgeState)
  : { sessions: {} };
const saveState = (next: BridgeState) => {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
};
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

/** A port nothing listens on now, for Hermes's webhook the first time. */
const freePort = () =>
  new Promise<number>((done, failed) => {
    const server = createServer();
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => done(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

let config: Config;
// Hermes's webhook, which says how full each agent's context is: where it reaches the bridge, and its secret.
const root = hermesRoot();
const fills = (state.fills ??= {});
try {
  config = readConfig(configPath);
  if (link !== undefined) {
    reportStep("checking", { detail: "Looking for its API server" });
    await checkHermes(config);
  }
  fills.secret ??= randomBytes(32).toString("hex");
  fills.port =
    config.hookPort ?? fills.port ?? hookPortIn(profileHome(root, config.agents[0]?.address.profile)) ?? (await freePort());
  saveState(state);
  const first = config.agents[0];
  const gatewayUp = link !== undefined || (first !== undefined && (await new HermesClient(first.address).healthy()));
  const made = Object.values(state.made ?? {});
  const hooks = readyHooks(config, { root, port: fills.port, secret: fills.secret, gatewayUp, made });
  for (const line of hooks.lines) log(line);
  if (link !== undefined) reportStep("checked", { detail: checkedWords(config, hooks.restart) });
} catch (error) {
  if (!(error instanceof SetupError)) throw error;
  // Where it stopped, in a few words for Chips for Mac's sheet; the whole sentence for a terminal.
  reportStep("failed", error.words);
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
const name = config.name ?? "Hermes";

// Hermes's gateway, which the bridge starts when nothing answers and restarts when a person asks.
const gateways = new Gateways({
  gateways: gatewaysOf(config.agents),
  root,
  env: process.env,
  system: thisMachine(),
  log: (line) => log(`gateway: ${line}`),
  logFile: gatewayLog(folder),
});
// Kept running from login, the bridge brings Hermes back with it. A link's check found it answering.
if (link === undefined) await gateways.startIfDown();

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
  wants: WANTS,
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
}).catch(refused);
// Joined, `npm run keep` hands over to a copy kept running, which says the hello.
keepIfAsked(LABEL, joined.url, ["HERMES_HOME", ...config.agents.map((agent) => agent.keyEnv ?? "API_SERVER_KEY")], log);

// A person's edits from an agent's page reach the bridge once it is made.
let bridge: Bridge | undefined;
// A person's Restart (Chips ADR 0094): nothing said of Hermes until its gateway is back, or isn't.
const restart = restarter({
  restart: () => gateways.restart(),
  hold: (held) => bridge?.hold(held),
  say: async (trouble) => {
    if (bridge !== undefined) return bridge.restarted(trouble);
    await (trouble === undefined ? chips.reportOk() : chips.reportTrouble(trouble));
  },
  log: (line) => log(`gateway: ${line}`),
});
const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-hermes", version: "1.0.0" },
  store: fileStore(join(folder, "chips-state.json")),
  onRestart: restart,
  settings: settingsFor(() => bridge),
});

// Each agent works on its room's project in a copy of its own (Chips ADR 0221), where git will.
const git = await checkGit();
if (!git.ok) log(`rooms' projects are off: ${git.why}`);

bridge = new Bridge({
  folders: config.folders,
  projects: git.ok,
  chips,
  agents: config.agents,
  home: joined.spaceId,
  state,
  saveState,
  log,
  hermesRoot: root,
  fills: { port: fills.port, secret: fills.secret },
  // Each agent made in Chips is a Hermes profile of its own (Chips ADR 0241).
  profiles: hermesProfiles({ root, env: process.env, system: thisMachine(), log: (line) => log(`profiles: ${line}`) }),
  restartGateway: () => restart({ askedBy: "chips-hermes, for a new agent's profile", askedAt: new Date().toISOString() }),
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
    bridge?.stop();
    chips.close();
    process.exit(0);
  });
}
