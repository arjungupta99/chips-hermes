/**
 * An agent's page in Chips (Chips ADRs 0134, 0146, 0238): the files Hermes builds each agent from,
 * edited there and saved as Hermes saves them, and how full its context is, from the readings
 * Hermes's webhook sends. Against Chips's conformance fake and the scripted Hermes, with Hermes's
 * own files in a temporary home: a test never reads or writes the real ~/.hermes.
 */

import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { newId } from "@chipschat/protocol";
import { Bridge, type BridgeState, settingsFor } from "../src/bridge.ts";
import { hashOf, READ_NOTE, withLock } from "../src/context.ts";
import { WHY_NOT, whyReadOnly } from "../src/fills.ts";
import { SECRET_ENV } from "../src/hooks.ts";
import type { ProfileMaker } from "../src/profiles.ts";
import { type FakeHermes, fakeProfiles, startFakeHermes } from "./fake-hermes.ts";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

const SECRET = "test-hook-secret";
const MEMORY = "Arjun likes tea\n§\nThe build runs on Fridays";

/** Hermes's own files, as a profile that has run a while has them, in a temporary home. */
function hermesHome(): { root: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "chips-hermes-root-"));
  const work = mkdtempSync(join(tmpdir(), "chips-hermes-work-"));
  writeFileSync(join(root, "SOUL.md"), "You are Hermes.\n");
  writeFileSync(join(root, "config.yaml"), `model:\n  default: heron-2\nterminal:\n  cwd: ${work}\n`);
  writeFileSync(join(root, ".env"), `API_SERVER_KEY=k\n${SECRET_ENV}=${SECRET}\n`);
  mkdirSync(join(root, "memories"));
  writeFileSync(join(root, "memories", "MEMORY.md"), MEMORY);
  writeFileSync(join(work, "AGENTS.md"), "Keep answers short.\n");
  mkdirSync(join(root, "profiles", "alice"), { recursive: true });
  writeFileSync(join(root, "profiles", "alice", "SOUL.md"), "You are Alice.\n");
  return { root, work };
}

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly hermes: FakeHermes;
  readonly state: BridgeState;
  readonly root: string;
  readonly mainId: string;
  readonly aliceId: string;
  readonly logs: string[];
}

async function rig(
  options: { root?: string; state?: BridgeState; hermes?: FakeHermes; chips?: FakeChips; profiles?: ProfileMaker } = {},
): Promise<Rig> {
  const chips =
    options.chips ??
    (await startFakeChips({ capabilities: ["agents", "new_agents", "forks", "context_files", "context_windows"] }));
  if (options.chips === undefined) open.push(() => chips.close());
  const hermes = options.hermes ?? (await startFakeHermes());
  if (options.hermes === undefined) open.push(() => hermes.close());
  const root = options.root ?? hermesHome().root;
  const state = options.state ?? { sessions: {} };
  const logs: string[] = [];
  let bridge: Bridge | undefined;
  const client = await connect({
    url: chips.address.url,
    token: chips.address.token,
    settings: settingsFor(() => bridge),
  });
  const address = { url: hermes.url, key: hermes.key };
  bridge = new Bridge({
    chips: client,
    agents: [
      { name: "Hermes", address: { ...address, profile: "default" } },
      { name: "Alice", address: { ...address, profile: "alice" } },
    ],
    home: chips.address.spaceId,
    state,
    saveState: () => undefined,
    healthEveryMs: 50,
    hermesRoot: root,
    env: {},
    fills: { port: state.fills?.port ?? 0, secret: "unused-fallback" },
    fillsEveryMs: 0,
    log: (line) => void logs.push(line),
    ...(options.profiles === undefined ? {} : { profiles: options.profiles }),
  });
  const started = bridge;
  open.push(async () => {
    started.stop();
    client.close();
  });
  await bridge.start();
  hermes.hook = { url: (profile) => started.hookUrl(profile), secret: SECRET };
  const agents = await client.agents.list();
  return {
    chips,
    client,
    bridge,
    hermes,
    state,
    root,
    mainId: bridge.mainAgentId ?? "",
    aliceId: agents.find((agent) => agent.name === "Alice")?.agentId ?? "",
    logs,
  };
}

async function until<T>(read: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const by = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > by) throw new Error(`not so within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type File = Record<string, unknown> & { name: string; text?: string; hash?: string };

const harnessSet = (r: Rig) => r.chips.settings.copy("harness-context", r.client.harnessId) as { shared: File[] } | undefined;
const agentFiles = (r: Rig, agentId: string) =>
  r.chips.settings.copy("context", agentId) as { files: File[]; read_note?: string } | undefined;
const windowOf = (r: Rig, agentId: string) => r.chips.settings.copy("context-window", agentId);
const fileIn = (files: readonly File[] | undefined, name: string) => files?.find((file) => file.name === name);

/** A person's edit, as Chips sends it down the socket, heard by the SDK, which answers it. */
async function edit(r: Rig, name: string, text: string, baseHash: string | null, agentId?: string) {
  const editId = newId("edit");
  await r.client.settings.hear({
    frame: "context.edit",
    edit_id: editId,
    harness_id: r.client.harnessId,
    ...(agentId === undefined ? {} : { agent_id: agentId }),
    name,
    text,
    base_hash: baseHash,
    asked_by: newId("person"),
    asked_at: new Date().toISOString(),
  });
  return await until(() => r.chips.settings.answerTo(editId));
}

/** A person's ask of an agent's context window, heard by the SDK, which answers it. */
async function ask(r: Rig, agentId: string, frame: "context_window.compact" | "context_window.change") {
  const changeId = newId("change");
  await r.client.settings.hear({
    frame,
    change_id: changeId,
    harness_id: r.client.harnessId,
    agent_id: agentId,
    ...(frame === "context_window.change" ? { at: 75 } : {}),
    asked_by: newId("person"),
    asked_at: new Date().toISOString(),
  });
  return await until(() => r.chips.settings.answerTo(changeId));
}

/** A message to the Main agent in its room, answered: its run there ended. */
async function talk(r: Rig, text: string): Promise<void> {
  const ended = () => r.chips.workspace.log.filter((event) => event.type === "run.completed").length;
  const before = ended();
  await r.chips.say(text);
  await until(() => ended() > before);
}

describe("an agent's context (Chips ADR 0134)", () => {
  it("lists what Hermes gives each agent: the first profile's files and the project file as the harness's own set", async () => {
    const r = await rig();
    const set = await until(() => harnessSet(r));
    assert.deepEqual(
      set.shared.map((file) => [file.name, file["title"], file["used_by"], file["for_new_agents"]]),
      [
        ["SOUL.md", "Who it is", 1, true],
        ["AGENTS.md", "Project instructions", 1, true],
        ["USER.md", "About you", 1, true],
        ["MEMORY.md", "Memory", 1, true],
      ],
    );
    assert.equal(fileIn(set.shared, "SOUL.md")?.text, "You are Hermes.\n");
    assert.equal(fileIn(set.shared, "MEMORY.md")?.text, MEMORY);
    assert.equal(fileIn(set.shared, "MEMORY.md")?.hash, hashOf(MEMORY));
    assert.match(String(fileIn(set.shared, "MEMORY.md")?.["about"]), /up to 2,200 characters\. A line with only § starts the next entry\./);
    // The Main agent reads them from the set, which no agent gets its own of.
    const main = await until(() => agentFiles(r, r.mainId));
    assert.deepEqual(
      main.files.map((file) => [file.name, file["shared"], file["replaceable"], file.text]),
      [
        ["SOUL.md", "default-soul", false, undefined],
        ["AGENTS.md", "default-project", false, undefined],
        ["USER.md", "default-user", false, undefined],
        ["MEMORY.md", "default-memory", false, undefined],
      ],
    );
    assert.equal(main.read_note, READ_NOTE);
    // Alice alone reads her profile's files: they are her own, the empty memory files among them.
    const alice = await until(() => agentFiles(r, r.aliceId));
    assert.deepEqual(
      alice.files.map((file) => [file.name, file.text, file["editable"]]),
      [
        ["SOUL.md", "You are Alice.\n", true],
        ["USER.md", "", true],
        ["MEMORY.md", "", true],
      ],
    );
    // Its hello says it takes edits and window asks.
    assert.ok((r.chips.askToChange("harness-context", r.client.harnessId)?.heard ?? 0) > 0);
  });

  it("counts a new agent asked for in a room among the readers of the first profile's files", async () => {
    const r = await rig();
    const spaceId = await r.chips.openRoom("Fresh eyes");
    const { askId } = await r.chips.askForAgent(spaceId, "Nova");
    const joined = await r.chips.waitFor(
      (event) => (event.type === "membership.added" && event.payload["made_for"] === askId ? event : undefined),
      3000,
    );
    const novaId = (await r.client.agents.list()).find((agent) => agent.name === "Nova")?.agentId ?? "";
    assert.ok(joined !== undefined && novaId !== "");
    const set = await until(() => {
      const now = harnessSet(r);
      return fileIn(now?.shared, "SOUL.md")?.["used_by"] === 2 && now;
    });
    assert.equal(fileIn(set.shared, "MEMORY.md")?.["used_by"], 2);
    const nova = await until(() => agentFiles(r, novaId));
    assert.deepEqual(
      nova.files.map((file) => [file.name, file["shared"], file["replaceable"]]),
      [
        ["SOUL.md", "default-soul", false],
        ["AGENTS.md", "default-project", false],
        ["USER.md", "default-user", false],
        ["MEMORY.md", "default-memory", false],
      ],
    );
  });

  it("gives a new agent with a profile of its own its own files, and the Main agent its own memory (Chips ADR 0241)", async () => {
    const { root } = hermesHome();
    const r = await rig({ root, profiles: fakeProfiles(root) });
    r.hermes.root = root;
    const spaceId = await r.chips.openRoom("Fresh eyes");
    const { askId } = await r.chips.askForAgent(spaceId, "Nova");
    const joined = await r.chips.waitFor(
      (event) => (event.type === "membership.added" && event.payload["made_for"] === askId ? event : undefined),
      3000,
    );
    const novaId = String(joined.payload["participant_id"]);
    const nova = await until(() => {
      const now = agentFiles(r, novaId);
      return fileIn(now?.files, "SOUL.md")?.text !== undefined && now;
    });
    // Its SOUL.md a copy of the Main agent's, its memory empty, both its own; the project file the gateway's.
    assert.deepEqual(
      nova.files.map((file) => [file.name, file.text, file["shared"]]),
      [
        ["SOUL.md", "You are Hermes.\n", undefined],
        ["AGENTS.md", undefined, "default-project"],
        ["USER.md", "", undefined],
        ["MEMORY.md", "", undefined],
      ],
    );
    // What a new agent starts with: the Main agent's SOUL.md and the project file, not its memory.
    const set = await until(() => harnessSet(r));
    assert.deepEqual(
      set.shared.map((file) => [file.name, file["used_by"], file["for_new_agents"]]),
      [
        ["SOUL.md", 1, true],
        ["AGENTS.md", 2, true],
      ],
    );
    const main = await until(() => agentFiles(r, r.mainId));
    assert.equal(fileIn(main.files, "MEMORY.md")?.text, MEMORY, "the Main agent's own");
  });

  it("shares a profile's files once a fork reads them too, under names of their own", async () => {
    const r = await rig();
    // Alice in a room, the Main agent's, so a person can ask for a copy of her.
    await r.client.agents.attach(r.aliceId, { spaceId: r.chips.address.spaceId, replacing: r.mainId });
    await r.chips.askForFork(r.aliceId, await r.chips.openRoom("Alice's other room"));
    const set = await until(() => {
      const now = harnessSet(r);
      return fileIn(now?.shared, "SOUL.md (alice)") !== undefined && now;
    });
    assert.equal(fileIn(set.shared, "SOUL.md (alice)")?.["used_by"], 2);
    assert.equal(fileIn(set.shared, "SOUL.md (alice)")?.text, "You are Alice.\n");
    assert.equal(fileIn(set.shared, "SOUL.md (alice)")?.["for_new_agents"], undefined);
    const alice = await until(() => {
      const now = agentFiles(r, r.aliceId);
      return fileIn(now?.files, "SOUL.md (alice)") !== undefined && now;
    });
    assert.equal(fileIn(alice.files, "SOUL.md (alice)")?.["shared"], "alice-soul");
  });

  it("saves an edit of who it is where Hermes reads it, and answers with the copy", async () => {
    const r = await rig();
    const set = await until(() => harnessSet(r));
    const answer = await edit(r, "SOUL.md", "You are Hermes. Be brief.\n", fileIn(set.shared, "SOUL.md")?.hash ?? "");
    assert.equal(answer.made, true, answer.message);
    assert.equal(readFileSync(join(r.root, "SOUL.md"), "utf8"), "You are Hermes. Be brief.\n");
    assert.equal(fileIn(harnessSet(r)?.shared, "SOUL.md")?.text, "You are Hermes. Be brief.\n");
    // Alice's, her own, from her page.
    const alice = await until(() => agentFiles(r, r.aliceId));
    const hers = await edit(r, "SOUL.md", "You are Alice, a tester.\n", fileIn(alice.files, "SOUL.md")?.hash ?? "", r.aliceId);
    assert.equal(hers.made, true, hers.message);
    assert.equal(readFileSync(join(r.root, "profiles", "alice", "SOUL.md"), "utf8"), "You are Alice, a tester.\n");
  });

  it("saves a memory edit as Hermes keeps one, its entries apart by §, under Hermes's lock", async () => {
    const r = await rig();
    const set = await until(() => harnessSet(r));
    const text = "Arjun likes tea\n\n§\n\nThe build runs on Fridays  \n§\nHe moved to Lisbon\n§\nArjun likes tea";
    const answer = await edit(r, "MEMORY.md", text, fileIn(set.shared, "MEMORY.md")?.hash ?? "");
    assert.equal(answer.made, true, answer.message);
    const saved = "Arjun likes tea\n§\nThe build runs on Fridays\n§\nHe moved to Lisbon";
    assert.equal(readFileSync(join(r.root, "memories", "MEMORY.md"), "utf8"), saved);
    assert.ok(existsSync(join(r.root, "memories", "MEMORY.md.lock")), "locked as Hermes locks it");
    assert.equal(fileIn(harnessSet(r)?.shared, "MEMORY.md")?.text, saved);
    // A memory file Hermes hasn't written yet is made, in a folder it hasn't made yet.
    const alice = await until(() => agentFiles(r, r.aliceId));
    const user = await edit(r, "USER.md", "Arjun is an engineer", fileIn(alice.files, "USER.md")?.hash ?? "", r.aliceId);
    assert.equal(user.made, true, user.message);
    assert.equal(readFileSync(join(r.root, "profiles", "alice", "memories", "USER.md"), "utf8"), "Arjun is an engineer");
  });

  it("refuses an edit of a file Hermes changed since, and shows what is there now", async () => {
    const r = await rig();
    const set = await until(() => harnessSet(r));
    const before = fileIn(set.shared, "MEMORY.md")?.hash ?? "";
    // Hermes's memory review wrote meanwhile.
    writeFileSync(join(r.root, "memories", "MEMORY.md"), `${MEMORY}\n§\nHe moved to Lisbon`);
    const answer = await edit(r, "MEMORY.md", "Only this", before);
    assert.equal(answer.made, false);
    assert.equal(readFileSync(join(r.root, "memories", "MEMORY.md"), "utf8"), `${MEMORY}\n§\nHe moved to Lisbon`);
    assert.equal(fileIn(harnessSet(r)?.shared, "MEMORY.md")?.text, `${MEMORY}\n§\nHe moved to Lisbon`);
  });

  it("refuses a memory edit that would break Hermes's entries or its limit, saying why", async () => {
    const r = await rig();
    const set = await until(() => harnessSet(r));
    const hash = fileIn(set.shared, "MEMORY.md")?.hash ?? "";
    const tooMuch = await edit(r, "MEMORY.md", ["a", "b", "c"].map((letter) => letter.repeat(800)).join("\n§\n"), hash);
    assert.equal(tooMuch.made, false);
    assert.equal(tooMuch.message, "That is 2,406 characters, and Hermes keeps its memory to 2,200. Take out 206.");
    assert.equal(readFileSync(join(r.root, "memories", "MEMORY.md"), "utf8"), MEMORY);
    // The limit is the profile's own when its config sets one.
    writeFileSync(join(r.root, "config.yaml"), "memory:\n  user_char_limit: 10 # short\n");
    const user = await edit(r, "USER.md", "Arjun\n§\nLisbon", hashOf(""));
    assert.equal(user.message, "That is 14 characters, and Hermes keeps what it knows of you to 10. Take out 4.");
  });

  it("gives no agent its own copy of a file Hermes shares", async () => {
    const r = await rig();
    await until(() => agentFiles(r, r.mainId));
    const answer = await edit(r, "SOUL.md", "Mine", null, r.mainId);
    assert.equal(answer.made, false);
    assert.equal(answer.message, "Every agent on Hermes's default profile reads the same SOUL.md, so one can't have its own.");
  });

  it("reads the files again after a turn, which may have changed its memory", async () => {
    const r = await rig();
    await until(() => harnessSet(r));
    writeFileSync(join(r.root, "memories", "MEMORY.md"), `${MEMORY}\n§\nHe asked about Lisbon`);
    await talk(r, "hello");
    await until(() => fileIn(harnessSet(r)?.shared, "MEMORY.md")?.text === `${MEMORY}\n§\nHe asked about Lisbon`);
  });

  it("waits for Hermes to let go of its memory's lock before saving", async () => {
    const folder = mkdtempSync(join(tmpdir(), "chips-hermes-lock-"));
    const lock = join(folder, "MEMORY.md.lock");
    const order: string[] = [];
    let held: () => void = () => undefined;
    const holding = withLock(lock, () => {
      order.push("Hermes has it");
      return new Promise<void>((done) => {
        held = done;
      });
    });
    await until(() => order.length === 1);
    const saving = withLock(lock, () => void order.push("the bridge has it"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    order.push("Hermes lets go");
    held();
    await Promise.all([holding, saving]);
    assert.deepEqual(order, ["Hermes has it", "Hermes lets go", "the bridge has it"]);
  });
});

describe("an agent's context window (Chips ADR 0146)", () => {
  it("sends no window before Hermes says how full, then the reading Hermes signed", async () => {
    const r = await rig();
    await until(() => harnessSet(r));
    assert.equal(windowOf(r, r.mainId), undefined, "no number is made up");
    await talk(r, "hello");
    const copy = await until(() => windowOf(r, r.mainId));
    assert.deepEqual(
      { ...copy, as_of: typeof copy["as_of"] },
      {
        used: 2500,
        window: 200_000,
        model: "heron-2",
        as_of: "string",
        compacts: false,
        why_not: WHY_NOT,
        limit: { at: 75, choices: [75], default: 75, may_turn_off: false },
        editable: false,
        why_read_only: "Hermes sets this for every agent on its default profile.",
      },
    );
    // The bridge kept only the numbers.
    assert.ok(!JSON.stringify(r.state).includes("Here is the answer"));
  });

  it("drops a reading whose signature isn't Chips's", async () => {
    const r = await rig();
    const url = r.bridge.hookUrl() ?? "";
    const body = JSON.stringify({
      hook_event_name: "post_api_request",
      session_id: "sess_1",
      extra: { task_id: "sess_1", usage: { prompt_tokens: 9000 }, context_length: 200_000 },
    });
    r.state.sessions[`whoever|${r.chips.address.spaceId}`] = "sess_1";
    const wrong = await fetch(url, { method: "POST", body, headers: { "x-hermes-signature-256": `sha256=${"0".repeat(64)}` } });
    const none = await fetch(url, { method: "POST", body });
    assert.deepEqual([wrong.status, none.status], [401, 401]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(windowOf(r, "whoever"), undefined);
    assert.equal(r.logs.filter((line) => /wasn't signed with Chips's secret/.test(line)).length, 1, "said once");
  });

  it("drops a reading another profile sent to this one's address, as a clone of it does until Hermes starts again", async () => {
    const r = await rig();
    await talk(r, "hello");
    await until(() => windowOf(r, r.mainId));
    const session = Object.values(r.state.sessions)[0] ?? "";
    const body = JSON.stringify({
      hook_event_name: "post_api_request",
      profile: "nova",
      session_id: session,
      extra: { task_id: session, usage: { prompt_tokens: 9000 }, context_length: 200_000 },
    });
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");
    const answer = await fetch(r.bridge.hookUrl() ?? "", { method: "POST", body, headers: { "x-hermes-signature-256": `sha256=${signature}` } });
    assert.equal(answer.status, 204);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(windowOf(r, r.mainId)?.["used"], 2500, "nova's own address has it");
  });

  it("takes a sharp drop in a session for a compaction, and says the turn's peak", async () => {
    const r = await rig();
    await talk(r, "hello");
    r.hermes.fills = [120_000, 150_000, 40_000];
    await talk(r, "read the whole codebase");
    const copy = await until(() => {
      const now = windowOf(r, r.mainId);
      return now?.["used"] === 40_000 && now;
    });
    assert.deepEqual({ ...(copy["last"] as object), at: undefined }, { at: undefined, from: 150_000, to: 40_000, by: "itself" });
    assert.deepEqual({ ...(copy["long_turn"] as object), at: undefined }, { at: undefined, peak: 150_000, folds: 1 });
  });

  it("leaves out Hermes's memory review, which shares the session's id under a task of its own", async () => {
    const r = await rig();
    r.hermes.review = 500;
    await talk(r, "hello");
    await until(() => r.hermes.delivered.length === 2);
    assert.deepEqual(
      r.hermes.delivered.map((each) => each.status),
      [204, 204],
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(windowOf(r, r.mainId)?.["used"], 2500);
    assert.equal(windowOf(r, r.mainId)?.["last"], undefined, "no compaction read into it");
  });

  it("refuses Compact now and a new limit in Hermes's words", async () => {
    const r = await rig();
    await talk(r, "hello");
    await until(() => windowOf(r, r.mainId));
    const compact = await ask(r, r.mainId, "context_window.compact");
    assert.deepEqual([compact.made, compact.message], [false, WHY_NOT]);
    const change = await ask(r, r.mainId, "context_window.change");
    assert.deepEqual([change.made, change.message], [false, whyReadOnly("default")]);
  });

  it("follows the profile's compression settings", async () => {
    const r = await rig();
    writeFileSync(join(r.root, "config.yaml"), "compression:\n  threshold: 0.9\n");
    await talk(r, "hello");
    assert.deepEqual((await until(() => windowOf(r, r.mainId)))["limit"], { at: 90, choices: [90], default: 90, may_turn_off: false });
    writeFileSync(join(r.root, "config.yaml"), "compression: {enabled: false}\n");
    await talk(r, "again");
    await until(() => (windowOf(r, r.mainId)?.["limit"] as { at?: unknown } | undefined)?.at === null);
    assert.deepEqual(windowOf(r, r.mainId)?.["limit"], { at: null, choices: [75], default: null, may_turn_off: true });
  });

  it("sends the last reading again after a restart", async () => {
    const hermes = await startFakeHermes();
    open.push(() => hermes.close());
    const { root } = hermesHome();
    const state: BridgeState = { sessions: {} };
    const first = await rig({ root, state, hermes });
    await talk(first, "hello");
    const before = await until(() => windowOf(first, first.mainId));
    const url = first.bridge.hookUrl();
    first.bridge.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // What it kept, sent again by the bridge started next, which Chips knows by the same agents.
    const kept = state.fills?.readings?.[first.mainId];
    assert.equal(kept?.used, before["used"]);
    if (kept !== undefined) state.fills = { ...state.fills, readings: { [first.mainId]: { ...kept, used: 7777 } } };
    const again = await rig({ root, state, hermes, chips: first.chips });
    assert.equal(again.mainId, first.mainId);
    await until(() => windowOf(again, again.mainId)?.["used"] === 7777);
    assert.equal(again.bridge.hookUrl(), url, "Hermes's config keeps reaching it");
  });
});
