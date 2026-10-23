/**
 * Hermes Agent as one Chips harness, on its Runs API. Each configured profile is a Chips agent
 * (ADR 0087), registered by its own key. The first is the harness's Main agent, in the harness's
 * own room in the place of the default agent Chips gave the harness there, and it answers for
 * that default agent, and for any other of the harness's Chips doesn't name here: a new agent a
 * person asks for in a room (Chips ADR 0108) is one. A room an agent is in is one Hermes session
 * of its profile, made the first time somebody there speaks to it, and kept across restarts.
 *
 * A message for an agent is a run, the same on both sides:
 * - It starts with `POST /v1/runs`, telling the session what Chips hands over: the room note, what
 *   was said, and the words.
 * - Hermes's reasoning and interim words are the run's status.
 * - Its tool calls and sub-agents are steps.
 * - What it asks before acting is an approval card.
 * - At the end come its words in the room and its tokens. A sub-agent's cost is the step's.
 * - Stop is `POST …/stop`, and a steer is `POST …/steer`.
 *
 * A reply a person says wasn't right ("Not right?", Chips ADR 0200) is a turn of the agent that
 * said it, in the same session: shown its reply and the note, it answers again in its place.
 *
 * A copy of an agent a person asks for in another room (ADR 0087, Fork) is a fork of its session
 * in Hermes: the copy remembers everything the agent did, and from then on the two go on apart. It
 * answers through its original's profile and works in its original's folder.
 *
 * Hermes can't be told anything outside a run, and keeps no schedule this bridge reads yet, so
 * neither is claimed.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent, Chips, Decision, Project, Run, Speaker } from "@chipschat/harness";
import { promptFor, pushedInWords, SENDING_FILES, sendAnswer } from "@chipschat/harness";
import {
  type AgentAsked,
  type AgentFork,
  createIdGenerator,
  FORK_WAIT_MS,
  type Feedback,
  type MessageNew,
  messageIdOf,
  type ProjectFacts,
  type StepKind,
} from "@chipschat/protocol";
import { HermesClient, HermesError, type ProfileAddress, type RunEvent, TERMINAL } from "./hermes.js";

export interface AgentConfig {
  /** What a person sees, and its @handle: `Hermes`. */
  readonly name: string;
  /** Its profile's gateway and key. */
  readonly address: ProfileAddress;
  /** The environment variable its key was read from, to name when Hermes refuses it. */
  readonly keyEnv?: string | undefined;
  /** Where its key was read from: `$API_SERVER_KEY`, or Hermes's own `.env`. */
  readonly keyFrom?: string | undefined;
  /** The model each of its runs asks for, when not the profile's own. */
  readonly model?: string | undefined;
  /**
   * Where its profile works (the gateway's `MESSAGING_CWD`): a file an answer names with a
   * `MEDIA:` line is sent to the room from here, and from nowhere else. None, and nothing is sent.
   */
  readonly folder?: string | undefined;
}

/** What the bridge keeps across restarts beside the SDK's own store. */
export interface BridgeState {
  /**
   * `<agent key>|<space id>` → the Hermes session that room is; for an agent not configured here,
   * its Chips id in the place of the key.
   */
  sessions: Record<string, string>;
  /** Chips agent id → the folder it works in, named after it the first time and kept. */
  folders?: Record<string, string>;
  /**
   * A copy's Chips id → the key of the profile it answers through: its original's, whose Hermes
   * has the copy's session (Chips ADR 0087, Fork).
   */
  profiles?: Record<string, string>;
}

/**
 * What it asks to be allowed when it joins with a code: to speak for its agents (ADR 0087), to
 * make a new one a person asks for in a room (ADR 0108), and to copy one (ADR 0087, Fork). A link
 * carries what the person chose instead.
 */
export const WANTS: readonly string[] = ["agents", "new_agents", "forks"];

export interface BridgeOptions {
  readonly chips: Chips;
  readonly agents: readonly AgentConfig[];
  /** The harness's own room, where its Main agent lives. */
  readonly home?: string | undefined;
  /**
   * Where each agent gets a folder of its own, unless the config names one `folder` for them all.
   * None, and an agent has no folder: no file it names is sent.
   */
  readonly folders?: string | undefined;
  /**
   * Whether each agent works on its room's project in a copy in its folder (Chips ADR 0221): true
   * when this machine has a git new enough. An agent a person pointed at a folder of their own works
   * there as it always has.
   */
  readonly projects?: boolean | undefined;
  readonly state: BridgeState;
  readonly saveState: (state: BridgeState) => void;
  /** How to reach a profile: its gateway, unless a test hands in a client of its own. */
  readonly clientFor?: ((agent: AgentConfig) => HermesClient) | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** How often each gateway is asked whether it is up. */
  readonly healthEveryMs?: number | undefined;
}

/**
 * How a file reaches the room, as each run's `instructions`, which Hermes adds to that turn's system
 * prompt and keeps out of the session. In the turn's words it lost to Hermes's own hint for its API
 * server, that a file other than a picture can't be sent: "this interface doesn't let me attach HTML
 * files", and a path (the Chips runs of 17 October 2026). Said here, it holds in a session that
 * began before, and needs nothing changed in Hermes.
 */
export const FILES_HERE =
  `${SENDING_FILES} Hermes's note that this API server sends only pictures, and shows a MEDIA: tag on ` +
  "the runs endpoint as text, does not hold for these runs: they come from Chips, whose bridge takes " +
  "each MEDIA: line out of your answer and attaches that file to your message, whatever its type, up " +
  "to 100 MB.";

/** Each run's instructions: how a file reaches the room, and where the agent's own folder is. */
export function instructionsFor(folder: string | undefined): string {
  return folder === undefined
    ? FILES_HERE
    : `${FILES_HERE} Your own folder is ${folder}: make and keep your files there, and run your commands from there.`;
}

/** A folder under `root` named after an agent, `-2` and on when another agent has that one. */
export function freeFolder(root: string, name: string, taken: readonly string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  for (let count = 1; ; count += 1) {
    const folder = join(root, count === 1 ? slug : `${slug}-${count}`);
    if (!taken.includes(folder)) return folder;
  }
}

/** Ids for the approvals asked here, made before the ask so Hermes's answer can find its card. */
const ids = createIdGenerator();

/** How often a run's status may change, so a stream of thoughts isn't a stream of events. */
const QUIET_MS = 1500;
/** How long the end of a run whose stream was lost is waited for, read from its state. */
const LOST_STREAM_MS = 120_000;
/** How many feedback events are remembered as answered, so one heard again is no second turn. */
const KEPT_FEEDBACK = 500;

/**
 * What kind of call each of Hermes's own tools is, in Chips's words (Chips ADR 0162), so the
 * thinking bubble draws one Chips has never seen as what it does. A tool not here is left to
 * Chips to read by its name.
 */
const KINDS: Readonly<Record<string, StepKind>> = {
  terminal: "shell",
  process: "shell",
  execute_code: "shell",
  web_search: "search",
  search_files: "search",
  session_search: "search",
  web_extract: "web",
  read_file: "file",
  write_file: "edit",
  patch: "edit",
  vision_analyze: "image",
  image_generate: "image",
  memory: "memory",
  delegate_task: "handoff",
};

/** A Chips agent's key for a configured profile. */
export function keyOf(agent: Pick<AgentConfig, "name" | "address">): string {
  return `hermes:${(agent.address.profile ?? "default").toLowerCase()}:${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

interface Running {
  readonly config: AgentConfig;
  readonly key: string;
  readonly client: HermesClient;
  agentId: string;
  up: boolean;
}

/** A message for one of the harness's Chips agents, and which: the one that answers it. */
interface Asked {
  readonly message: MessageNew;
  /** The Chips agent it was for, or none where Chips named only the harness. */
  readonly speakerId: string | undefined;
  /** What the thinking bubble says, when not the message's first line: a fix turn's (Chips ADR 0200). */
  readonly goal?: string | undefined;
  /** Whether the words open with who said them: not a fix turn's, whose words name them already. */
  readonly sayWho?: boolean | undefined;
}

interface Room {
  /** Which agent's session in which room: its key in `BridgeState.sessions`. */
  readonly id: string;
  readonly agent: Running;
  readonly spaceId: string;
  readonly queue: Asked[];
  busy: boolean;
}

/** An approval Hermes asked for, and whether the answer came from here. */
interface Pending {
  readonly approvalId: string;
  answered: boolean;
}

/** The turn going in a room: the Chips run, the Hermes run, and what has come back. */
interface Turn {
  readonly run: Run;
  readonly speaker: Speaker;
  readonly agent: Running;
  /** Hermes's run, once started: empty until then. */
  hermesRun: string;
  reply: string;
  saidAt: number;
  cancelled: boolean;
  /** Words a person steered with that Hermes wouldn't take mid-run: the next run of the turn. */
  readonly next: string[];
  /** Steps open by Hermes's call id, or by tool for a call that names none, first in first out. */
  readonly open: Map<string, string[]>;
  counted: number;
  readonly approvals: Map<string, Pending>;
  /** Approvals a person allowed, oldest first: the next call to end says how each went. */
  readonly allowed: string[];
  /** A person's interrupt stopped the Hermes run: the turn goes on with their words. */
  interrupted: boolean;
  /** The folder the agent works in and its files are sent from, said in each run's instructions. */
  folder?: string | undefined;
  /** The agent's copy of the room's project, brought up to date as the turn began (Chips ADR 0221). */
  project?: Project | undefined;
}

export class Bridge {
  private readonly agents: Running[] = [];
  private readonly rooms = new Map<string, Room>();
  /** Every Chips agent of the harness's, configured here or not. */
  private ours = new Set<string>();
  /** The harness's agents' names, by Chips id, for the folders named after them. */
  private readonly names = new Map<string, string>();
  /** The feedback events answered with a turn, the newest `KEPT_FEEDBACK`. */
  private readonly lookedAt = new Set<string>();
  /** The copies being made, one after another: a message for one waits for it (see `copy`). */
  private copying: Promise<void> = Promise.resolve();
  private readonly log: (line: string) => void;
  private health: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Register the agents, start hearing what is said to them, and say how their gateways are. */
  async start(): Promise<void> {
    const { chips } = this.options;
    const known = await chips.agents.list();
    for (const [index, config] of this.options.agents.entries()) {
      const key = keyOf(config);
      const registered =
        index === 0 ? await this.seatMain(config, known) : await chips.agents.register({ key, name: config.name });
      const client = this.options.clientFor?.(config) ?? new HermesClient(config.address);
      this.agents.push({ config, key, client, agentId: registered.agentId, up: true });
    }
    this.ours = new Set([...known.map((agent) => agent.agentId), ...this.agents.map((agent) => agent.agentId)]);
    chips.on("message.new", (message) => void this.hear(message));
    chips.on("agent.asked", (asked) => {
      this.make(asked).catch((error: unknown) => this.log(`a new agent went wrong: ${messageOf(error)}`));
    });
    chips.on("agent.fork", (fork) => {
      this.copying = this.copying
        .then(() => this.copy(fork))
        .catch((error: unknown) => this.log(`a copy went wrong: ${messageOf(error)}`));
    });
    chips.on("feedback", (feedback) => {
      this.notRight(feedback).catch((error: unknown) => this.log(`a note on a reply went wrong: ${messageOf(error)}`));
    });
    await this.sayHowItIs();
    this.health = setInterval(() => void this.sayHowItIs(), this.options.healthEveryMs ?? 30_000);
    this.health.unref();
  }

  stop(): void {
    if (this.health !== undefined) clearInterval(this.health);
  }

  /** The Main agent, the first registered, once started: who says the harness's first words. */
  get mainAgentId(): string | undefined {
    return this.agents[0]?.agentId;
  }

  /**
   * The Main agent: the one Chips made for the harness when it joined, keyed by the harness's own
   * id, registered as Main (Chips ADR 0183), so it is called what the config says and has no
   * second beside it. It goes home, and a Main of ours from before that, out of its room now, is
   * archived, which gives its name up. With no such agent (a harness from before them), the Main
   * Chips has is kept: a harness has one at most.
   */
  private async seatMain(config: AgentConfig, known: readonly Agent[]): Promise<Agent> {
    const { chips } = this.options;
    const before = known.find((agent) => agent.lead);
    const made = known.some((agent) => agent.key === chips.harnessId);
    if (!made && before !== undefined) {
      await this.goHome(before, known);
      return before;
    }
    const main = await chips.agents.register({ key: chips.harnessId, name: config.name, lead: true });
    await this.goHome(main, known);
    if (before !== undefined && before.agentId !== main.agentId) {
      await chips.agents
        .register({ key: before.key, name: before.name, state: "archived" })
        .catch((error: unknown) => this.log(`${before.name} stays: ${String(error)}`));
    }
    return main;
  }

  /** The Main agent into the harness's own room, in the place of whichever of ours is there. */
  private async goHome(main: Agent, known: readonly Agent[]): Promise<void> {
    const { chips, home } = this.options;
    if (home === undefined || main.spaces.includes(home)) return;
    const there = known.find((agent) => agent.agentId !== main.agentId && agent.spaces.includes(home));
    await chips.agents
      .attach(main.agentId, { spaceId: home, replacing: there?.agentId ?? chips.harnessId })
      .catch((error: unknown) => this.log(`${main.name} stays out of its home: ${String(error)}`));
  }

  /**
   * A person asked for a new agent in a room (Chips ADR 0108): one of the harness's, keyed by the
   * ask so an ask heard twice makes one, registered for the room, which Chips puts it in while the
   * room waits. It answers through the first profile, in a session of its own.
   */
  private async make(asked: AgentAsked): Promise<void> {
    const { chips } = this.options;
    if (asked.harness_id !== chips.harnessId || asked.space_id === undefined) return;
    const agent = await chips.agents.register({
      key: `hermes:asked:${asked.id}`,
      name: asked.name,
      madeFor: asked.id,
      spaceId: asked.space_id,
    });
    this.ours.add(agent.agentId);
    this.names.set(agent.agentId, agent.name);
    this.log(`${agent.name} made${agent.attached === false ? `, not in the room: ${agent.why ?? "too late"}` : ""}`);
  }

  /**
   * A person asked for a copy of one of the harness's agents in another room (ADR 0087, Fork): the
   * agent's session in the room it is in, else the last it had, forked in Hermes, is the copy's
   * session in the room asked. The copy answers through its original's profile, whose Hermes has
   * that session, and works in its original's folder. It is registered with `forkedFrom` for the
   * room, which Chips puts it in while the room waits. The fork and the copy are keyed by the ask,
   * so an ask heard twice forks once (Hermes refuses the id again) and registers the same copy. An
   * agent that never spoke is copied with nothing to remember. A turn still going is not in the
   * copy: Hermes copies what the session holds. Nothing is made for an ask the room has stopped
   * waiting for (`FORK_WAIT_MS`), nor for an agent that isn't the harness's.
   */
  private async copy(fork: AgentFork): Promise<void> {
    const { chips, state } = this.options;
    const spaceId = fork.space_id;
    if (spaceId === undefined) return;
    const late = Date.now() - Date.parse(fork.ts);
    if (late > FORK_WAIT_MS) {
      this.log(`no copy of ${fork.agent_id}: asked ${Math.round(late / 1000)} s ago, and the room waits a minute`);
      return;
    }
    const original = await this.profileOf(fork.agent_id);
    if (original === undefined) {
      this.log(`no copy of ${fork.agent_id}: it isn't one of this harness's agents`);
      return;
    }
    const name = await this.nameOf(fork.agent_id, original.config.name);
    const key = `hermes:fork:${fork.id}`;
    // Its sessions are kept by its profile's key, or by its Chips id for an agent not configured.
    const who = fork.agent_id === original.agentId ? original.key : fork.agent_id;
    const listed = await chips.agents.list().catch(() => []);
    const room = listed.find((agent) => agent.agentId === fork.agent_id)?.room ?? undefined;
    const from =
      (room === undefined ? undefined : state.sessions[`${who}|${room}`]) ??
      Object.entries(state.sessions).findLast(([id]) => id.startsWith(`${who}|`))?.[1];
    if (from === undefined) this.log(`${name} never spoke: its copy remembers nothing`);
    const session =
      from === undefined
        ? undefined
        : await original.client.forkSession(from, { id: `chips-fork-${fork.id}`, title: `Chips room ${spaceId} · ${key}` });
    const folder = this.folderOf(original, fork.agent_id, name);
    const copy = await chips.agents.register({ key, name: forkName(name), forkedFrom: fork.agent_id, spaceId });
    // Kept before anything said to it is answered: a message for it meanwhile waits for this.
    if (session !== undefined) state.sessions[`${copy.agentId}|${spaceId}`] ??= session;
    state.profiles = { ...state.profiles, [copy.agentId]: original.key };
    if (folder !== undefined) state.folders = { ...state.folders, [copy.agentId]: folder };
    this.options.saveState(state);
    this.ours.add(copy.agentId);
    this.names.set(copy.agentId, copy.name);
    const away = copy.attached === false && !copy.spaces.includes(spaceId);
    this.log(`${copy.name}, a copy of ${name}, made${away ? `, not in the room: ${copy.why ?? "too late"}` : ""}`);
  }

  /** An agent's name, from Chips's list when it isn't known yet. */
  private async nameOf(agentId: string, otherwise: string): Promise<string> {
    if (!this.names.has(agentId)) {
      const listed = await this.options.chips.agents.list().catch(() => []);
      for (const agent of listed) this.names.set(agent.agentId, agent.name);
    }
    return this.names.get(agentId) ?? otherwise;
  }

  /**
   * The folder an agent works in and sends its files from: the one the config names for them all
   * (`folder`, as it was), else one of its own under `folders`, named after it the first time it
   * takes a turn and kept, so a rename keeps it. Every agent once shared one folder, and a team's
   * files overwrote a one-agent room's game (Chips TT-16); and the one folder had to be Hermes's
   * own working folder, which a plain Hermes doesn't set (the setup audit, 17 October 2026).
   */
  private folderOf(agent: Running, agentId: string, name: string): string | undefined {
    if (agent.config.folder !== undefined) return agent.config.folder;
    const { folders: root, state } = this.options;
    if (root === undefined) return undefined;
    const kept = state.folders?.[agentId];
    const folder = kept ?? freeFolder(root, name, Object.values(state.folders ?? {}));
    mkdirSync(folder, { recursive: true });
    if (kept === undefined) {
      state.folders = { ...state.folders, [agentId]: folder };
      this.options.saveState(state);
    }
    return folder;
  }

  /**
   * The room's project for a turn (Chips ADR 0221): the agent's copy, in its folder, brought up to
   * date, and what the turn is told of it. None for an agent a person pointed at a folder of their
   * own, nor where this machine has no git for it.
   */
  private async projectFor(
    turn: Turn,
    spaceId: string,
    agentId: string,
    name: string,
  ): Promise<ProjectFacts | undefined> {
    if (this.options.projects !== true || turn.agent.config.folder !== undefined) return undefined;
    const folder = turn.folder;
    if (folder === undefined) return undefined;
    try {
      const project = this.options.chips.project({ spaceId, agentId, name, folder, log: (line) => this.log(line) });
      const facts = await project.pull();
      turn.project = project;
      return facts;
    } catch (error) {
      this.log(`${name}'s copy of the room's project couldn't be readied: ${messageOf(error)}`);
      return undefined;
    }
  }

  /** What the turn changed in its copy, sent to the room's project before its words are posted. */
  private async sendProject(turn: Turn, words: string): Promise<void> {
    if (turn.project === undefined) return;
    try {
      this.log(`${turn.agent.config.name}'s project: ${pushedInWords(await turn.project.push({ words }))}`);
    } catch (error) {
      this.log(`${turn.agent.config.name}'s project couldn't be sent: ${messageOf(error)}`);
    }
  }

  /** Trouble while a profile's gateway doesn't answer, and fine once all do (ADR 0083). */
  private async sayHowItIs(): Promise<void> {
    for (const agent of this.agents) agent.up = await agent.client.healthy();
    const down = this.agents.filter((agent) => !agent.up);
    const chips = this.options.chips;
    const said =
      down.length === 0
        ? chips.reportOk()
        : chips.reportTrouble(`Hermes isn't answering for ${down.map((agent) => agent.config.name).join(", ")}`);
    await said.catch(() => undefined);
  }

  // ------------------------------------------------------------------ what is said to it

  /** A message for some of its agents: each takes a turn in its room, one after another there. */
  private async hear(message: MessageNew, how: Pick<Asked, "goal" | "sayWho"> = {}): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    for (const taker of message.for ?? [harnessId]) {
      const agent = await this.runnerOf(taker);
      if (agent === undefined) continue;
      const room = this.roomOf(agent, taker, spaceId);
      room.queue.push({ message, speakerId: taker === harnessId ? undefined : taker, ...how });
      void this.pump(room);
    }
  }

  /**
   * "Not right?" on one of its agents' replies (Chips ADR 0200): a person's note on it, or a bare
   * 👎 from an older phone, is a turn of the agent that said it, in its session in that room and
   * in line with the room's other turns, to look again and answer in its place. Any other
   * reaction is the person's own. Once per event, however often it is heard.
   */
  private async notRight(feedback: Feedback): Promise<void> {
    const { space_id: spaceId, message_id: messageId } = feedback;
    const note = feedback.kind === "correction" ? (feedback.text ?? "").trim() : undefined;
    const flagged = note === undefined ? feedback.kind === "reaction" && feedback.reaction === "👎" : note !== "";
    if (spaceId === undefined || !messageId || !flagged || this.lookedAt.has(feedback.id)) return;
    this.lookedAt.add(feedback.id);
    for (const old of this.lookedAt) {
      if (this.lookedAt.size <= KEPT_FEEDBACK) break;
      this.lookedAt.delete(old);
    }
    // The event doesn't say whose reply it was: the room's lines do, and what it said. A reply
    // not among them is the default agent's to answer, as a message for nobody in particular is.
    const context = await this.options.chips.roomContext(spaceId, { limit: 200 }).catch(() => undefined);
    const line = context?.lines.find((each) => each.message_id === messageId);
    const message = {
      type: "message.new",
      space_id: spaceId,
      // An id of its own, so nothing of the turn is taken for the reply's.
      message_id: messageIdOf(feedback.id),
      text: lookAgain(feedback.from.display_name, line?.text, note),
      from: feedback.from,
      ...(line === undefined ? {} : { for: [line.from.id] }),
    } as unknown as MessageNew;
    await this.hear(message, { goal: lookingAgain(note), sayWho: false });
  }

  /**
   * Which profile answers for a Chips agent, as `profileOf` says. An agent not known yet may be a
   * copy being made, which is waited for, so that its first message is answered in its session.
   */
  private async runnerOf(taker: string): Promise<Running | undefined> {
    if (taker !== this.options.chips.harnessId && !this.ours.has(taker)) await this.copying;
    return this.profileOf(taker);
  }

  /**
   * Which profile answers for a Chips agent: its own; a copy's original's; or the first for the
   * harness itself and for any other of the harness's — its default agent, one Chips made since —
   * read afresh once when a name is new.
   */
  private async profileOf(taker: string): Promise<Running | undefined> {
    const own = this.agents.find((agent) => agent.agentId === taker);
    if (own !== undefined) return own;
    const copied = this.options.state.profiles?.[taker];
    const original = this.agents.find((agent) => copied !== undefined && agent.key === copied);
    if (original !== undefined) return original;
    if (taker !== this.options.chips.harnessId && !this.ours.has(taker)) {
      const listed = await this.options.chips.agents.list().catch(() => []);
      for (const agent of listed) {
        this.ours.add(agent.agentId);
        this.names.set(agent.agentId, agent.name);
      }
    }
    return taker === this.options.chips.harnessId || this.ours.has(taker) ? this.agents[0] : undefined;
  }

  /**
   * The session a turn is taken in: the profile's own in the room, for its agent or the harness
   * itself, and one of its own for any other of the harness's, so two in a room are two.
   */
  private roomOf(agent: Running, taker: string, spaceId: string): Room {
    const own = taker === agent.agentId || taker === this.options.chips.harnessId;
    const id = `${own ? agent.key : taker}|${spaceId}`;
    let room = this.rooms.get(id);
    if (room === undefined) {
      room = { id, agent, spaceId, queue: [], busy: false };
      this.rooms.set(id, room);
    }
    return room;
  }

  private async pump(room: Room): Promise<void> {
    if (room.busy) return;
    const asked = room.queue.shift();
    if (asked === undefined) return;
    room.busy = true;
    try {
      await this.turn(room, asked);
    } catch (error) {
      this.log(`a turn of ${room.agent.config.name} went wrong: ${messageOf(error)}`);
    } finally {
      room.busy = false;
      void this.pump(room);
    }
  }

  private async turn(room: Room, { message, speakerId, goal, sayWho }: Asked): Promise<void> {
    const { agent, spaceId } = room;
    const speaker = speakerId === undefined ? this.options.chips : this.options.chips.as(speakerId);
    const run = await speaker.runs.start({ spaceId, goal: goal ?? goalOf(message, agent.config.name) });
    const turn: Turn = {
      run,
      speaker,
      agent,
      hermesRun: "",
      reply: "",
      saidAt: 0,
      cancelled: false,
      next: [],
      open: new Map(),
      counted: 0,
      approvals: new Map(),
      allowed: [],
      interrupted: false,
    };
    // Heard from the start, so a Stop before Hermes has the run still stops it.
    run.on("cancel", () => {
      turn.cancelled = true;
      if (turn.hermesRun !== "") void agent.client.stop(turn.hermesRun).catch(() => undefined);
    });
    run.on("steer", (steer) => {
      const words = `${steer.from?.display_name ?? "The person"} adds: ${steer.text}`;
      void this.steered(turn, words, steer.mode);
    });
    let session: string;
    try {
      session = await this.sessionFor(room);
    } catch (error) {
      await this.failed(turn, `${agent.config.name} couldn't open a session in Hermes: ${messageOf(error)}`, true);
      return;
    }
    const name = speakerId === undefined ? agent.config.name : await this.nameOf(speakerId, agent.config.name);
    turn.folder = this.folderOf(agent, speakerId ?? agent.agentId, name);
    const project = await this.projectFor(turn, room.spaceId, speakerId ?? agent.agentId, name);
    let text: string | undefined = promptFor(message, { taker: speakerId, sayWho, project });
    for (let round = 0; text !== undefined && !turn.cancelled && !run.over; round += 1) {
      const last = await this.once(turn, session, text, `${run.id}:${round}`);
      if (last === undefined) return;
      if (last.event === "run.cancelled" && turn.interrupted && turn.next.length > 0) {
        turn.interrupted = false;
        text = turn.next.shift();
        continue;
      }
      if (last.event !== "run.completed") {
        await this.ended(turn, last);
        return;
      }
      text = turn.next.shift();
      if (text === undefined) await this.finish(turn, last);
    }
  }

  /** One Hermes run of the turn: started, its events heard to the end. The end, or nothing on failure. */
  private async once(turn: Turn, session: string, text: string, key: string): Promise<RunEvent | undefined> {
    const { agent } = turn;
    try {
      turn.hermesRun = await agent.client.startRun({ text, sessionId: session, model: agent.config.model, key, instructions: instructionsFor(turn.folder) });
    } catch (error) {
      await this.failed(turn, `${agent.config.name} couldn't start in Hermes: ${messageOf(error)}`, true);
      return undefined;
    }
    if (turn.cancelled) await agent.client.stop(turn.hermesRun).catch(() => undefined);
    try {
      const last = await agent.client.events(turn.hermesRun, (event) => this.heard(turn, event));
      return last ?? (await this.endOf(turn));
    } catch (error) {
      this.log(`lost ${agent.config.name}'s run ${turn.hermesRun}: ${messageOf(error)}`);
      return await this.endOf(turn);
    }
  }

  /** The end of a run whose stream was lost: its state read until it is over, as a terminal event. */
  private async endOf(turn: Turn): Promise<RunEvent | undefined> {
    const by = Date.now() + LOST_STREAM_MS;
    while (Date.now() < by) {
      const state = await turn.agent.client.run(turn.hermesRun).catch(() => undefined);
      const status = typeof state?.["status"] === "string" ? state["status"] : undefined;
      if (status !== undefined && TERMINAL.has(`run.${status}`)) {
        return { ...state, event: `run.${status}` } as RunEvent;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await this.failed(turn, `${turn.agent.config.name}'s run in Hermes stopped answering.`, true);
    return undefined;
  }

  /** The room's session: the one it had, or a new one Hermes makes for it. */
  private async sessionFor({ id, agent, spaceId }: Room): Promise<string> {
    const kept = this.options.state.sessions[id];
    if (kept !== undefined) return kept;
    // Hermes keeps a title to one session, so each other agent's session in a room is named for it.
    const who = id.slice(0, id.lastIndexOf("|"));
    const made = await agent.client.newSession(`Chips room ${spaceId}${who === agent.key ? "" : ` · ${who}`}`);
    this.options.state.sessions[id] = made;
    this.options.saveState(this.options.state);
    return made;
  }

  /**
   * A person's words for a run that is going. A steer is said to the Hermes run, or to the next one
   * of the turn when Hermes won't take it now. A follow-up waits for this one to end. An
   * interrupt stops it, and the turn goes on with the words.
   */
  private async steered(turn: Turn, text: string, mode: string): Promise<void> {
    if (mode === "interrupt" && turn.hermesRun !== "") {
      turn.next.unshift(text);
      turn.interrupted = true;
      await turn.agent.client.stop(turn.hermesRun).catch(() => undefined);
      return;
    }
    if (mode === "steer" && turn.hermesRun !== "") {
      try {
        await turn.agent.client.steer(turn.hermesRun, text);
        return;
      } catch (error) {
        this.log(`Hermes didn't take a steer mid-run (${messageOf(error)}); saying it next`);
      }
    }
    turn.next.push(text);
  }

  // ------------------------------------------------------------------ what Hermes streams

  private async heard(turn: Turn, event: RunEvent): Promise<void> {
    if (turn.run.over) return;
    switch (event.event) {
      case "message.delta":
        turn.reply += typeof event["delta"] === "string" ? event["delta"] : "";
        return;
      case "message.interim":
      case "reasoning.available":
        this.sayThought(turn, String(event["text"] ?? ""), event.event === "message.interim" ? "writing" : "thinking");
        return;
      case "tool.started":
      case "subagent.start":
        await this.started(turn, event);
        return;
      case "tool.completed":
      case "subagent.complete":
        await this.completed(turn, event);
        return;
      case "approval.request":
        void this.ask(turn, event);
        return;
      case "approval.responded":
        await this.settled(turn, event);
        return;
      default:
        return;
    }
  }

  private sayThought(turn: Turn, text: string, phase: string): void {
    const now = Date.now();
    const line = lastLine(text);
    if (line === "" || now - turn.saidAt < QUIET_MS) return;
    turn.saidAt = now;
    void turn.run.status({ phase, verbPhrase: line.slice(0, 200) }).catch(() => undefined);
  }

  private async started(turn: Turn, event: RunEvent): Promise<void> {
    const sub = event.event === "subagent.start";
    const tool = sub ? "delegate_task" : String(event["tool"] ?? "tool");
    turn.counted += 1;
    const callId = typeof event["tool_call_id"] === "string" ? event["tool_call_id"] : undefined;
    const stepId = callId ?? `${tool}-${turn.counted}`;
    const lane = callId ?? (sub ? "subagent" : `tool:${tool}`);
    turn.open.set(lane, [...(turn.open.get(lane) ?? []), stepId]);
    const said = sub ? event["goal"] : event["preview"];
    await turn.run
      .step({
        stepId,
        status: "started",
        title: `${tool}${typeof said === "string" && said !== "" ? ` · ${said}` : ""}`.slice(0, 300),
        tool,
        ...(KINDS[tool] === undefined ? {} : { kind: KINDS[tool] }),
      })
      .catch(() => undefined);
  }

  private async completed(turn: Turn, event: RunEvent): Promise<void> {
    const sub = event.event === "subagent.complete";
    const tool = sub ? "delegate_task" : String(event["tool"] ?? "tool");
    const callId = typeof event["tool_call_id"] === "string" ? event["tool_call_id"] : undefined;
    const lane = callId ?? (sub ? "subagent" : `tool:${tool}`);
    const waiting = turn.open.get(lane) ?? [];
    const stepId = callId ?? waiting.shift() ?? `${tool}-${(turn.counted += 1)}`;
    turn.open.set(lane, waiting.filter((each) => each !== stepId));
    const failed = event["error"] === true || (sub && event["status"] === "failed");
    // The call a person allowed ends next: the card says how it went.
    const approvalId = sub ? undefined : turn.allowed.shift();
    if (approvalId !== undefined) {
      await turn.run.executed(approvalId, failed ? "failed" : "executed").catch(() => undefined);
    }
    const summary = sub ? event["summary"] : resultWords(event["preview"]);
    const seconds = typeof event["duration"] === "number" ? event["duration"] : undefined;
    await turn.run
      .step({
        stepId,
        status: failed ? "failed" : "done",
        tool,
        ...(typeof summary === "string" && summary !== "" ? { summary: summary.slice(0, 2000) } : {}),
        ...(seconds === undefined ? {} : { durationMs: Math.round(seconds * 1000) }),
      })
      .catch(() => undefined);
    // A sub-agent says what it cost: the step's share of the run's (Chips ADR 0162).
    const cost = event["cost_usd"];
    if (sub && typeof cost === "number" && cost > 0) {
      const model = typeof event["model"] === "string" ? event["model"] : "subagent";
      await turn.run.usage({ scope: "step", model, costUsd: cost }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------ what Hermes asks

  /** An approval Hermes wants before it acts, as a card; the answer is Hermes's choice. */
  private async ask(turn: Turn, event: RunEvent): Promise<void> {
    const requestId = idOf(event);
    const command = typeof event["command"] === "string" ? event["command"] : undefined;
    const description = typeof event["description"] === "string" ? event["description"] : undefined;
    const choices = Array.isArray(event["choices"]) ? (event["choices"] as unknown[]).map(String) : ["once", "deny"];
    const approvalId = ids.next("approval");
    turn.approvals.set(requestId ?? approvalId, { approvalId, answered: false });
    const asked = turn.run.approval({
      approvalId,
      action: {
        kind: command === undefined ? "hermes.approval" : "shell.exec",
        input: { ...(command === undefined ? {} : { command }), ...(description === undefined ? {} : { description }) },
      },
      question: (description === undefined ? "Run this command?" : `Allow it to ${lowerFirst(description)}?`).slice(0, 300),
      lasts: "once",
      risk: [],
      ...(command === undefined
        ? {}
        : { preview: { format: "markdown" as const, title: "Run a command", body: `\`\`\`sh\n${command}\n\`\`\`` } }),
    });
    const stopped = new Promise<undefined>((resolve) => turn.run.on("cancel", () => resolve(undefined)));
    const decision = await Promise.race([asked, stopped]);
    const pending = turn.approvals.get(requestId ?? approvalId);
    if (decision === undefined || pending === undefined || pending.answered) return;
    pending.answered = true;
    if (decision.allowed) turn.allowed.push(approvalId);
    const generation = event["execution_generation"];
    await turn.agent.client
      .approve(turn.hermesRun, {
        choice: choiceOf(decision, choices),
        ...(requestId === undefined ? {} : { request_id: requestId }),
        ...(typeof generation === "number" ? { execution_generation: generation } : {}),
      })
      .catch((error: unknown) => this.log(`Hermes didn't take the answer: ${messageOf(error)}`));
  }

  /** An approval answered in Hermes's own tools: settled in Chips, once, so the card cools (ADR 0079). */
  private async settled(turn: Turn, event: RunEvent): Promise<void> {
    const requestId = idOf(event);
    const pending = requestId === undefined ? undefined : turn.approvals.get(requestId);
    if (pending === undefined || pending.answered) return;
    pending.answered = true;
    const denied = event["choice"] === "deny";
    await this.options.chips
      .send(
        "approval.resolved",
        { run_id: turn.run.id },
        {
          approval_id: pending.approvalId,
          decision: denied ? "denied" : "approved",
          scope: "once",
          reason: "Answered in Hermes.",
        },
        `hermes-approval:${turn.hermesRun}:${requestId}:settled`,
      )
      .catch(() => undefined);
  }

  // ------------------------------------------------------------------ the end

  /** The turn is over: its words in the room, its tokens, and the run ended. */
  private async finish(turn: Turn, last: RunEvent): Promise<void> {
    const { run, agent } = turn;
    if (run.over) return;
    await this.closeSteps(turn, "done");
    for (const approvalId of turn.allowed.splice(0)) {
      await run.executed(approvalId, "executed", "Hermes didn't say how it went.").catch(() => undefined);
    }
    await this.counted(turn, last);
    const output = typeof last["output"] === "string" ? last["output"].trim() : "";
    const answer = output !== "" ? output : turn.reply.trim();
    // The files its `MEDIA:` lines name go with its words, from its folder (Chips TT-7). With no
    // folder set none can go, and the post says so rather than show the lines.
    await this.sendProject(turn, answer);
    const { folder } = turn;
    const { chips } = this.options;
    const post = await sendAnswer(answer, {
      folders: folder === undefined ? [] : [folder],
      upload: (input) => chips.upload(input),
    });
    const reply = post.text;
    if (reply !== "" || post.uploadIds.length > 0) {
      await turn.speaker.post({ spaceId: run.spaceId, runId: run.id, text: reply, uploadIds: post.uploadIds });
    }
    const said = post.summary;
    const summary = said === "" ? "Done." : said.length <= 2000 ? said : `${said.slice(0, 1990)}…`;
    await run.complete({ summary });
    this.log(`${agent.config.name} answered in ${run.spaceId}`);
  }

  /** A run that failed, was stopped or was cut short in Hermes. */
  private async ended(turn: Turn, last: RunEvent): Promise<void> {
    await this.closeSteps(turn, "failed");
    await this.counted(turn, last);
    if (turn.cancelled || turn.run.over) return;
    const name = turn.agent.config.name;
    if (last.event === "run.cancelled") await this.failed(turn, `${name}'s run was stopped in Hermes.`, false);
    else if (last.event === "run.interrupted") await this.failed(turn, `Hermes restarted during ${name}'s run.`, true);
    else {
      const why = typeof last["error"] === "string" && last["error"] !== "" ? last["error"] : "it failed in Hermes";
      await this.failed(turn, `${name}: ${why}`, true);
    }
  }

  /**
   * The tokens Hermes counted, as a step's share, so they add up over the turn's runs. Hermes's
   * `input_tokens` is already every token in, its cache's reads and writes among them (its
   * `CanonicalUsage.prompt_tokens`), which is what Chips counts (Chips ADR 0214); the cache's two
   * counts go with it, and are left out where Hermes doesn't say them.
   */
  private async counted(turn: Turn, last: RunEvent): Promise<void> {
    const usage = (last["usage"] ?? {}) as Record<string, unknown>;
    const count = (key: string) => (typeof usage[key] === "number" ? usage[key] : undefined);
    const input = count("input_tokens") ?? 0;
    const output = count("output_tokens") ?? 0;
    if (input + output === 0) return;
    const runtime = (last["runtime"] ?? {}) as Record<string, unknown>;
    const model = typeof runtime["model"] === "string" ? runtime["model"] : (turn.agent.config.model ?? "hermes");
    await turn.run
      .usage({
        scope: "step",
        model,
        inputTokens: input,
        cacheReadTokens: count("cache_read_tokens"),
        cacheWriteTokens: count("cache_write_tokens"),
        outputTokens: output,
      })
      .catch(() => undefined);
  }

  private async closeSteps(turn: Turn, status: "done" | "failed"): Promise<void> {
    for (const [, ids] of turn.open) {
      for (const stepId of ids) await turn.run.step({ stepId, status }).catch(() => undefined);
    }
    turn.open.clear();
  }

  private async failed(turn: Turn, error: string, retryable: boolean): Promise<void> {
    if (!turn.run.over) await turn.run.fail({ error, retryable }).catch(() => undefined);
    if (retryable) void this.sayHowItIs();
  }
}

// ------------------------------------------------------------------ small words

/** Hermes's choice for a person's answer: their scope where Hermes offers it, else once. */
export function choiceOf(decision: Decision, choices: readonly string[]): string {
  if (!decision.allowed) return "deny";
  if (decision.scope === "always" && choices.includes("always")) return "always";
  if (decision.scope !== "once" && choices.includes("session")) return "session";
  return "once";
}

function idOf(event: RunEvent): string | undefined {
  const id = event["request_id"] ?? event["prompt_id"];
  return typeof id === "string" && id !== "" ? id : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof HermesError) return `${error.message} (${error.status})`;
  return error instanceof Error ? error.message : String(error);
}

/** A copy's name, as Jacobian names its forks: `Nova · fork`, which Chips numbers when it is taken. */
export function forkName(original: string): string {
  return `${original.trim().replace(/ · fork( \d+)?$/, "")} · fork`;
}

/** The run's goal: the message's first line, without the @ it opened with — the agent's whole name. */
export function goalOf(message: MessageNew, name: string): string {
  const first = message.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const named = first.toLowerCase().startsWith(`@${name.toLowerCase()}`);
  const goal = named ? first.slice(name.length + 1).trim() : first.replace(/^@\S+\s*/, "");
  return (goal === "" ? `Answer ${message.from.display_name}` : goal).slice(0, 300);
}

/** The most of a reply a fix turn is shown again. */
const REPLY_SHOWN = 1500;
/** The most of a fix turn's goal the thinking bubble is given. */
const GOAL_SHOWN = 120;

/**
 * What an agent is told when a person says its reply wasn't right (Chips ADR 0200): the reply,
 * when the room still has its words, and the note, or that there was none (a bare 👎).
 */
export function lookAgain(who: string, reply: string | undefined, note: string | undefined): string {
  const said = reply?.trim() ?? "";
  return [
    `${who} says your reply in this room wasn't right.`,
    ...(said === "" ? [] : [`Your reply:\n«${cut(said, REPLY_SHOWN)}»`]),
    note === undefined || note === ""
      ? "They didn't say what. Read your reply again and find what was wrong."
      : `What wasn't right: «${note}»`,
    "Look at it again and answer properly in its place. If it is not clear what was wrong, ask them in one short line. Say plainly what you changed.",
  ].join("\n\n");
}

/** A fix turn's goal: the note's first line, or that it looks again where there is no note. */
export function lookingAgain(note: string | undefined): string {
  const first = note?.split("\n").find((line) => line.trim() !== "")?.trim();
  return first === undefined ? "Looking again at its reply" : cut(`Looking again: ${first}`, GOAL_SHOWN);
}

function cut(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`;
}

/**
 * A tool's result as a person reads it. Hermes's terminal sends its whole result as JSON in the
 * preview (0.22.0: `{"output": …, "exit_code": …, "approval": …}`): what it printed, else its
 * error. Anything else is said as Hermes sent it.
 */
function resultWords(preview: unknown): unknown {
  if (typeof preview !== "string" || !preview.trimStart().startsWith("{")) return preview;
  let result: unknown;
  try {
    result = JSON.parse(preview);
  } catch {
    return preview;
  }
  if (typeof result !== "object" || result === null || !("output" in result)) return preview;
  const { output, error } = result as { output?: unknown; error?: unknown };
  const said = [output, error].find((each) => typeof each === "string" && each.trim() !== "");
  return typeof said === "string" ? said.trim() : "";
}

function lastLine(text: string): string {
  const lines = text.split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
}
