/**
 * The bridge between Chips's conformance fake — the wire as Chips speaks it, every event checked
 * against the protocol's schemas — and a scripted Hermes API server.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect, type Decision } from "@chipschat/harness";
import { type Feedback, messageIdOf, newId } from "@chipschat/protocol";
import { Bridge, type BridgeState, choiceOf, freeFolder, keyOf, lookAgain, lookingAgain } from "../src/bridge.ts";
import { type FakeHermes, startFakeHermes } from "./fake-hermes.ts";

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly hermes: FakeHermes;
  readonly state: BridgeState;
  readonly agentId: string;
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
    /** What the bridge is handed in the client's place: a test's tap on it. */
    chipsFor?: (client: Chips) => Chips;
  } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: ["agents"] }));
  if (options.chips === undefined) open.push(() => chips.close());
  const hermes = options.hermes ?? (await startFakeHermes());
  if (options.hermes === undefined) open.push(() => hermes.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const state = options.state ?? { sessions: {} };
  const address = { url: hermes.url, key: hermes.key, profile: options.profile ?? AGENT.profile };
  const bridge = new Bridge({
    chips: options.chipsFor?.(client) ?? client,
    agents: [
      {
        name: AGENT.name,
        address,
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.folder === undefined ? {} : { folder: options.folder }),
      },
    ],
    home: chips.address.spaceId,
    ...(options.folders === undefined ? {} : { folders: options.folders }),
    state,
    saveState: () => undefined,
    healthEveryMs: 50,
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  return { chips, client, bridge, hermes, state, agentId: bridge.mainAgentId ?? "" };
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

describe("a turn", () => {
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
    assert.ok(told.startsWith(`${who} says your reply in this room wasn't right.\n\nYour reply:\n«Here is the answer.»`), told);
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
  it("asks on a card, and gives Hermes the person's always", async () => {
    const { chips, hermes } = await rig();
    await chips.say("ask first");
    const asked = await sent(chips, "approval.request");
    assert.equal(asked.payload["question"], "Allow it to run the tests?");
    assert.deepEqual(asked.payload["action"], { kind: "shell.exec", input: { command: "npm test", description: "Run the tests" } });
    await chips.decide(String(asked.payload["approval_id"]), "approved", { scope: "always" });
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: always");
    const executed = await sent(chips, "approval.executed");
    assert.equal(executed.payload["outcome"], "executed", "the allowed call said how it went");
    assert.deepEqual(hermes.answers, [{ choice: "always", request_id: "req_1" }]);
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
});
