/**
 * The bridge between Chips's conformance fake — the wire as Chips speaks it, every event checked
 * against the protocol's schemas — and a scripted Hermes API server.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect, type Decision } from "@chipschat/harness";
import { Bridge, type BridgeState, choiceOf, keyOf } from "../src/bridge.ts";
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
  options: { state?: BridgeState; chips?: FakeChips; hermes?: FakeHermes; profile?: string; model?: string } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: ["agents"] }));
  if (options.chips === undefined) open.push(() => chips.close());
  const hermes = options.hermes ?? (await startFakeHermes());
  if (options.hermes === undefined) open.push(() => hermes.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const state = options.state ?? { sessions: {} };
  const address = { url: hermes.url, key: hermes.key, profile: options.profile ?? AGENT.profile };
  const bridge = new Bridge({
    chips: client,
    agents: [{ name: AGENT.name, address, ...(options.model === undefined ? {} : { model: options.model }) }],
    home: chips.address.spaceId,
    state,
    saveState: () => undefined,
    healthEveryMs: 50,
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  const agents = await client.agents.list();
  const agentId = agents.find((each) => each.key === keyOf({ name: AGENT.name, address }))?.agentId ?? "";
  return { chips, client, bridge, hermes, state, agentId };
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
  });

  it("gives Hermes deny when a person says no", async () => {
    const { chips } = await rig();
    await chips.say("ask first");
    const asked = await sent(chips, "approval.request");
    await chips.decide(String(asked.payload["approval_id"]), "denied");
    const words = await sent(chips, "message.post", (event) => event.run_id === asked.run_id);
    assert.equal(words.payload["text"], "Given: deny");
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
