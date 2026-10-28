/**
 * The bridge between Chips's conformance fake — the wire as Chips speaks it, every event checked
 * against the protocol's schemas — and a scripted Hermes API server.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect, type Decision, type Refuse } from "@chipschat/harness";
import { type AgentFork, type Feedback, messageIdOf, type ModelChangeFrame, newId } from "@chipschat/protocol";
import {
  Bridge,
  type BridgeState,
  choiceOf,
  forkName,
  freeFolder,
  keyOf,
  lookAgain,
  lookingAgain,
  titleFrom,
  WANTS,
} from "../src/bridge.ts";
import { HermesClient } from "../src/hermes.ts";
import { envValue } from "../src/home.ts";
import type { ProfileMaker } from "../src/profiles.ts";
import { type FakeHermes, fakeProfiles, startFakeHermes } from "./fake-hermes.ts";

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly hermes: FakeHermes;
  readonly state: BridgeState;
  readonly agentId: string;
  /** What the bridge logged. */
  readonly logs: string[];
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

const AGENT = { name: "Hermes", profile: "default" } as const;

async function rig(
  options: {
    state?: BridgeState;
    chips?: FakeChips;
    hermes?: FakeHermes;
    profile?: string;
    model?: string;
    folder?: string;
    folders?: string;
    /** Agents work on their room's project (Chips ADR 0221). */
    projects?: boolean;
    /** More profiles, after the first. */
    also?: readonly { name: string; profile: string }[];
    /** What the bridge is handed in the client's place: a test's tap on it. */
    chipsFor?: (client: Chips) => Chips;
    /** Hermes's root, and what makes each agent made in Chips a profile of its own there (Chips ADR 0241). */
    hermesRoot?: string;
    profiles?: ProfileMaker;
    restartGateway?: () => Promise<void>;
  } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: ["agents"] }));
  if (options.chips === undefined) open.push(() => chips.close());
  const hermes = options.hermes ?? (await startFakeHermes());
  if (options.hermes === undefined) open.push(() => hermes.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const state = options.state ?? { sessions: {} };
  const address = { url: hermes.url, key: hermes.key, profile: options.profile ?? AGENT.profile };
  const logs: string[] = [];
  const bridge = new Bridge({
    chips: options.chipsFor?.(client) ?? client,
    agents: [
      {
        name: AGENT.name,
        address,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.folder === undefined ? {} : { folder: options.folder }),
      },
      ...(options.also ?? []).map(({ name, profile }) => ({ name, address: { ...address, profile } })),
    ],
    home: chips.address.spaceId,
    ...(options.folders === undefined ? {} : { folders: options.folders }),
    ...(options.projects === undefined ? {} : { projects: options.projects }),
    state,
    saveState: () => undefined,
    healthEveryMs: 50,
    log: (line) => void logs.push(line),
    ...(options.hermesRoot === undefined ? {} : { hermesRoot: options.hermesRoot, env: {} }),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
    ...(options.restartGateway === undefined ? {} : { restartGateway: options.restartGateway }),
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  return { chips, client, bridge, hermes, state, agentId: bridge.mainAgentId ?? "", logs };
}

async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const by = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > by) throw new Error(`not so within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sent(chips: FakeChips, type: string, more: (event: StoredEvent) => boolean = () => true): Promise<StoredEvent> {
  return chips.waitFor((event) => (event.type === type && more(event) ? event : undefined), 3000);
}

// Its Main agent was "Hermes 2" beside the "Hermes" Chips made at the join (Chips ON-10).
describe("its Main agent (Chips ADR 0183)", () => {
  it("is the agent Chips made at the join, called what its config says, with no second", async () => {
    const chips = await startFakeChips({ capabilities: ["agents"], harnessName: AGENT.name });
    open.push(() => chips.close());
    const { client, agentId } = await rig({ chips });
    const agents = await client.agents.list();
    assert.deepEqual(
      agents.map((agent) => [agent.key, agent.name, agent.lead]),
      [[client.harnessId, AGENT.name, true]],
    );
    assert.equal(agentId, agents[0]?.agentId);
    assert.ok(agents[0]?.spaces.includes(chips.address.spaceId), "in its own room");
  });

  it("moves Main from one it made before, which it archives, and takes its room", async () => {
    const chips = await startFakeChips({ capabilities: ["agents"], harnessName: AGENT.name });
    open.push(() => chips.close());
    // As a bridge did before: its own Main, numbered beside the default, in the default's place.
    const before = await connect({ url: chips.address.url, token: chips.address.token });
    const known = await before.agents.list();
    const old = await before.agents.register({
      key: keyOf({ name: AGENT.name, address: { url: "http://hermes", key: "k" } }),
      name: AGENT.name,
      lead: true,
    });
    await before.agents.attach(old.agentId, { spaceId: chips.address.spaceId, replacing: known[0]?.agentId ?? "" });
    before.close();
    assert.equal(old.name, `${AGENT.name} 2`);
    const { client, agentId } = await rig({ chips });
    const agents = await client.agents.list();
    const main = agents.find((agent) => agent.agentId === agentId);
    assert.deepEqual([main?.key, main?.name, main?.lead], [client.harnessId, AGENT.name, true]);
    assert.ok(main?.spaces.includes(chips.address.spaceId), "back in its own room");
    const gone = agents.find((agent) => agent.agentId === old.agentId);
    assert.deepEqual([gone?.lead, gone?.state], [false, "archived"]);
  });
});

// With its one agent Main, a group room could have none of it (Chips ON-12).
describe("a new agent a person asks for (Chips ADR 0108)", () => {
  it("joins the room it was asked for, once, however often the ask is heard", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const { client, agentId } = await rig({ chips });
    const room = await chips.openRoom("Plans");
    const { askId } = await chips.askForAgent(room, "Nova");
    await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const made = (await client.agents.list()).filter((agent) => agent.agentId !== agentId);
    assert.deepEqual(
      made.map((agent) => [agent.name, agent.lead, agent.spaces]),
      [["Nova", false, [room]]],
    );
  });

  it("answers in a session of its own, beside another asked for in the same room", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const { client, agentId, hermes, state } = await rig({ chips });
    const room = await chips.openRoom("Plans");
    for (const name of ["Nova", "Vega"]) {
      const { askId } = await chips.askForAgent(room, name);
      await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    }
    const made = (await client.agents.list()).filter((agent) => agent.agentId !== agentId).map((agent) => agent.agentId);
    await chips.say("summarise the notes", room);
    await until(() => chips.workspace.log.filter((event) => event.type === "run.completed").length === 2);
    const took = chips.workspace.log.filter((event) => event.type === "run.started").map((event) => event.actor.id);
    assert.deepEqual([...took].sort(), [...made].sort(), "each took its turn as itself");
    assert.equal(new Set(hermes.started.map((run) => run.sessionId)).size, 2, "two Hermes sessions");
    assert.deepEqual(Object.keys(state.sessions).sort(), made.map((id) => `${id}|${room}`).sort());
  });
});

// Hermes took no spaces from the +, which the ACP bridge did (Chips ADR 0241).
describe("a space a person asks for from the + (Chips ADR 0241)", () => {
  it("is claimed and named, and an agent of its own answers the first words in a session of its own", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_spaces"] });
    open.push(() => chips.close());
    const { client, hermes, state } = await rig({ chips });
    const { spaceId } = await chips.askForSpace("Plan a weekend in Lisbon for two");
    const claimed = await sent(chips, "space.claimed", (event) => event.space_id === spaceId);
    assert.equal(claimed.payload["title"], "Plan a weekend in Lisbon for two");
    const words = await sent(chips, "message.post", (event) => event.space_id === spaceId && event.run_id !== null);
    const agent = (await client.agents.list()).find((each) => each.key === `hermes:space:${spaceId}`);
    assert.ok(agent !== undefined, "the agent Chips made for the claim");
    assert.equal(words.actor.id, agent.agentId);
    assert.deepEqual(agent.spaces, [spaceId]);
    const started = await sent(chips, "run.started", (event) => event.space_id === spaceId);
    assert.equal(started.payload["goal"], "Plan a weekend in Lisbon for two");
    const ran = hermes.started.at(-1);
    assert.match(ran?.input ?? "", /Plan a weekend in Lisbon for two$/);
    assert.equal(ran?.sessionId, state.sessions[`${agent.agentId}|${spaceId}`], "a session of its own");
  });

  it("answers what is said next in the same session", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_spaces"] });
    open.push(() => chips.close());
    const { hermes } = await rig({ chips });
    const { spaceId } = await chips.askForSpace("Plan a weekend in Lisbon for two");
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    const asked = await chips.say("make it Porto", spaceId);
    await sent(chips, "run.completed", (event) => event.space_id === spaceId && event.seq > asked.seq);
    const [first, next] = hermes.started.slice(-2);
    assert.equal(next?.sessionId, first?.sessionId);
    assert.match(next?.history[0] ?? "", /Plan a weekend in Lisbon for two$/);
  });

  it("names a space from the first line of what it is for, and asks to take spaces", () => {
    assert.equal(titleFrom("Short one\nand more"), "Short one");
    assert.equal(
      titleFrom("Work out why the nightly backup to the NAS keeps failing after midnight"),
      "Work out why the nightly backup to the NAS…",
    );
    assert.ok(WANTS.includes("new_spaces"), "so the + offers Hermes");
  });
});

// A new agent ran on the Main agent's profile, so two Hermes agents in Chips were one Hermes
// remembering for both (Chips ADR 0241).
describe("a Hermes profile of its own for each agent made in Chips (Chips ADR 0241)", () => {
  /** A Chips, the bridge, and Hermes's default profile in a root of the test's, with what makes profiles there. */
  async function withProfiles(options: Parameters<typeof rig>[0] = {}) {
    const chips = options.chips ?? (await startFakeChips({ capabilities: ["agents", "new_spaces", "new_agents", "forks"] }));
    if (options.chips === undefined) open.push(() => chips.close());
    const root = options.hermesRoot ?? mkdtempSync(join(tmpdir(), "chips-hermes-profiles-"));
    if (options.hermesRoot === undefined) {
      open.push(async () => rmSync(root, { recursive: true, force: true }));
      writeFileSync(join(root, "config.yaml"), "model:\n  default: heron-2\n  provider: fake\n");
      writeFileSync(join(root, ".env"), "API_SERVER_ENABLED=true\nAPI_SERVER_KEY=hermes-test-key\nFAKE_API_KEY=k\n", { mode: 0o600 });
      writeFileSync(join(root, "SOUL.md"), "You are Hermes.\n");
      mkdirSync(join(root, "memories"));
      writeFileSync(join(root, "memories", "MEMORY.md"), "Arjun likes tea");
      writeFileSync(join(root, "memories", "USER.md"), "Arjun is an engineer");
    }
    const profiles = fakeProfiles(root);
    const restarts: string[] = [];
    const made = await rig({
      chips,
      hermesRoot: root,
      profiles,
      restartGateway: async () => void restarts.push("restarted"),
      ...options,
    });
    made.hermes.root = root;
    return { ...made, root, profiles, restarts };
  }

  /** A new agent asked for in a room of its own, once it has a profile or the log says why not. */
  async function asked(r: Pick<Rig, "chips" | "state" | "logs">, name: string) {
    const room = await r.chips.openRoom("Plans");
    const { askId } = await r.chips.askForAgent(room, name);
    const joined = await sent(r.chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const agentId = String(joined.payload["participant_id"]);
    await until(() => r.state.made?.[agentId] !== undefined || r.logs.some((line) => line.includes("Hermes didn't make it one")));
    return { room, agentId };
  }

  /** Words said in a room, to the end of the turn they were. */
  async function said(chips: FakeChips, words: string, room: string): Promise<void> {
    const asked = await chips.say(words, room);
    const started = await sent(chips, "run.started", (event) => event.seq > asked.seq && event.space_id === room);
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
  }

  it("clones the Main agent's profile for a new agent, its memory empty and its key its own, and answers there", async () => {
    const r = await withProfiles();
    const { chips, hermes, state, root, profiles, restarts } = r;
    const { room, agentId } = await asked(r, "Nova");
    assert.deepEqual(profiles.made, [{ name: "nova", from: "default" }]);
    assert.equal(state.made?.[agentId], "nova");
    const home = join(root, "profiles", "nova");
    assert.equal(readFileSync(join(home, "SOUL.md"), "utf8"), "You are Hermes.\n", "its persona to start from");
    assert.equal(envValue(home, "FAKE_API_KEY"), "k", "the Main agent's keys");
    assert.ok(!existsSync(join(home, "memories", "MEMORY.md")), "its memory starts empty");
    assert.ok(!existsSync(join(home, "memories", "USER.md")));
    const key = envValue(home, "API_SERVER_KEY") ?? "";
    assert.match(key, /^[0-9a-f]{64}$/, "a key of its own for /p/nova");
    assert.notEqual(key, hermes.key);
    assert.equal(profiles.asked, 1, "the gateway asked to serve it");
    assert.deepEqual(restarts, [], "a gateway that multiplexes isn't restarted");
    await said(chips, "plan the trip", room);
    const ran = hermes.started.at(-1);
    assert.deepEqual([ran?.profile, ran?.sessionId], ["nova", state.sessions[`${agentId}|${room}`]]);
    // Its models are its profile's (Chips ADR 0141).
    await until(() => chips.settings.copy("model", agentId) !== undefined);
    assert.ok(hermes.optionsAsked.includes("nova"), hermes.optionsAsked.join(", "));
  });

  it("restarts Hermes's gateway once when it serves only the profile it started with", async () => {
    const r = await withProfiles();
    const { profiles, logs, restarts } = r;
    profiles.answers = [false, true];
    await asked(r, "Nova");
    assert.deepEqual(restarts, ["restarted"]);
    assert.ok(logs.some((line) => line.startsWith("Hermes's gateway serves only the profile it started with")), logs.join("\n"));
    await asked(r, "Vega");
    assert.deepEqual(restarts, ["restarted"], "once");
    assert.deepEqual(
      profiles.made.map((each) => each.name),
      ["nova", "vega"],
    );
  });

  it("names the next agent of the same name -2, and keeps each on its profile when the bridge starts again", async () => {
    const first = await withProfiles();
    const nova = await asked(first, "Nova");
    const second = await asked(first, "Nova");
    assert.deepEqual(
      first.profiles.made.map((each) => each.name),
      ["nova", "nova-2"],
    );
    first.bridge.stop();
    first.client.close();
    const again = await withProfiles({ chips: first.chips, hermes: first.hermes, state: first.state, hermesRoot: first.root });
    await said(again.chips, "plan the trip", nova.room);
    await said(again.chips, "and the hotel", second.room);
    assert.deepEqual(
      again.hermes.started.slice(-2).map((each) => each.profile),
      ["nova", "nova-2"],
    );
    assert.deepEqual(again.profiles.made, [], "no profile made again");
  });

  it("runs a new agent on the first profile when Hermes doesn't make it one, and says why", async () => {
    const r = await withProfiles();
    const { chips, hermes, state, profiles, logs } = r;
    profiles.refuse = "Profile name 'nova' is reserved";
    const { room, agentId } = await asked(r, "Nova");
    assert.ok(logs.includes("Nova runs on the default profile, in a session of its own: Hermes didn't make it one (Profile name 'nova' is reserved)"), logs.join("\n"));
    assert.equal(state.made?.[agentId], undefined);
    await said(chips, "plan the trip", room);
    assert.deepEqual([hermes.started.at(-1)?.profile, hermes.started.at(-1)?.sessionId], ["default", state.sessions[`${agentId}|${room}`]]);
  });

  it("leaves an agent made before profiles on the first profile, with its sessions", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const before = await rig({ chips });
    const room = await chips.openRoom("Plans");
    const { askId } = await chips.askForAgent(room, "Nova");
    const joined = await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const nova = String(joined.payload["participant_id"]);
    await said(chips, "plan the trip", room);
    const session = before.state.sessions[`${nova}|${room}`];
    before.bridge.stop();
    before.client.close();
    const after = await withProfiles({ chips, hermes: before.hermes, state: before.state });
    await said(chips, "and the hotel", room);
    const ran = after.hermes.started.at(-1);
    assert.deepEqual([ran?.profile, ran?.sessionId], ["default", session]);
    assert.match(ran?.history[0] ?? "", /plan the trip$/, "it remembers");
    assert.deepEqual(after.profiles.made, []);
  });

  it("makes the agent of a space from the + a profile of its own", async () => {
    const { chips, client, hermes, state, profiles } = await withProfiles();
    const { spaceId } = await chips.askForSpace("Plan a weekend in Lisbon for two");
    await sent(chips, "run.completed", (event) => event.space_id === spaceId);
    const agent = (await client.agents.list()).find((each) => each.key === `hermes:space:${spaceId}`);
    const profile = state.made?.[agent?.agentId ?? ""] ?? "";
    assert.equal(profiles.made[0]?.name, profile);
    assert.equal(hermes.started.at(-1)?.profile, profile);
  });

  it("copies an agent with a profile of its own on that profile, where Hermes forks its session", async () => {
    const r = await withProfiles();
    const { chips, client, hermes, state, profiles } = r;
    const { room, agentId } = await asked(r, "Nova");
    await said(chips, "plan the trip", room);
    const second = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(agentId, second);
    const joined = await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId);
    const copy = String(joined.payload["participant_id"]);
    assert.deepEqual(
      hermes.forks.map((each) => [each.profile, each.made]),
      [["nova", true]],
    );
    await until(() => state.profiles?.[copy] === agentId);
    await said(chips, "what did we plan?", second);
    const ran = hermes.started.at(-1);
    assert.deepEqual([ran?.profile, ran?.sessionId], ["nova", `chips-fork-${forkId}`]);
    assert.match(ran?.history[0] ?? "", /plan the trip$/);
    assert.equal(profiles.made.length, 1, "no profile of its own: Hermes can't take a session to another");
    assert.ok((await client.agents.list()).some((each) => each.agentId === copy));
  });
});

// Chips offered Fork for the other harnesses' agents, and Hermes's made no copies (Chips ADR 0087).
describe("a copy a person asks for (Chips ADR 0087, Fork)", () => {
  /** A Chips that offers Fork, the bridge, and Nova, asked for in a room of the owner's. */
  async function withNova(options: Parameters<typeof rig>[0] = {}) {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents", "forks"] });
    open.push(() => chips.close());
    const root = mkdtempSync(join(tmpdir(), "chips-hermes-forks-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const made = await rig({ chips, folders: root, ...options });
    const room = await chips.openRoom("Plans");
    const { askId } = await chips.askForAgent(room, "Nova");
    const joined = await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    return { ...made, room, nova: String(joined.payload["participant_id"]) };
  }

  /** Words said in a room, and the turn they were, to its end. */
  async function said(chips: FakeChips, words: string, room: string): Promise<void> {
    const asked = await chips.say(words, room);
    const started = await sent(chips, "run.started", (event) => event.seq > asked.seq && event.space_id === room);
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
  }

  /** A copy of an agent asked for in a room of its own, and joined there. */
  async function forked(chips: FakeChips, agentId: string) {
    const second = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(agentId, second);
    const joined = await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId);
    return { second, forkId, copy: String(joined.payload["participant_id"]) };
  }

  /** The bridge's own fork handlers, so an ask can be handed over again, or made up. */
  function tapped(handlers: ((event: AgentFork) => void)[]) {
    return (client: Chips): Chips =>
      new Proxy(client, {
        get(target, name) {
          if (name === "on") {
            return (type: "agent.fork", handler: (event: AgentFork) => void) => {
              if (type === "agent.fork") handlers.push(handler);
              return target.on(type, handler);
            };
          }
          const value: unknown = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
  }

  it("forks the agent's session in Hermes, which the copy answers in, in its original's folder", async () => {
    const { chips, client, hermes, state, room, nova } = await withNova();
    await said(chips, "plan the trip", room);
    const kept = state.sessions[`${nova}|${room}`] ?? "";
    const { second, forkId, copy } = await forked(chips, nova);
    const agent = (await client.agents.list()).find((each) => each.agentId === copy);
    assert.deepEqual([agent?.name, agent?.forkedFrom, agent?.spaces], ["Nova · fork", nova, [second]]);
    const id = `chips-fork-${forkId}`;
    assert.deepEqual(
      hermes.forks.map((each) => [each.from, each.id, each.made]),
      [[kept, id, true]],
    );
    assert.equal(hermes.forks[0]?.title, `Chips space ${second} · hermes:fork:${forkId}`, "a title no other session has");
    assert.equal(hermes.ended.get(kept), "branched", "as Hermes's fork leaves it");
    assert.equal(state.sessions[`${copy}|${second}`], id);
    assert.equal(state.profiles?.[copy], keyOf({ name: AGENT.name, address: { url: hermes.url, key: hermes.key, profile: "default" } }));
    const folder = state.folders?.[nova] ?? "";
    assert.equal(state.folders?.[copy], folder, "the files of the conversation it remembers");
    await said(chips, "what did we plan?", second);
    const ran = hermes.started.at(-1);
    assert.equal(ran?.sessionId, id);
    assert.match(ran?.history[0] ?? "", /plan the trip$/, "it remembers");
    assert.ok(ran?.instructions?.includes(`Your own folder is ${folder}:`), ran?.instructions);
    assert.equal(hermes.sessions.length, 1, "no new session for the copy");
  });

  it("goes on apart from its original, each in its own session", async () => {
    const { chips, hermes, state, room, nova } = await withNova();
    await said(chips, "plan the trip", room);
    const { second, copy } = await forked(chips, nova);
    await said(chips, "make it Lisbon", room);
    await said(chips, "make it Porto", second);
    const [lisbon, porto] = hermes.started.slice(-2);
    // The original's session, ended by the fork, still takes its turns, as Hermes's does.
    assert.equal(lisbon?.sessionId, state.sessions[`${nova}|${room}`]);
    assert.equal(porto?.sessionId, state.sessions[`${copy}|${second}`]);
    assert.ok(!porto?.history.some((each) => each.endsWith("make it Lisbon")), "the copy didn't hear the original");
    await said(chips, "and now?", room);
    const after = hermes.started.at(-1)?.history ?? [];
    assert.ok(after.some((each) => each.endsWith("make it Lisbon")), "the original remembers its own");
    assert.ok(!after.some((each) => each.endsWith("make it Porto")), "and not the copy's");
  });

  it("answers through its original's profile, whose Hermes has the session", async () => {
    const { chips, client, hermes, state, room, nova } = await withNova({ also: [{ name: "Bea", profile: "bob" }] });
    const bea = (await client.agents.list()).find((each) => each.name === "Bea")?.agentId ?? "";
    await client.agents.attach(bea, { spaceId: room, replacing: nova });
    await said(chips, "plan the trip", room);
    assert.equal(hermes.started.at(-1)?.profile, "bob");
    const { second, copy } = await forked(chips, bea);
    assert.deepEqual(
      hermes.forks.map((each) => [each.profile, each.made]),
      [["bob", true]],
    );
    await said(chips, "what did we plan?", second);
    const ran = hermes.started.at(-1);
    assert.deepEqual([ran?.profile, ran?.sessionId], ["bob", state.sessions[`${copy}|${second}`]]);
    assert.match(ran?.history[0] ?? "", /plan the trip$/);
  });

  it("answers what is said to the copy before it is kept in the session it was forked", async () => {
    // Chips has the copy in the room before the bridge hears back from registering it.
    const late = (client: Chips): Chips =>
      new Proxy(client, {
        get(target, name) {
          if (name === "agents") {
            return {
              ...target.agents,
              register: async (input: Parameters<Chips["agents"]["register"]>[0]) => {
                const registered = await target.agents.register(input);
                if (input.forkedFrom !== undefined) await new Promise((resolve) => setTimeout(resolve, 200));
                return registered;
              },
            };
          }
          const value: unknown = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const { chips, hermes, room, nova } = await withNova({ chipsFor: late });
    await said(chips, "plan the trip", room);
    const second = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(nova, second);
    await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId);
    await said(chips, "what did we plan?", second);
    assert.equal(hermes.started.at(-1)?.sessionId, `chips-fork-${forkId}`);
    assert.equal(hermes.sessions.length, 1, "no blank session made for it first");
  });

  it("makes one copy of an ask heard twice", async () => {
    const handlers: ((event: AgentFork) => void)[] = [];
    const { chips, client, hermes, state, logs, room, nova } = await withNova({ chipsFor: tapped(handlers) });
    const heard: AgentFork[] = [];
    client.on("agent.fork", (event) => void heard.push(event));
    await said(chips, "plan the trip", room);
    const { second, forkId, copy } = await forked(chips, nova);
    await until(() => heard.length === 1);
    assert.equal(handlers.length, 1, "the bridge's own handler");
    for (const handler of handlers) handler(heard[0] as AgentFork);
    await until(() => logs.filter((line) => line.startsWith("Nova · fork, a copy of Nova, made")).length === 2);
    assert.deepEqual(logs.filter((line) => line.includes("not in the room")), []);
    const copies = (await client.agents.list()).filter((each) => each.forkedFrom === nova);
    assert.deepEqual(
      copies.map((each) => each.agentId),
      [copy],
    );
    assert.deepEqual(
      hermes.forks.map((each) => [each.id, each.made]),
      [
        [`chips-fork-${forkId}`, true],
        [`chips-fork-${forkId}`, false],
      ],
      "Hermes refused the id the second time",
    );
    assert.equal(state.sessions[`${copy}|${second}`], `chips-fork-${forkId}`);
  });

  it("copies an agent that never spoke with nothing to remember, in the same folder", async () => {
    const { chips, hermes, state, logs, nova } = await withNova();
    const { second, copy } = await forked(chips, nova);
    assert.deepEqual(hermes.forks, []);
    assert.ok(logs.includes("Nova never spoke: its copy remembers nothing"), logs.join("\n"));
    await said(chips, "plan the trip", second);
    assert.deepEqual(hermes.started.at(-1)?.history, [], "a new session of its own");
    assert.equal(state.folders?.[copy], state.folders?.[nova]);
  });

  it("forks a compressed session from where it is now", async () => {
    const { chips, hermes, state, room, nova } = await withNova();
    await said(chips, "plan the trip", room);
    const latest = hermes.compress(state.sessions[`${nova}|${room}`] ?? "");
    const { second } = await forked(chips, nova);
    assert.equal(hermes.forks[0]?.from, latest);
    await said(chips, "what did we plan?", second);
    assert.match(hermes.started.at(-1)?.history[0] ?? "", /plan the trip$/);
  });

  it("makes no copy of an agent not the harness's, nor for an ask the room stopped waiting for", async () => {
    const handlers: ((event: AgentFork) => void)[] = [];
    const { chips, client, hermes, logs, room, nova } = await withNova({ chipsFor: tapped(handlers) });
    await said(chips, "plan the trip", room);
    const second = await chips.openRoom("Second opinion");
    const owner = chips.workspace.owner.participantId;
    const ask = (agentId: string, agoMs: number) =>
      ({
        v: 1,
        type: "agent.fork",
        id: newId("event"),
        ts: new Date(Date.now() - agoMs).toISOString(),
        workspace_id: client.workspaceId,
        space_id: second,
        actor: { kind: "person", id: owner },
        agent_id: agentId,
        by: owner,
      }) as AgentFork;
    for (const handler of handlers) {
      handler(ask(newId("agent"), 0));
      handler(ask(nova, 61_000));
    }
    await until(() => logs.filter((line) => line.startsWith("no copy of")).length === 2);
    assert.ok(logs.some((line) => line.endsWith("it isn't one of this harness's agents")), logs.join("\n"));
    assert.ok(logs.some((line) => line === `no copy of ${nova}: asked 61 s ago, and the room waits a minute`), logs.join("\n"));
    assert.deepEqual(hermes.forks, []);
    assert.ok(!(await client.agents.list()).some((each) => each.forkedFrom !== null));
  });

  it("keeps the copy in Hermes when Hermes refuses its title, and when its id is taken", async () => {
    const hermes = await startFakeHermes();
    open.push(() => hermes.close());
    const client = new HermesClient({ url: hermes.url, key: hermes.key });
    const original = await client.newSession("Chips space one");
    await client.newSession("Chips space two");
    // Refused after the copy is made, as Hermes 0.22.0 refuses a title in use.
    assert.equal(await client.forkSession(original, { id: "copy", title: "Chips space two" }), "copy");
    assert.equal(await client.forkSession(original, { id: "copy", title: "Chips space three" }), "copy");
    assert.deepEqual(
      hermes.forks.map((each) => each.made),
      [true, false],
    );
  });

  it("is called after its original, as Jacobian calls a fork, and asks to make copies", () => {
    assert.equal(forkName("Nova"), "Nova · fork");
    assert.equal(forkName("Nova · fork 2"), "Nova · fork");
    assert.ok(WANTS.includes("forks"), "so Chips offers Fork for its agents");
  });
});

// Hermes's agents answered with a path or a 127.0.0.1 link, which no phone opens (Chips TT-7).
describe("the files an answer names", () => {
  /** A folder Hermes works in, with a page in it, and a file beside it that isn't Hermes's. */
  function folders(): string {
    const root = mkdtempSync(join(tmpdir(), "chips-hermes-files-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "work", "page.html"), "<p>play</p>");
    writeFileSync(join(root, "secret.txt"), "not Hermes's");
    return join(root, "work");
  }

  it("sends each file a MEDIA: line names from its folder, and says what it couldn't send", async () => {
    const { chips, hermes } = await rig({ folder: folders() });
    await chips.say("send the page");
    const started = await sent(chips, "run.started");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "The page is ready.\n\n(secret.txt was not attached: it is outside the agent's folder.)");
    const attachments = words.payload["attachments"] as { filename: string }[];
    assert.deepEqual(
      attachments.map((each) => each.filename),
      ["page.html"],
    );
    // Told in the run's instructions, which Hermes puts in the system prompt over its own hint
    // that the API server sends only pictures; in the turn's words it lost to that hint.
    const told = hermes.started[0]?.instructions ?? "";
    assert.match(told, /MEDIA:<path> on a line of its own/, "it was told how");
    assert.match(told, /does not hold for these runs/, "and that Hermes's own hint is wrong here");
    assert.doesNotMatch(hermes.started[0]?.input ?? "", /MEDIA:<path>/, "once");
  });

  it("gives an agent a folder of its own, says where in the run's instructions, and sends from it", async () => {
    // Every agent shared one folder, which had to be Hermes's own working folder: a team overwrote a
    // one-agent room's game (TT-16), and a plain Hermes works in the home folder (setup audit, S11).
    const root = mkdtempSync(join(tmpdir(), "chips-hermes-agents-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const own = join(root, "hermes");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "page.html"), "<p>play</p>");
    const { chips, hermes, state, agentId } = await rig({ folders: root });
    await chips.say("send the page");
    const started = await sent(chips, "run.started");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    const attachments = words.payload["attachments"] as { filename: string }[];
    assert.deepEqual(
      attachments.map((each) => each.filename),
      ["page.html"],
    );
    assert.match(hermes.started[0]?.instructions ?? "", new RegExp(`Your own folder is ${own}: make and keep your files there`));
    assert.equal(state.folders?.[agentId], own, "kept, so a rename keeps it");
  });

  it("names a folder after the agent, and the next one with the same name -2", () => {
    assert.equal(freeFolder("/r", "Hal Jordan", []), "/r/hal-jordan");
    assert.equal(freeFolder("/r", "Hal Jordan", ["/r/hal-jordan"]), "/r/hal-jordan-2");
    assert.equal(freeFolder("/r", "!!!", []), "/r/agent");
  });

  it("says in the room why no file went, with no folder set, rather than show the lines", async () => {
    const { chips, hermes } = await rig();
    await chips.say("send the page");
    const started = await sent(chips, "run.started");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    const why = "was not attached: this agent has no folder its files are sent from.)";
    assert.equal(words.payload["text"], `The page is ready.\n\n(page.html ${why}\n\n(secret.txt ${why}`);
    assert.match(hermes.started[0]?.instructions ?? "", /MEDIA:<path>/, "told how all the same");
  });
});

describe("the room's project (Chips ADR 0221)", () => {
  it("hands the agent its copy in its folder, and sends what it left there with its next turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-hermes-project-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const { chips, hermes, agentId, logs } = await rig({ folders: root, projects: true });
    await chips.say("start the notes");
    await sent(chips, "run.completed");
    const copy = join(root, "hermes", "room");
    assert.ok(
      (hermes.started[0]?.input ?? "").includes(`The space's project is a git repository. Your copy is ${copy} (0 files), brought up to date just now.`),
      "told where its copy is",
    );
    // Only a file outside the project needs sending (Chips AP-9).
    assert.match(hermes.started[0]?.instructions ?? "", /^A file that isn't in the space's project reaches this space only when you send it/);
    assert.ok(logs.includes("Hermes's project: nothing to send"), logs.join("\n"));

    // The turn that wrote this stopped before it could send it: the next one takes it.
    writeFileSync(join(copy, "notes.md"), "One sentence.\n");
    await chips.say("go on");
    const changed = await sent(chips, "project.changed");
    assert.equal(changed.payload["by"], agentId);
    assert.deepEqual(changed.payload["files"], [{ path: "notes.md", added: 1, removed: 0 }]);
    assert.match(hermes.started[1]?.input ?? "", /In Markdown, put each sentence on a line of its own\./);
  });

  // The live check on 23 October logged "Hermes's project" for Quill's push, signed by Quill.
  it("names in its log the agent whose copy it is, as its commits are signed", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-hermes-project-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const { logs } = await rig({ chips, folders: root, projects: true });
    const room = await chips.openRoom("Plans");
    const { askId } = await chips.askForAgent(room, "Nova");
    await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    await chips.say("start the notes", room);
    await sent(chips, "run.completed");
    assert.ok(logs.includes("Nova's project: nothing to send"), logs.join("\n"));
  });

  it("says after its words when its change didn't reach the project (Chips AP-6)", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-hermes-project-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const { chips } = await rig({ folders: root, projects: true });
    await chips.say("start the notes");
    await sent(chips, "run.completed");
    // A key in the copy holds the whole change back: the reply mustn't read as if it went.
    const key = ["sk-", "ant-", "api03-", "Z".repeat(40)].join("");
    writeFileSync(join(root, "hermes", "room", "config.js"), `export const key = "${key}";\n`);
    await chips.say("go on");
    const posted = await sent(chips, "message.post", (event) => String(event.payload["text"] ?? "").includes("(Not in"));
    assert.match(
      String(posted.payload["text"]),
      /\n\n\(Not in the space's project: config\.js looks like it holds an Anthropic key, so nothing was sent\.\)$/,
    );
    assert.equal(posted.payload["change"], undefined);
  });

  it("leaves an agent a person pointed at a folder of their own working there, with no project", async () => {
    const own = mkdtempSync(join(tmpdir(), "chips-hermes-own-"));
    open.push(async () => rmSync(own, { recursive: true, force: true }));
    const { chips, hermes } = await rig({ folder: own, projects: true });
    await chips.say("look at my repo");
    await sent(chips, "run.completed");
    assert.doesNotMatch(hermes.started[0]?.input ?? "", /The space's project/);
    assert.match(hermes.started[0]?.instructions ?? "", /^A file reaches this space only when you send it/);
    assert.equal(existsSync(join(own, "room")), false);
  });
});

describe("a turn", () => {
  it("hands the agent the message a reply answers, after what was said and before the words (Chips ADR 0219)", async () => {
    const { chips, hermes } = await rig({ model: "heron-2" });
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    const answer = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    await sent(chips, "run.completed");
    await chips.say("Shorter, please", undefined, { replyTo: messageIdOf(answer.id) });
    await chips.waitFor((event) => (event.type === "run.completed" && hermes.started.length === 2 ? event : undefined), 3000);
    const prompt = hermes.started[1]?.input ?? "";
    const quote = String(answer.payload["text"])
      .split("\n")
      .map((line) => (line === "" ? ">" : `> ${line}`))
      .join("\n");
    // Who replies says their standing, as every line of the turn does (Chips SEC-49).
    assert.match(prompt, /Arjun \(owner\) is replying to your message from today at \d{1,2}:\d{2} [AP]M\.\nYour message:\n/);
    assert.ok(prompt.includes(`Your message:\n${quote}\n\n`), prompt);
    assert.match(prompt, /Shorter, please$/);
  });

  it("is a run: a status, a step drawn by its kind, the words in the room, its tokens, and the end", async () => {
    const { chips, agentId, hermes } = await rig({ model: "heron-2" });
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    assert.equal(started.actor.id, agentId, "the Main agent took it");
    const status = await sent(chips, "run.status");
    assert.equal(status.payload["verb_phrase"], "Let me look at the notes.");
    const step = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.equal(step.payload["tool"], "read_file");
    assert.equal(step.payload["summary"], "3 lines");
    const opened = await sent(chips, "step.log", (event) => event.payload["status"] === "started");
    assert.equal(opened.payload["kind"], "file");
    assert.equal(opened.payload["title"], "read_file · notes.md");
    assert.equal(opened.payload["step_id"], step.payload["step_id"], "one step, started and done");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
    const usage = await sent(chips, "usage");
    assert.deepEqual(
      [usage.payload["model"], usage.payload["input_tokens"], usage.payload["output_tokens"]],
      ["heron-2", 1200, 40],
    );
    await sent(chips, "run.completed");
    assert.equal(hermes.started[0]?.model, "heron-2", "the agent's model asked for");
    assert.match(hermes.started[0]?.input ?? "", /summarise the notes$/);
  });

  it("counts every token in, and says how many of them the cache held (Chips ADR 0214)", async () => {
    const { chips } = await rig();
    await chips.say("summarise the notes");
    const usage = await sent(chips, "usage");
    assert.deepEqual(
      [usage.payload["input_tokens"], usage.payload["cache_read_tokens"], usage.payload["cache_write_tokens"]],
      [1200, 900, 200],
      "Hermes's own count, the cache already in it",
    );
    const older = await startFakeHermes({ usage: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240 } });
    open.push(() => older.close());
    const plain = await rig({ hermes: older });
    await plain.chips.say("summarise the notes");
    const said = await sent(plain.chips, "usage");
    assert.equal(said.payload["input_tokens"], 1200);
    assert.ok(!("cache_read_tokens" in said.payload) && !("cache_write_tokens" in said.payload), "left out, not 0");
  });

  it("keeps one Hermes session per room, and a second message is the same session", async () => {
    const { chips, hermes, state } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    await chips.say("two");
    await chips.waitFor((event) => (event.type === "run.completed" && hermes.started.length === 2 ? event : undefined), 3000);
    assert.equal(hermes.sessions.length, 1);
    assert.deepEqual(hermes.started.map((run) => run.sessionId), ["sess_1", "sess_1"]);
    assert.deepEqual(Object.values(state.sessions), ["sess_1"]);
  });

  it("reaches a profile under /p/<profile>", async () => {
    const { chips, hermes } = await rig({ profile: "alice" });
    await chips.say("hello");
    await sent(chips, "run.completed");
    assert.equal(hermes.started[0]?.profile, "alice");
  });

  it("counts a sub-agent as a step with its cost", async () => {
    const { chips } = await rig();
    await chips.say("delegate the quotes");
    const step = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.equal(step.payload["tool"], "delegate_task");
    assert.equal(step.payload["summary"], "Three quotes found.");
    const cost = await sent(chips, "usage", (event) => event.payload["model"] === "heron-mini");
    assert.deepEqual(cost.payload["cost"], { usd: 0.02, estimated: true });
    assert.equal(cost.payload["output_tokens"], undefined);
  });

  it("fails when Hermes does, saying why", async () => {
    const { chips } = await rig();
    await chips.say("fail");
    const failed = await sent(chips, "run.failed");
    assert.equal(failed.payload["error"], "Hermes: The model refused.");
  });

  it("reads the end of a run whose stream was lost", async () => {
    const { chips } = await rig();
    await chips.say("drop the line");
    const words = await sent(chips, "message.post", (event) => event.run_id !== null);
    assert.equal(words.payload["text"], "Here is the answer.");
    await sent(chips, "run.completed");
  });
});

// Chips offered "Not right?" on an agent's message, and Hermes's agents never heard it (ADR 0200).
describe("a reply a person says wasn't right (Chips ADR 0200)", () => {
  const NOTE = "Missed what I asked. Sunday is our flight home.";
  const AGAIN = "Sunday it is: I moved the plan to Sunday, your flight home.";

  /** The owner's "Not right?" on a message, as Chips hands it to the harness whose message it is. */
  function notRight(
    chips: FakeChips,
    messageId: string,
    what: { kind: "correction"; text: string } | { kind: "reaction"; reaction: string },
    spaceId = chips.address.spaceId,
  ): Promise<StoredEvent> {
    const { participantId, displayName } = chips.workspace.owner;
    return chips.asOwner({
      type: "feedback",
      space_id: spaceId,
      message_id: messageId,
      ...what,
      from: { participant_id: participantId, kind: "person", display_name: displayName, role: "owner" },
    });
  }

  /** The agent's answer to a first message, by the id a person's phone names it with. */
  async function answered(chips: FakeChips): Promise<string> {
    await chips.say("summarise the notes");
    const words = await sent(chips, "message.post", (event) => event.run_id !== null);
    await sent(chips, "run.completed");
    return messageIdOf(words.id);
  }

  /** The run started after an event, and its end. */
  async function ranAfter(chips: FakeChips, after: StoredEvent): Promise<StoredEvent> {
    const started = await sent(chips, "run.started", (event) => event.seq > after.seq);
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
    return started;
  }

  it("is a turn of the agent that said it, in its session there, its new answer a run in the room", async () => {
    const { chips, agentId, hermes } = await rig();
    const messageId = await answered(chips);
    const given = await notRight(chips, messageId, { kind: "correction", text: NOTE });
    const started = await ranAfter(chips, given);
    assert.equal(started.actor.id, agentId, "the agent that said it");
    assert.equal(started.payload["goal"], `Looking again: ${NOTE}`);
    assert.deepEqual(hermes.started.map((run) => run.sessionId), ["sess_1", "sess_1"], "the session it answered in");
    const told = hermes.started[1]?.input ?? "";
    // Its words name who gave the note, so they don't open with the name again ("Owner: Owner says").
    const who = chips.workspace.owner.displayName;
    // Any other turn's words say who with their standing in the workspace (Chips SEC-15).
    const named = `${who} (owner): `;
    assert.ok(told.startsWith(`${who} says your reply in this space wasn't right.\n\nYour reply:\n«Here is the answer.»`), told);
    assert.ok(!told.includes(named), told);
    assert.ok((hermes.started[0]?.input ?? "").endsWith(`${named}summarise the notes`), "as any other turn's do");
    assert.ok(told.includes(`What wasn't right: «${NOTE}»`), told);
    // Nothing in the room but its new answer: Chips draws the note under the bubble itself.
    const said = chips.workspace.log.filter((event) => event.type === "message.post" && event.seq > given.seq);
    assert.deepEqual(
      said.map((event) => [event.run_id, event.payload["text"]]),
      [[started.run_id, AGAIN]],
    );
  });

  it("goes to the agent that said it beside another in the room, in that agent's own session", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const { client, hermes, state } = await rig({ chips });
    const room = await chips.openRoom("Plans");
    for (const name of ["Nova", "Vega"]) {
      const { askId } = await chips.askForAgent(room, name);
      await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    }
    const vega = (await client.agents.list()).find((agent) => agent.name === "Vega")?.agentId ?? "";
    await chips.say("summarise the notes", room);
    await until(() => chips.workspace.log.filter((event) => event.type === "run.completed").length === 2);
    const words = chips.workspace.log.find((event) => event.type === "message.post" && event.actor.id === vega);
    assert.ok(words !== undefined, "Vega answered");
    const given = await notRight(chips, messageIdOf(words.id), { kind: "correction", text: NOTE }, room);
    const started = await ranAfter(chips, given);
    assert.equal(started.actor.id, vega);
    assert.equal(hermes.started.at(-1)?.sessionId, state.sessions[`${vega}|${room}`], "Vega's session, not Nova's");
  });

  it("does nothing for a 👍, another emoji, or a note with no words", async () => {
    const { chips, hermes } = await rig();
    const messageId = await answered(chips);
    await notRight(chips, messageId, { kind: "reaction", reaction: "👍" });
    await notRight(chips, messageId, { kind: "reaction", reaction: "🎉" });
    await notRight(chips, messageId, { kind: "correction", text: "  " });
    // The next message's turn is the next there is: none came between.
    const next = await chips.say("one more");
    await ranAfter(chips, next);
    assert.equal(hermes.started.length, 2);
    assert.match(hermes.started[1]?.input ?? "", /one more$/);
  });

  it("looks again at a bare 👎, from an older phone, without a note", async () => {
    const { chips, hermes } = await rig();
    const messageId = await answered(chips);
    const given = await notRight(chips, messageId, { kind: "reaction", reaction: "👎" });
    const started = await ranAfter(chips, given);
    assert.equal(started.payload["goal"], "Looking again at its reply");
    const told = hermes.started[1]?.input ?? "";
    assert.ok(told.includes("Your reply:\n«Here is the answer.»"), told);
    assert.ok(told.includes("They didn't say what. Read your reply again and find what was wrong."), told);
    assert.doesNotMatch(told, /What wasn't right/);
  });

  it("takes one turn for an event heard twice", async () => {
    // The bridge's own feedback handlers, so the same event can be handed over again, as a replay does.
    const handlers: ((event: Feedback) => void)[] = [];
    const chipsFor = (client: Chips): Chips =>
      new Proxy(client, {
        get(target, name) {
          if (name === "on") {
            return (type: "feedback", handler: (event: Feedback) => void) => {
              if (type === "feedback") handlers.push(handler);
              return target.on(type, handler);
            };
          }
          const value: unknown = Reflect.get(target, name);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const { chips, client, hermes } = await rig({ chipsFor });
    const messageId = await answered(chips);
    const heard: Feedback[] = [];
    client.on("feedback", (event) => void heard.push(event));
    const given = await notRight(chips, messageId, { kind: "correction", text: NOTE });
    await until(() => heard.length === 1);
    assert.equal(handlers.length, 1, "the bridge's own handler");
    for (const handler of handlers) handler(heard[0] as Feedback);
    await ranAfter(chips, given);
    const next = await chips.say("one more");
    await ranAfter(chips, next);
    assert.equal(hermes.started.filter((run) => run.input.includes("wasn't right")).length, 1);
    assert.equal(hermes.started.length, 3);
  });

  it("is the default agent's turn, without the reply, when the room doesn't have the message", async () => {
    const { chips, agentId, hermes } = await rig();
    await answered(chips);
    const given = await notRight(chips, newId("message"), { kind: "correction", text: "That was wrong." });
    const started = await ranAfter(chips, given);
    assert.equal(started.actor.id, agentId, "the default agent");
    assert.equal(hermes.started[1]?.sessionId, hermes.started[0]?.sessionId, "in its session there");
    const told = hermes.started[1]?.input ?? "";
    assert.doesNotMatch(told, /Your reply:/);
    assert.ok(told.includes("What wasn't right: «That was wrong.»"), told);
  });

  it("shows at most 1500 characters of the reply, and gives the bubble at most 120 of the note", () => {
    const shown = /«(.*?)»/s.exec(lookAgain("Ana", "a".repeat(2000), "Wrong."))?.[1] ?? "";
    assert.deepEqual([shown.length, shown.at(-1)], [1500, "…"]);
    const goal = lookingAgain(`\n${"b".repeat(200)}\nmore`);
    assert.deepEqual([goal.length, goal.startsWith("Looking again: bbb"), goal.at(-1)], [120, true, "…"]);
    assert.equal(lookingAgain(undefined), "Looking again at its reply");
  });
});

describe("what it asks", () => {
  it("asks on a card, and gives Hermes a command's Always as once (Chips ADR 0239)", async () => {
    const { chips, hermes } = await rig();
    await chips.say("ask first");
    const asked = await sent(chips, "approval.request");
    assert.equal(asked.payload["question"], "Allow it to run the tests?");
    assert.deepEqual(asked.payload["action"], { kind: "shell.exec", input: { command: "npm test", description: "Run the tests" } });
    await chips.decide(String(asked.payload["approval_id"]), "approved", { scope: "always" });
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    // Chips remembers how the command starts and answers the next one itself.
    assert.equal(words.payload["text"], "Given: once");
    const executed = await sent(chips, "approval.executed");
    assert.equal(executed.payload["outcome"], "executed", "the allowed call said how it went");
    assert.deepEqual(hermes.answers, [{ choice: "once", request_id: "req_1" }]);
    // What the command printed, not the JSON Hermes's terminal wraps it in.
    const ran = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.equal(ran.payload["summary"], "12 passed");
  });

  it("gives Hermes deny when a person says no", async () => {
    const { chips } = await rig();
    await chips.say("ask first");
    const asked = await sent(chips, "approval.request");
    await chips.decide(String(asked.payload["approval_id"]), "denied");
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: deny");
    const stopped = await sent(chips, "step.log", (event) => event.payload["status"] === "failed");
    assert.equal(stopped.payload["summary"], "denied");
  });

  it("settles a card answered in Hermes's own tools", async () => {
    const { chips } = await rig();
    await chips.say("clean up, answered elsewhere");
    const asked = await sent(chips, "approval.request");
    const settled = await sent(chips, "approval.resolved", (event) => event.payload["approval_id"] === asked.payload["approval_id"]);
    assert.deepEqual(
      [settled.payload["decision"], settled.payload["scope"], settled.payload["reason"]],
      ["approved", "once", "Answered in Hermes."],
    );
  });

  it("picks the scope Hermes offers, else once", () => {
    const decision = (scope: Decision["scope"], allowed = true) => ({ allowed, scope }) as Decision;
    assert.equal(choiceOf(decision("always"), ["once", "session", "deny"]), "session");
    assert.equal(choiceOf(decision("session"), ["once", "deny"]), "once");
    assert.equal(choiceOf(decision("once", false), ["once", "deny"]), "deny");
    // A command's Always or This session is Hermes's once: Chips remembers its starts (ADR 0239).
    assert.equal(choiceOf(decision("always"), ["once", "session", "always", "deny"], true), "once");
    assert.equal(choiceOf(decision("session"), ["once", "session", "deny"], true), "once");
    assert.equal(choiceOf(decision("always", false), ["once", "deny"], true), "deny");
  });
});

describe("what a person does to it", () => {
  it("stops Hermes's run when a person stops the Chips run", async () => {
    const { chips, hermes } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => hermes.started.length > 0);
    await chips.asOwner({ type: "run.cancel", space_id: started.space_id, run_id: started.run_id });
    await until(() => hermes.stops.length > 0);
    assert.deepEqual(hermes.stops, ["run_1"]);
  });

  it("steers Hermes's run while it goes", async () => {
    const { chips, hermes } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => hermes.started.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await chips.asOwner({ type: "run.steer", space_id: started.space_id, run_id: started.run_id, text: "Shorter, please.", mode: "steer" });
    await until(() => hermes.steers.length > 0);
    assert.match(hermes.steers[0] ?? "", /adds: Shorter, please\.$/);
  });
});

describe("an interrupt", () => {
  it("stops Hermes's run and goes on with the person's words", async () => {
    const { chips, hermes } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => hermes.started.length > 0);
    await chips.asOwner({ type: "run.steer", space_id: started.space_id, run_id: started.run_id, text: "Just summarise.", mode: "interrupt" });
    await until(() => hermes.started.length === 2);
    assert.deepEqual(hermes.stops, ["run_1"]);
    assert.match(hermes.started[1]?.input ?? "", /adds: Just summarise\.$/);
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
  });
});

describe("its health", () => {
  it("says it is in trouble while Hermes doesn't answer, and fine once it does", async () => {
    const { chips, hermes } = await rig();
    hermes.up = false;
    await until(() => chips.statuses().some((status) => status.state === "trouble"));
    assert.match(chips.statuses().at(-1)?.reason ?? "", /Hermes isn't answering for Hermes/);
    hermes.up = true;
    await until(() => chips.statuses().at(-1)?.state === "ok");
  });

  it("says nothing while Hermes's gateway restarts, then how the restart went (Chips ADR 0094)", async () => {
    const { chips, hermes, bridge } = await rig();
    await until(() => chips.statuses().at(-1)?.state === "ok");
    bridge.hold(true);
    const before = chips.statuses().length;
    hermes.up = false;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(chips.statuses().length, before, "the watch is held");
    // It failed: its words, which stand while Hermes doesn't answer, in place of the watch's own.
    await bridge.restarted("Hermes's gateway started, but nothing answers on port 8642.");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(chips.statuses().length > before + 1, "the watch speaks again");
    assert.deepEqual(
      [...new Set(chips.statuses().slice(before).map((status) => status.reason))],
      ["Hermes's gateway started, but nothing answers on port 8642."],
    );
    hermes.up = true;
    await until(() => chips.statuses().at(-1)?.state === "ok");
    // Fine: said at once, as the gateways are.
    bridge.hold(true);
    const now = chips.statuses().length;
    await bridge.restarted(undefined);
    assert.equal(chips.statuses()[now]?.state, "ok");
  });
});

describe("its Restart (Chips ADR 0094)", () => {
  it("asks for restarts when it joins with a code", () => {
    assert.ok(WANTS.includes("restarts"), "so Chips offers Restart on its page");
  });
});

// Hermes's agents had no Model group: its model list wasn't asked for (Chips ADRs 0141, 0241).
describe("an agent's model (Chips ADR 0141)", () => {
  /** A person's pick on an agent's page, as Chips sends it. */
  const pick = (r: Rig, agentId: string, model: string | null): ModelChangeFrame => ({
    frame: "model.change",
    change_id: newId("change"),
    harness_id: r.client.harnessId,
    agent_id: agentId,
    model,
    effort: null,
    asked_by: r.chips.workspace.owner.participantId,
    asked_at: new Date().toISOString(),
  });

  it("shows the models Hermes has for the agent's profile, and Hermes's default", async () => {
    const r = await rig();
    await until(() => r.chips.settings.copy("model", r.agentId) !== undefined);
    assert.deepEqual(r.chips.settings.copy("model", r.agentId), {
      model: "fake/heron-2",
      own: false,
      default: { label: "Hermes's default", model: "fake/heron-2" },
      choices: [
        { id: "fake/heron-2", label: "heron-2 · Fake", efforts: [] },
        { id: "fake/heron-mini", label: "heron-mini · Fake", efforts: [] },
        { id: "kite/kite-1", label: "kite-1 · Kite", efforts: [] },
      ],
      editable: true,
    });
    assert.deepEqual([...new Set(r.hermes.optionsAsked)], ["default"]);
    assert.ok(WANTS.includes("models"), "so Chips shows Hermes's agents a Model group");
  });

  it("asks each of the agent's runs for the model a person picked, and Hermes's default again for none", async () => {
    const r = await rig();
    await until(() => r.chips.settings.copy("model", r.agentId) !== undefined);
    const picked = await r.bridge.onModelChange(pick(r, r.agentId, "kite/kite-1"));
    assert.deepEqual([picked.model, picked.own], ["kite/kite-1", true]);
    assert.equal(r.state.models?.[r.agentId], "kite/kite-1");
    await r.chips.say("plan the trip");
    await until(() => r.hermes.started.length === 1);
    assert.deepEqual([r.hermes.started[0]?.provider, r.hermes.started[0]?.model], ["kite", "kite-1"]);
    await sent(r.chips, "run.completed");
    const back = await r.bridge.onModelChange(pick(r, r.agentId, null));
    assert.deepEqual([back.model, back.own], ["fake/heron-2", false]);
    const asked = await r.chips.say("and the hotel");
    await sent(r.chips, "run.completed", (event) => event.seq > asked.seq);
    assert.deepEqual([r.hermes.started[1]?.provider, r.hermes.started[1]?.model], [undefined, undefined]);
  });

  it("changes nothing for the model the agent runs on, and refuses one Hermes doesn't have for its profile", async () => {
    const r = await rig();
    await until(() => r.chips.settings.copy("model", r.agentId) !== undefined);
    const same = await r.bridge.onModelChange(pick(r, r.agentId, "fake/heron-2"));
    assert.deepEqual([same.model, same.own, r.state.models], ["fake/heron-2", false, undefined]);
    await assert.rejects(r.bridge.onModelChange(pick(r, r.agentId, "gone/gone-1")), (error: Refuse) => {
      assert.equal(error.message, "Hermes has no gone/gone-1 for this agent's profile.");
      assert.equal((error.copy as { model?: string }).model, "fake/heron-2");
      return true;
    });
    await assert.rejects(r.bridge.onModelChange(pick(r, newId("agent"), "kite/kite-1")), /isn't one of this harness's agents/);
  });

  it("takes a pick for an agent sharing the first profile for that agent alone", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const r = await rig({ chips });
    const room = await chips.openRoom("Plans");
    const { askId } = await chips.askForAgent(room, "Nova");
    const joined = await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const nova = String(joined.payload["participant_id"]);
    await until(() => chips.settings.copy("model", nova) !== undefined);
    await r.bridge.onModelChange(pick(r, nova, "kite/kite-1"));
    const asked = await chips.say("plan the trip", room);
    await sent(chips, "run.completed", (event) => event.seq > asked.seq);
    const home = await chips.say("hello");
    await sent(chips, "run.completed", (event) => event.seq > home.seq);
    assert.deepEqual(
      r.hermes.started.map((each) => [each.profile, each.model]),
      [
        ["default", "kite-1"],
        ["default", undefined],
      ],
    );
    assert.equal(chips.settings.copy("model", r.agentId)?.["own"], false, "the Main agent's is its own");
  });

  it("shows a model the config names as the agent's own, and asks for it alone as before", async () => {
    const r = await rig({ model: "heron-mini" });
    await until(() => r.chips.settings.copy("model", r.agentId) !== undefined);
    const copy = r.chips.settings.copy("model", r.agentId);
    assert.deepEqual([copy?.["model"], copy?.["own"]], ["fake/heron-mini", true]);
    await r.chips.say("hello");
    await sent(r.chips, "run.completed");
    assert.deepEqual([r.hermes.started[0]?.provider, r.hermes.started[0]?.model], [undefined, "heron-mini"]);
  });
});
