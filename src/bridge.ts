/**
 * Hermes Agent as one Chips harness, on its Runs API. Each configured profile is a Chips agent
 * (ADR 0087), registered by its own key. The first is the harness's Main agent, in the harness's
 * own room in the place of the default agent Chips gave the harness there, and it answers for
 * that default agent. An agent a person makes in Chips (a new one in a room, Chips ADR 0108, or a
 * space's from the +) is a Hermes profile of its own, cloned from the Main agent's (Chips ADR 0241,
 * `profiles.ts`); one made before that, or where Hermes couldn't make one, runs on the first
 * profile. A room an agent is in is one Hermes session of its profile, made the first time
 * somebody there speaks to it, and kept across restarts.
 *
 * A message for an agent is a run, the same on both sides:
 * - It starts with `POST /v1/runs`, telling the session what Chips hands over: the room note, what
 *   was said, and the words. The room's rules go in the run's instructions, which Hermes keeps
 *   out of the session (Chips ADR 0250).
 * - Hermes's reasoning and interim words are the run's status.
 * - Its tool calls and sub-agents are steps.
 * - What it asks before acting is an approval card.
 * - At the end come its words in the room and its tokens. A sub-agent's cost is the step's.
 * - Stop is `POST …/stop`, and a steer is `POST …/steer`.
 * - Pause is the same `POST …/stop`, but the turn waits rather than ends: Hermes keeps what the
 *   stopped run did in the session, and on Resume the same session is told to carry on (Chips
 *   ADR 0293). Each run says it can pause as it starts.
 *
 * A reply a person says wasn't right ("Not right?", Chips ADR 0200) is a turn of the agent that
 * said it, in the same session: shown its reply and the note, it answers again in its place.
 *
 * A space a person asks the harness for from the + (Chips ADR 0241) is claimed under a new agent
 * of the harness, which answers its first words.
 *
 * A copy of an agent a person asks for in another room (ADR 0087, Fork) is a fork of its session
 * in Hermes: the copy remembers everything the agent did, and from then on the two go on apart. It
 * answers through its original's profile, since Hermes forks a session only within its profile,
 * and works in its original's folder.
 *
 * An agent's page in Chips shows its context (Chips ADR 0134): the files Hermes builds it from,
 * which a person may edit there (`context.ts`). It shows its context window too (Chips ADR 0146):
 * how full its session is, as Hermes says after each model call through the webhook the bridge
 * adds to its config (`fills.ts`, `hooks.ts`). And its model (Chips ADR 0141): one of those
 * Hermes has for its profile, which each of its runs asks for (`models.ts`).
 *
 * Hermes can't be told anything outside a run, and keeps no schedule this bridge reads yet, so
 * neither is claimed.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Agent,
  AgentContextCopy,
  AgentContextWindowCopy,
  AgentModelCopy,
  Chips,
  Decision,
  HarnessContextCopy,
  Project,
  Run,
  SettingsHandlers,
  SpaceAsked,
  Speaker,
} from "@chipschat/harness";
import {
  firstTurnOf,
  heldNote,
  overheardLine,
  pushedInWords,
  Refuse,
  rulesFor,
  sendAnswer,
  sendingFiles,
  workingTurnsOf,
} from "@chipschat/harness";
import {
  type AgentAsked,
  type AgentFork,
  type ContextEditFrame,
  createIdGenerator,
  FORK_WAIT_MS,
  type Feedback,
  type MessageNew,
  type MessageOverheard,
  messageIdOf,
  type ModelChangeFrame,
  type ProjectFacts,
  renderAttachment,
  type StepKind,
  type WindowChangeFrame,
  type WindowCompactFrame,
  withRole,
} from "@chipschat/protocol";
import { Contexts, type Profile, type Reader, type Roster } from "./context.js";
import { Fills, type KeptFills, WHY_NOT, whyReadOnly } from "./fills.js";
import { folds, GATHER_MS, type Heard, keepAnswered, keepHeard, promptForAll } from "./fold.js";
import { HermesClient, HermesError, type ProfileAddress, type RunEvent, TERMINAL } from "./hermes.js";
import { envValue, profileHome, profileName } from "./home.js";
import { hookUrl, SECRET_ENV } from "./hooks.js";
import { copyOf, type ModelOptions, type RunModel, runModelOf } from "./models.js";
import { freeProfile, KEY_ENV, type ProfileMaker, readyProfile } from "./profiles.js";

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
   * has the copy's session (Chips ADR 0087, Fork). For an original with a profile made for it, the
   * key is its Chips id.
   */
  profiles?: Record<string, string>;
  /**
   * An agent made in Chips → the Hermes profile made for it (Chips ADR 0241), named after it then
   * and kept after a rename, as its folder is.
   */
  made?: Record<string, string>;
  /** Each agent's last context window reading, and the port and secret Hermes's webhook uses. */
  fills?: KeptFills;
  /**
   * Chips agent id → the model a person picked for it (Chips ADR 0141), a choice's id, which each
   * of its runs asks for; `null` for Hermes's default, the profile's own.
   */
  models?: Record<string, string | null>;
}

/**
 * What it asks to be allowed when it joins with a code: to speak for its agents (ADR 0087), to
 * take a space a person asks for from the + (ADR 0241), to make a new agent a person asks for in a
 * room (ADR 0108), to copy one (ADR 0087, Fork), to show each agent's context (ADR 0134), model
 * (ADR 0141) and context window (ADR 0146), and to restart Hermes's gateway when a person asks
 * (ADR 0094, `gateway.ts`). A link carries what the person chose instead.
 */
export const WANTS: readonly string[] = [
  "agents",
  "new_spaces",
  "new_agents",
  "forks",
  "context_files",
  "models",
  "context_windows",
  "restarts",
];

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
  /** How long an idle agent waits before it starts, so all it is sent at once is one turn: 150 ms unless said. */
  readonly gatherMs?: number | undefined;
  /** How often each gateway is asked whether it is up. */
  readonly healthEveryMs?: number | undefined;
  /**
   * Hermes's root (`$HERMES_HOME`, else `~/.hermes`), where each profile's files are: what the
   * agents' context is read from. None, and no context is sent.
   */
  readonly hermesRoot?: string | undefined;
  /** How often the context files are read again, besides after each turn. */
  readonly contextEveryMs?: number | undefined;
  /**
   * Where Hermes's webhook reaches the bridge, for the context window: a port on 127.0.0.1 (0
   * for one of its own, kept), and the secret it signs with where a profile's `.env` doesn't
   * say. None, and no context window is sent.
   */
  readonly fills?: { readonly port: number; readonly secret?: string | undefined } | undefined;
  /** How often one agent's context window is sent at most while readings come fast. */
  readonly fillsEveryMs?: number | undefined;
  /** The environment a profile's working folder may be named in (`TERMINAL_CWD`). */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * What makes each agent made in Chips a Hermes profile of its own (Chips ADR 0241): Hermes's own
   * CLI and gateway, unless a test hands in its own. None, or no `hermesRoot`, and such an agent
   * runs on the first profile, in a session of its own, as it did before.
   */
  readonly profiles?: ProfileMaker | undefined;
  /** Hermes's gateway restarted, as a person's Restart does: for one that serves only the profile it started with. */
  readonly restartGateway?: (() => Promise<void>) | undefined;
}

/**
 * The handlers `connect({ settings })` takes for this bridge, made before the bridge is: each asks
 * the bridge `active` gives, once there is one.
 */
export function settingsFor(active: () => Bridge | undefined): SettingsHandlers {
  const bridge = (): Bridge => {
    const there = active();
    if (there === undefined) throw new Refuse("The bridge is starting. Try again in a moment.");
    return there;
  };
  return {
    context: (edit) => bridge().onContextEdit(edit),
    models: (change) => bridge().onModelChange(change),
    contextWindows: {
      compact: async (ask) => bridge().onWindowCompact(ask),
      change: async (ask) => bridge().onWindowChange(ask),
    },
  };
}

/**
 * How a file reaches the room, as each run's `instructions`, which Hermes adds to that turn's system
 * prompt and keeps out of the session. In the turn's words it lost to Hermes's own hint for its API
 * server, that a file other than a picture can't be sent: "this interface doesn't let me attach HTML
 * files", and a path (the Chips runs of 17 October 2026). Said here, it holds in a session that
 * began before, and needs nothing changed in Hermes.
 */
export function filesHere(project = false): string {
  return (
    `${sendingFiles({ project })} Hermes's note that this API server sends only pictures, and shows a MEDIA: tag on ` +
    "the runs endpoint as text, does not hold for these runs: they come from Chips, whose bridge takes " +
    "each MEDIA: line out of your answer and attaches that file to your message, whatever its type, up " +
    "to 100 MB."
  );
}

/** How a file reaches a room that has no project to work on. */
export const FILES_HERE = filesHere();

/**
 * That Chips shows Markdown, as each run's instructions say. Hermes's hint for its API server says
 * to assume plain text, with no headings, lists, bold or code fences, so its agents wrote plain
 * text in a room where every other harness's agent wrote Markdown (Chips, 30 October 2026).
 */
export const MARKDOWN_HERE =
  "Hermes's note that this API server's replies are plain text does not hold for these runs either: " +
  "Chips shows your answer as Markdown, so use headings, lists, bold, tables and code blocks where " +
  "they help a reader.";

/**
 * Each run's instructions: how a file reaches the room (with the room's project, a file that isn't
 * in it: Chips AP-9), where the agent's own folder is, that Chips shows Markdown, and the room's
 * rules (`rulesFor`, Chips ADR 0250). Hermes keeps instructions out of the session, so a turn's words carry the facts only
 * and the rules don't pile up in the session, turn after turn.
 */
export function instructionsFor(folder: string | undefined, project = false, rules = ""): string {
  const files = filesHere(project);
  const here =
    folder === undefined
      ? files
      : `${files} Your own folder is ${folder}: make and keep your files there, and run your commands from there.`;
  return [here, MARKDOWN_HERE, rules].filter((part) => part !== "").join("\n\n");
}

/** What a paused turn's session is told on Resume (Chips ADR 0293), before anything steered meanwhile. */
export const CARRY_ON = "You were paused partway through this. Carry on from where you stopped. Nothing you wrote before the pause reached the room, so write your whole reply.";

/**
 * What the run that carries on after a pause is told besides, in its instructions, which Hermes
 * keeps out of the session. Hermes keeps the words a stopped run had written in the session, so
 * the agent may take up mid-sentence; but none of them reached the room, and only this run's
 * answer is posted there, so it gives the whole of it.
 */
export const CARRIED_ON =
  "You were paused partway through this turn. Nothing you wrote before the pause reached the room, and only " +
  "your answer in this run is posted there: give your whole answer, not just the part after where you stopped.";

/** Hermes's events that mean its run is at work: on a paused run, one the pause hasn't stopped. */
const WORKING: ReadonlySet<string> = new Set([
  "message.delta",
  "message.interim",
  "reasoning.available",
  "tool.started",
  "tool.completed",
  "subagent.start",
  "subagent.complete",
]);

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
  /**
   * What was said in the room to others after it arrived, while it waited as the newest (Chips ADR
   * 0294): its turn is told, so it starts on the room as it is.
   */
  readonly since: Heard[];
}

/** Whether a waiting message may share a turn with others: not a fix turn's, nor one Chips handed over. */
function shares(asked: Asked): boolean {
  return asked.goal === undefined && folds(asked.message);
}

/**
 * The waiting messages that make an agent's next turn (Chips ADR 0294), taken off its queue, oldest
 * first: all of them, up to one that is a turn of its own, which is the turn after.
 */
function nextTurn(queue: Asked[]): Asked[] {
  const first = queue.shift();
  if (first === undefined) return [];
  const taken = [first];
  if (!shares(first)) return taken;
  while (queue[0] !== undefined && shares(queue[0]) && queue[0].speakerId === first.speakerId) {
    taken.push(queue.shift() as Asked);
  }
  return taken;
}

/**
 * A message for an agent as the turn it has going is told it (Chips ADR 0294): Chips's word on the
 * agents' talk where it sent one, then who said it and what, and its files, as a turn's own words
 * are said.
 */
export function joinedWords(message: MessageNew): string {
  const who = withRole(message.from.display_name, message.from);
  const files = (message.attachments ?? []).map(renderAttachment);
  return [message.exchange?.note, [`${who}: ${message.text}`, ...files].join("\n")]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
}

interface Room {
  /** Which agent's session in which room: its key in `BridgeState.sessions`. */
  readonly id: string;
  readonly agent: Running;
  readonly spaceId: string;
  readonly queue: Asked[];
  busy: boolean;
  /** The turn going in it. */
  turn?: Turn | undefined;
  /** It is about to start: a moment in which all it is sent at once gathers (Chips ADR 0294). */
  gathering?: NodeJS.Timeout | undefined;
  /**
   * The messages its session has been given, the newest of them: one that arrives while their turn
   * goes is sent with them among the lines since, and its turn leaves them out (Chips ADR 0294).
   */
  readonly answered: string[];
}

/** An approval Hermes asked for, and whether the answer came from here. */
interface Pending {
  readonly approvalId: string;
  answered: boolean;
  /** The Hermes run that asked: an ask of a run that has ended waits on nothing. */
  readonly hermesRun: string;
  /** The steps going when it asked, one of them the call that waits: once all have ended, Hermes has stopped waiting. */
  readonly during: readonly string[];
}

/** The turn going in a room: the Chips run, the Hermes run, and what has come back. */
interface Turn {
  readonly run: Run;
  readonly speaker: Speaker;
  readonly agent: Running;
  /** The Chips agent whose turn it is: whose model its runs ask for. */
  readonly who: string;
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
  /** Whether a Hermes run of the turn is going: started, and not yet at its end. */
  live: boolean;
  /** The Hermes run going was stopped for a pause (Chips ADR 0293): its end holds the turn, and doesn't end it. */
  pausing: boolean;
  /** The next Hermes run carries on after a pause: its instructions say only its answer is posted. */
  carried: boolean;
  /** Words said in the room while it works, steered into the Hermes run going: heard once it gives them (Chips ADR 0106). */
  readonly overheard: { readonly messageId: string; readonly line: string }[];
  /**
   * Messages for its agent that came while its Hermes run was going and were steered into it
   * (Chips ADR 0294), each with the words Hermes was given: heard once the run completes with
   * them, and back to wait for the next turn where Hermes kept them back or the run ended otherwise.
   */
  readonly joined: { readonly asked: Asked; readonly line: string }[];
  /** The folder the agent works in and its files are sent from, said in each run's instructions. */
  folder?: string | undefined;
  /** The room's rules, said in each run's instructions rather than in its words (Chips ADR 0250). */
  rules?: string | undefined;
  /** The agent's copy of the room's project, brought up to date as the turn began, and its name (Chips ADR 0221). */
  project?: { readonly copy: Project; readonly name: string } | undefined;
}

export class Bridge {
  private readonly agents: Running[] = [];
  private readonly rooms = new Map<string, Room>();
  /** What is said in the rooms is taken in the order it came: a message, then what was overheard after it. */
  private arriving: Promise<unknown> = Promise.resolve();
  /** The turns going, by their Chips run, for what is said in their rooms while they work (Chips ADR 0106). */
  private readonly working = new Map<string, Turn>();
  /** Every Chips agent of the harness's, configured here or not. */
  private ours = new Set<string>();
  /** The harness's agents' names, by Chips id, for the folders named after them. */
  private readonly names = new Map<string, string>();
  /** The agents made in Chips with a profile of their own, by Chips id (Chips ADR 0241). */
  private readonly own = new Map<string, Running>();
  /** The feedback events answered with a turn, the newest `KEPT_FEEDBACK`. */
  private readonly lookedAt = new Set<string>();
  /**
   * The agents made, the spaces claimed and the copies made, one after another: a message for an
   * agent not settled yet waits for them (see `runnerOf`).
   */
  private making: Promise<void> = Promise.resolve();
  private readonly log: (line: string) => void;
  private health: ReturnType<typeof setInterval> | undefined;
  /** The harness's agents in Chips as last listed: whose context and window copies are sent. */
  private listed: Agent[] = [];
  /** The agents' context files (Chips ADR 0134), when the bridge knows where Hermes keeps them. */
  private readonly contexts: Contexts | undefined;
  private contextTimer: ReturnType<typeof setInterval> | undefined;
  /** The agents' context windows (Chips ADR 0146), when Hermes's webhook has somewhere to reach. */
  private readonly fills: Fills | undefined;
  /** The port Hermes's webhook reaches the bridge on, once it listens. */
  private fillsPort: number | undefined;
  private toldNoReadings = false;
  /** Whether the log has said once that a model copy wasn't sent. */
  private toldModels = false;
  /** While Hermes's gateway restarts (Chips ADR 0094), the health watch says nothing: the restart says how it went. */
  private held = false;
  /** Restarts begun, so a health check asked before one, and answered after, is let go. */
  private holds = 0;
  /** What went wrong in the last restart, said in place of the watch's own words while Hermes doesn't answer. */
  private why: string | undefined;

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
    const { chips, hermesRoot } = options;
    if (hermesRoot === undefined) return;
    this.contexts = new Contexts(
      () => this.roster(),
      {
        agent: (agentId, copy) => chips.settings.context(agentId, copy),
        harness: (copy) => chips.settings.harnessContext(copy),
      },
      (line) => this.log(`context: ${line}`),
      options.env ?? process.env,
    );
    if (options.fills === undefined) return;
    const kept = (options.state.fills ??= {});
    this.fills = new Fills({
      whose: (sessionId) => this.whoseSession(sessionId),
      profileOf: (agentId) => {
        const profile = this.profileFor(agentId);
        return profile === undefined ? undefined : { profile: profile.name, home: profile.home };
      },
      secretFor: (profile) => envValue(profileHome(hermesRoot, profile), SECRET_ENV) ?? kept.secret ?? options.fills?.secret,
      send: (agentId, copy) => chips.settings.contextWindow(agentId, copy),
      kept,
      save: () => options.saveState(options.state),
      log: (line) => this.log(`context window: ${line}`),
      sendEveryMs: options.fillsEveryMs,
    });
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
    for (const [agentId, profile] of Object.entries(this.options.state.made ?? {})) {
      const running = this.runningOn(agentId, profile, known.find((agent) => agent.agentId === agentId)?.name ?? profile);
      if (running !== undefined) this.own.set(agentId, running);
    }
    this.ours = new Set([...known.map((agent) => agent.agentId), ...this.agents.map((agent) => agent.agentId)]);
    // Taken in the order they came: a message, then what was overheard after it (Chips ADR 0294).
    const inOrder = (what: string, then: () => Promise<void>) => {
      this.arriving = this.arriving.then(then).catch((error: unknown) => this.log(`${what} went wrong: ${messageOf(error)}`));
    };
    chips.on("message.new", (message) => inOrder("a message", () => this.hear(message)));
    chips.on("message.overheard", (message) => inOrder("words overheard", () => this.overheard(message)));
    chips.on("agent.asked", (asked) => {
      this.making = this.making
        .then(() => this.make(asked))
        .catch((error: unknown) => this.log(`a new agent went wrong: ${messageOf(error)}`));
    });
    chips.on("agent.fork", (fork) => {
      this.making = this.making
        .then(() => this.copy(fork))
        .catch((error: unknown) => this.log(`a copy went wrong: ${messageOf(error)}`));
    });
    chips.onSpaceAsked((asked) => {
      this.making = this.making
        .then(() => this.claim(asked))
        .catch((error: unknown) => this.log(`a space from the + went wrong: ${messageOf(error)}`));
    });
    chips.on("feedback", (feedback) => {
      this.notRight(feedback).catch((error: unknown) => this.log(`a note on a reply went wrong: ${messageOf(error)}`));
    });
    // An agent put in a room or taken out may be one made, archived or deleted: who reads what moves.
    chips.on("agent.attached", () => void this.agentsMoved());
    chips.on("agent.released", () => void this.agentsMoved());
    await this.sayHowItIs();
    this.health = setInterval(() => void this.sayHowItIs(), this.options.healthEveryMs ?? 30_000);
    this.health.unref();
    await this.startSettings();
  }

  /** Hold the health watch's words while Hermes's gateway restarts, and let them go after. */
  hold(held: boolean): void {
    if (held && !this.held) this.holds += 1;
    this.held = held;
  }

  /**
   * How a restart went (Chips ADR 0094): fine as the gateways now are, or its words, which stand
   * while Hermes doesn't answer. The health watch speaks for itself again after.
   */
  async restarted(trouble: string | undefined): Promise<void> {
    this.held = false;
    this.why = trouble;
    if (trouble === undefined) return this.sayHowItIs();
    await this.options.chips.reportTrouble(trouble).catch(() => undefined);
  }

  stop(): void {
    if (this.health !== undefined) clearInterval(this.health);
    for (const room of this.rooms.values()) clearTimeout(room.gathering);
    if (this.contextTimer !== undefined) clearInterval(this.contextTimer);
    void this.fills?.close();
  }

  // ------------------------------------------------------------------ an agent's page

  /**
   * The agents' models, context and context windows, sent at start and kept current: the models
   * again when an agent comes or goes, the files read again every so often and after each turn, a
   * window copy on each reading Hermes sends.
   */
  private async startSettings(): Promise<void> {
    this.listed = await this.options.chips.agents.list().catch(() => this.listed);
    await this.sendModels();
    if (this.contexts === undefined) return;
    await this.contexts.refresh();
    this.contextTimer = setInterval(() => void this.contexts?.refresh(), this.options.contextEveryMs ?? 15_000);
    this.contextTimer.unref();
    const fills = this.fills;
    const asked = this.options.fills;
    if (fills === undefined || asked === undefined) return;
    const kept = (this.options.state.fills ??= {});
    try {
      this.fillsPort = await fills.listen(asked.port);
      if (kept.port !== this.fillsPort) {
        kept.port = this.fillsPort;
        this.options.saveState(this.options.state);
      }
    } catch (error) {
      this.log(`context window: nothing can listen on port ${asked.port} (${messageOf(error)}), so Chips won't show how full each agent's context is`);
    }
    await fills.sendAll();
  }

  /** The address Hermes's webhook POSTs a profile's readings to, once the bridge listens. */
  hookUrl(profile = "default"): string | undefined {
    return this.fillsPort === undefined ? undefined : hookUrl(this.fillsPort, profileName(profile));
  }

  /** The harness's agents listed again, the copies of any gone forgotten, and the context and models sent. */
  private async agentsMoved(): Promise<void> {
    const before = this.listed;
    this.listed = await this.options.chips.agents.list().catch(() => this.listed);
    const now = new Set(this.active().map((agent) => agent.agentId));
    for (const gone of before) {
      if (now.has(gone.agentId)) continue;
      this.options.chips.settings.forget(gone.agentId);
      this.fills?.forget(gone.agentId);
    }
    await this.contexts?.refresh();
    await this.sendModels();
  }

  /** The harness's agents that read anything now: the active ones listed. */
  private active(): Agent[] {
    return this.listed.filter((agent) => agent.state === "active");
  }

  /** A profile as the context needs it: its name and its home under Hermes's root. */
  private profileOfRunning(agent: Running): Profile | undefined {
    const root = this.options.hermesRoot;
    if (root === undefined) return undefined;
    return { name: profileName(agent.config.address.profile), home: profileHome(root, agent.config.address.profile) };
  }

  /** The profile an agent runs on: its own, a copy's original's, else the first (as `profileOf` picks). */
  private profileFor(agentId: string): Profile | undefined {
    const running = this.runningFor(agentId);
    return running === undefined ? undefined : this.profileOfRunning(running);
  }

  /** What answers for an agent: its own profile, a copy's original's, else the first. */
  private runningFor(agentId: string): Running | undefined {
    const own = this.agents.find((agent) => agent.agentId === agentId) ?? this.own.get(agentId);
    const copied = this.options.state.profiles?.[agentId];
    return own ?? (copied === undefined ? undefined : this.byKey(copied)) ?? this.agents[0];
  }

  /** A profile the bridge speaks to, by its key: a configured agent's, or a made agent's Chips id. */
  private byKey(key: string): Running | undefined {
    return this.agents.find((agent) => agent.key === key) ?? this.own.get(key);
  }

  /**
   * Who reads what: each active agent with its profile, and the first profile, whose SOUL.md each
   * new agent starts from (and whose every file each new agent reads, where none gets a profile of
   * its own).
   */
  private roster(): Roster {
    const readers: Reader[] = [];
    const ids = new Set([...this.active().map((agent) => agent.agentId), ...this.agents.map((agent) => agent.agentId)]);
    for (const agentId of ids) {
      if (this.listed.some((agent) => agent.agentId === agentId && agent.state !== "active")) continue;
      const profile = this.profileFor(agentId);
      if (profile !== undefined) readers.push({ agentId, profile });
    }
    const first = this.agents[0];
    return {
      readers,
      first: first === undefined ? undefined : this.profileOfRunning(first),
      ownProfiles: this.options.profiles !== undefined,
    };
  }

  /** The agent a Hermes session the bridge keeps is, with its profile: nothing for any other. */
  private whoseSession(sessionId: string): { agentId: string; profile: string; home: string } | undefined {
    const entry = Object.entries(this.options.state.sessions).find(([, session]) => session === sessionId);
    if (entry === undefined) return undefined;
    const who = entry[0].slice(0, entry[0].lastIndexOf("|"));
    const agentId = this.agents.find((agent) => agent.key === who)?.agentId ?? who;
    const profile = this.profileFor(agentId);
    return profile === undefined ? undefined : { agentId, profile: profile.name, home: profile.home };
  }

  /** A person's edit of a context file from Chips (Chips ADR 0134), saved and answered. */
  async onContextEdit(frame: ContextEditFrame): Promise<AgentContextCopy | HarnessContextCopy> {
    if (this.contexts === undefined) throw new Refuse("This bridge reads no context files.");
    if (frame.agent_id !== undefined && !this.listed.some((agent) => agent.agentId === frame.agent_id)) {
      this.listed = await this.options.chips.agents.list().catch(() => this.listed);
    }
    return this.contexts.edit(frame);
  }

  // ------------------------------------------------------------------ an agent's model

  /**
   * The model a person picked for an agent, as its copy names it: a choice's id, or the model its
   * config says each of its profile's runs asks for; nothing for Hermes's default.
   */
  private ownModel(agentId: string, running: Running): string | undefined {
    const picked = this.options.state.models?.[agentId];
    return picked === null ? undefined : (picked ?? running.config.model);
  }

  /** What a turn's runs ask Hermes for: the agent's own model, else nothing, and the profile's runs. */
  private runModel(turn: Turn): RunModel {
    const picked = this.options.state.models?.[turn.who];
    if (picked === null) return {};
    if (picked !== undefined) return runModelOf(picked);
    return turn.agent.config.model === undefined ? {} : { model: turn.agent.config.model };
  }

  /**
   * Each agent's model, sent to Chips (Chips ADR 0141): the models Hermes has for its profile, read
   * once a profile, with the one it runs on. One whose Hermes doesn't answer is sent none, and the
   * log says so once.
   */
  private async sendModels(): Promise<void> {
    const { chips } = this.options;
    const ids = new Set([...this.active().map((agent) => agent.agentId), ...this.agents.map((agent) => agent.agentId)]);
    const read = new Map<Running, Promise<ModelOptions>>();
    for (const agentId of ids) {
      const running = this.runningFor(agentId);
      if (running === undefined) continue;
      try {
        let options = read.get(running);
        if (options === undefined) {
          options = running.client.modelOptions();
          read.set(running, options);
        }
        const copy = copyOf(await options, this.ownModel(agentId, running));
        if (copy !== undefined) await chips.settings.model(agentId, copy);
      } catch (error) {
        if (!this.toldModels) this.log(`models: none sent for ${running.config.name}: ${messageOf(error)}`);
        this.toldModels = true;
      }
    }
  }

  /**
   * A person picked an agent's model (Chips ADR 0141): one Hermes has for its profile, kept as the
   * model each of its runs asks for from now on, or Hermes's default (`null`), the profile's own.
   * The model it runs on already changes nothing. Hermes says no levels of effort, so none is taken.
   */
  async onModelChange(frame: ModelChangeFrame): Promise<AgentModelCopy> {
    const { state } = this.options;
    const agentId = frame.agent_id;
    const ours =
      this.ours.has(agentId) || this.agents.some((agent) => agent.agentId === agentId) || this.own.has(agentId);
    const running = ours ? this.runningFor(agentId) : undefined;
    if (running === undefined) throw new Refuse(`${agentId} isn't one of this harness's agents.`);
    let options: ModelOptions;
    try {
      options = await running.client.modelOptions();
    } catch (error) {
      throw new Refuse(`Hermes didn't say which models it has: ${messageOf(error)}`);
    }
    const now = copyOf(options, this.ownModel(agentId, running));
    if (now === undefined) throw new Refuse("Hermes has no model for this agent's profile.");
    if (frame.model === now.model) return now;
    if (frame.model !== null && !now.choices.some((choice) => choice.id === frame.model)) {
      throw new Refuse(`Hermes has no ${frame.model} for this agent's profile.`, now);
    }
    state.models = { ...state.models, [agentId]: frame.model };
    this.options.saveState(state);
    const name = await this.nameOf(agentId, running.config.name);
    this.log(`${name} runs on ${frame.model ?? `Hermes's default (${now.default?.model ?? "its profile's"})`}, from Chips`);
    return copyOf(options, this.ownModel(agentId, running)) ?? now;
  }

  /** A person's Compact now (Chips ADR 0146): Hermes can't be asked to compact from outside a run. */
  onWindowCompact(frame: WindowCompactFrame): AgentContextWindowCopy {
    throw new Refuse(WHY_NOT, this.fills?.copyOf(frame.agent_id));
  }

  /** A person's limit (Chips ADR 0146): Hermes sets it in its profile's config, for all its agents. */
  onWindowChange(frame: WindowChangeFrame): AgentContextWindowCopy {
    const profile = this.profileFor(frame.agent_id);
    throw new Refuse(whyReadOnly(profile?.name ?? "default"), this.fills?.copyOf(frame.agent_id));
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
   * room waits. It answers through a Hermes profile of its own (`ownProfile`).
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
    this.names.set(agent.agentId, agent.name);
    this.log(`${agent.name} made${agent.attached === false ? `, not in the room: ${agent.why ?? "too late"}` : ""}`);
    await this.ownProfile(agent.agentId, agent.name);
    this.ours.add(agent.agentId);
    void this.agentsMoved();
  }

  /**
   * A Hermes profile of its own for an agent made in Chips (Chips ADR 0241), so it remembers only
   * its own conversations: named after the agent, cloned from the Main agent's profile so it starts
   * with its model, keys, tools, skills and SOUL.md, its memory empty (`profiles.ts`). The gateway
   * is asked to serve it now; one that serves only the profile it started with, as Hermes's does
   * when it started with one, is restarted once. Where Hermes doesn't make one, the agent runs on
   * the first profile, in a session of its own, and the log says why.
   */
  private async ownProfile(agentId: string, name: string): Promise<void> {
    const { profiles, hermesRoot: root, state } = this.options;
    const main = this.agents[0];
    if (profiles === undefined || root === undefined || main === undefined || this.own.has(agentId)) return;
    const from = profileName(main.config.address.profile);
    const profile = freeProfile(root, name, Object.values(state.made ?? {}));
    const home = profileHome(root, profile);
    const secret = state.fills?.secret ?? this.options.fills?.secret;
    try {
      await profiles.create(profile, from);
      const port = this.fillsPort;
      const hook = readyProfile(home, { from, profile }, port === undefined || secret === undefined ? undefined : { port, secret });
      if (hook?.state === "by_hand") this.log(`context window: ${hook.path} was left as it is: ${hook.why}. Add these lines to it:\n${hook.lines}`);
    } catch (error) {
      this.log(`${name} runs on the ${from} profile, in a session of its own: Hermes didn't make it one (${messageOf(error)})`);
      return;
    }
    state.made = { ...state.made, [agentId]: profile };
    this.options.saveState(state);
    const running = this.runningOn(agentId, profile, name);
    if (running !== undefined) this.own.set(agentId, running);
    this.log(`${name} has a Hermes profile of its own, ${profile}, cloned from ${from}`);
    const served = await profiles.serve().catch(() => undefined);
    if (served === false) {
      this.log(`Hermes's gateway serves only the profile it started with, as it does when there was one: restarting it once, so it serves ${profile} too`);
      await this.options.restartGateway?.();
    } else if (served === undefined) {
      this.log(`Hermes's gateway didn't answer on its control socket: it serves ${profile} once it looks again, or starts again`);
    }
  }

  /**
   * A profile made for an agent, as the bridge reaches it: under `/p/<profile>` of the gateway the
   * Main agent is reached at, with the key in the profile's own `.env`.
   */
  private runningOn(agentId: string, profile: string, name: string): Running | undefined {
    const main = this.agents[0];
    const root = this.options.hermesRoot;
    if (main === undefined || root === undefined) return undefined;
    const home = profileHome(root, profile);
    const config: AgentConfig = {
      name,
      address: { url: main.config.address.url, profile, key: envValue(home, KEY_ENV) ?? "" },
      keyEnv: KEY_ENV,
      keyFrom: join(home, ".env"),
    };
    const client = this.options.clientFor?.(config) ?? new HermesClient(config.address);
    return { config, key: agentId, client, agentId, up: true };
  }

  /**
   * A space a person asked the harness for from the + (Chips ADR 0241), as the ACP bridge takes
   * one: claimed under a key made from the space, so a space handed over twice is claimed once,
   * and named from its first words. Chips makes the agent of that key and puts it in the space; it
   * gets a Hermes profile of its own (`ownProfile`). It answers the first words, which are the
   * ask's and aren't heard again.
   */
  private async claim(asked: SpaceAsked): Promise<void> {
    const { chips } = this.options;
    const { spaceId, firstMessage } = asked;
    const key = `hermes:space:${spaceId}`;
    await chips.claimSpace(spaceId, key, titleFrom(firstMessage.text));
    const agent = (await chips.agents.list()).find((each) => each.key === key);
    if (agent === undefined) {
      this.log(`claimed ${spaceId}, and Chips put no agent there`);
      return;
    }
    this.names.set(agent.agentId, agent.name);
    this.log(`${agent.name} claimed ${spaceId}`);
    await this.ownProfile(agent.agentId, agent.name);
    this.ours.add(agent.agentId);
    void this.agentsMoved();
    // Said to the agent as a message of the person's, under the first words' own id, with the
    // room's note Chips wrote for the harness before the agent was made (Chips ADR 0092's
    // addendum), or alone when they were read from the room's history.
    const message =
      firstTurnOf(asked, agent.agentId) ??
      ({
        type: "message.new",
        space_id: spaceId,
        message_id: firstMessage.messageId,
        text: firstMessage.text,
        from: { participant_id: asked.askedBy, kind: "person", display_name: await this.whoSaid(asked), role: "member" },
        for: [agent.agentId],
      } as unknown as MessageNew);
    void this.hear(message);
  }

  /** Who said a space's first words, from its lines. */
  private async whoSaid(asked: SpaceAsked): Promise<string> {
    const context = await this.options.chips.roomContext(asked.spaceId, { limit: 20 }).catch(() => undefined);
    return context?.lines.find((line) => line.message_id === asked.firstMessage.messageId)?.from.name ?? "Someone";
  }

  /**
   * A person asked for a copy of one of the harness's agents in another room (ADR 0087, Fork): the
   * agent's session in the room it is in, else the last it had, forked in Hermes, is the copy's
   * session in the room asked. The copy answers through its original's profile, whose Hermes has
   * that session (Hermes forks a session only within its profile, so a copy gets no profile of its
   * own: Chips ADR 0241), and works in its original's folder. It is registered with `forkedFrom` for the
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
        : await original.client.forkSession(from, { id: `chips-fork-${fork.id}`, title: `Chips space ${spaceId} · ${key}` });
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
    void this.agentsMoved();
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
      turn.project = { copy: project, name };
      return facts;
    } catch (error) {
      this.log(`${name}'s copy of the room's project couldn't be readied: ${messageOf(error)}`);
      return undefined;
    }
  }

  /**
   * What the turn changed in its copy, sent to the room's project before its words are posted: the
   * commit it left `main` at, for the reply to carry (Chips ADR 0222), when it sent one; else, when
   * the change didn't go, the line the reply says so in (Chips AP-6).
   */
  private async sendProject(turn: Turn, words: string): Promise<{ change?: string; note?: string }> {
    if (turn.project === undefined) return {};
    const { copy, name } = turn.project;
    try {
      const pushed = await copy.push({ words });
      this.log(`${name}'s project: ${pushedInWords(pushed)}`);
      if (pushed.state === "sent") return { change: pushed.commit };
      const note = heldNote(pushed, name);
      return note === undefined ? {} : { note };
    } catch (error) {
      this.log(`${name}'s project couldn't be sent: ${messageOf(error)}`);
      const note = heldNote({ state: "failed", why: messageOf(error) }, name);
      return note === undefined ? {} : { note };
    }
  }

  /**
   * Trouble while a profile's gateway doesn't answer, and fine once all do (ADR 0083); nothing while
   * a restart runs, nor answers to a check asked before one began, even one over by now: they are of
   * the gateways before, and a failed restart's words would go.
   */
  private async sayHowItIs(): Promise<void> {
    if (this.held) return;
    const holds = this.holds;
    const answers = new Map<Running, boolean>();
    for (const agent of this.agents) answers.set(agent, await agent.client.healthy());
    if (this.holds !== holds) return;
    for (const [agent, up] of answers) agent.up = up;
    const down = this.agents.filter((agent) => !agent.up);
    if (down.length === 0) this.why = undefined;
    const chips = this.options.chips;
    const said =
      down.length === 0
        ? chips.reportOk()
        : chips.reportTrouble(this.why ?? `Hermes isn't answering for ${down.map((agent) => agent.config.name).join(", ")}`);
    await said.catch(() => undefined);
  }

  // ------------------------------------------------------------------ what is said to it

  /**
   * A message for some of its agents: each takes it in its room, one turn at a time there. Where
   * the agent's Hermes run is going it is steered into it; else it waits, and is in the agent's
   * next turn with whatever else waits (Chips ADR 0294).
   */
  private async hear(message: MessageNew, how: Pick<Asked, "goal" | "sayWho"> = {}): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    const takes = new Set<Room>();
    for (const taker of message.for ?? [harnessId]) {
      const agent = await this.runnerOf(taker);
      if (agent === undefined) continue;
      const room = this.roomOf(agent, taker, spaceId);
      takes.add(room);
      const asked: Asked = { message, speakerId: taker === harnessId ? undefined : taker, ...how, since: [] };
      if (await this.joins(room, asked)) continue;
      room.queue.push(asked);
      this.soon(room);
    }
    // To its other agents in the room it was said to somebody else, as what they overhear is.
    if (how.goal === undefined) this.saidToOthers(spaceId, message, takes);
  }

  /**
   * Whether a message joined the turn its agent has going (Chips ADR 0294): steered into the
   * Hermes run, which Hermes gives the model after the step it is on, so the one answer is to it
   * too. Not while anything waits ahead of it, nor a reply to a message, a fix turn's or one Chips
   * handed over, whose turn says more than its words; nor where Hermes won't take a steer, as when
   * the run is ending or stopped for a pause.
   */
  private async joins(room: Room, asked: Asked): Promise<boolean> {
    const turn = room.turn;
    if (turn === undefined || room.queue.length > 0 || !shares(asked) || asked.message.replying_to !== undefined) return false;
    if (!turn.live || turn.hermesRun === "" || turn.cancelled || turn.pausing || turn.run.over || turn.run.paused) return false;
    const line = joinedWords(asked.message);
    try {
      await turn.agent.client.steer(turn.hermesRun, line);
    } catch {
      return false;
    }
    // The turn ended while Hermes answered: nothing is left to settle the words, so they wait.
    if (room.turn !== turn) return false;
    turn.joined.push({ asked, line });
    this.log(`${turn.agent.config.name} takes a message into its turn going in ${room.spaceId}`);
    return true;
  }

  /**
   * What became of the messages steered into a Hermes run, now it has ended (Chips ADR 0294). Each
   * the run completed with is heard, and the room shows the agent heard it while working. One
   * Hermes kept back (`pending_steer`), or in a run that failed or was stopped, goes back to wait,
   * first in line, and is in the agent's next turn. A run stopped for a pause is neither: what it
   * kept back is in the words that carry on, and they are settled when that run ends.
   */
  private async settleJoined(turn: Turn, room: Room, last: RunEvent | undefined): Promise<void> {
    if (turn.joined.length === 0) return;
    if (last?.event === "run.cancelled" && turn.pausing && !turn.cancelled) return;
    const kept = typeof last?.["pending_steer"] === "string" ? last["pending_steer"] : "";
    const back: Asked[] = [];
    for (const { asked, line } of turn.joined.splice(0)) {
      if (last?.event !== "run.completed" || kept.includes(line)) {
        back.push(asked);
        continue;
      }
      const { message_id: messageId } = asked.message;
      keepAnswered(room.answered, [asked.message]);
      await turn.run.heard(messageId).catch((error: unknown) => this.log(`couldn't say a turn heard ${messageId}: ${messageOf(error)}`));
    }
    room.queue.unshift(...back);
  }

  /** Kept by each of its agents in the room with a message waiting, but those it is for, and the one who said it. */
  private saidToOthers(spaceId: string, said: Heard, takes: ReadonlySet<Room>): void {
    for (const room of this.rooms.values()) {
      const newest = room.queue.at(-1);
      if (newest === undefined || room.spaceId !== spaceId || takes.has(room)) continue;
      const who = room.id.slice(0, room.id.lastIndexOf("|"));
      if (said.from.participant_id === (who === room.agent.key ? room.agent.agentId : who)) continue;
      keepHeard(newest.since, { from: said.from, text: said.text, attachments: said.attachments, held: said.held });
    }
  }

  /**
   * An idle agent starts in a moment, not at once (Chips ADR 0294): a bridge that comes back is
   * sent all it missed together, and what waits when a turn starts is one turn.
   */
  private soon(room: Room): void {
    if (room.busy || room.gathering !== undefined) return;
    room.gathering = setTimeout(() => {
      room.gathering = undefined;
      void this.pump(room);
    }, this.options.gatherMs ?? GATHER_MS);
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
   * Which profile answers for a Chips agent, as `profileOf` says. An agent not settled may be one
   * being made, or a copy, which is waited for, so that its first message is answered on its own
   * profile, or in the session it was forked.
   */
  private async runnerOf(taker: string): Promise<Running | undefined> {
    const settled =
      taker === this.options.chips.harnessId || this.own.has(taker) || this.agents.some((agent) => agent.agentId === taker);
    if (!settled) await this.making;
    return this.profileOf(taker);
  }

  /**
   * Which profile answers for a Chips agent: its own, configured or made for it; a copy's
   * original's; or the first for the harness itself and for any other of the harness's — its
   * default agent, one made before profiles were — read afresh once when a name is new.
   */
  private async profileOf(taker: string): Promise<Running | undefined> {
    const own = this.agents.find((agent) => agent.agentId === taker) ?? this.own.get(taker);
    if (own !== undefined) return own;
    const copied = this.options.state.profiles?.[taker];
    const original = copied === undefined ? undefined : this.byKey(copied);
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
      room = { id, agent, spaceId, queue: [], busy: false, answered: [] };
      this.rooms.set(id, room);
    }
    return room;
  }

  private async pump(room: Room): Promise<void> {
    if (room.busy) return;
    const waiting = nextTurn(room.queue);
    if (waiting.length === 0) return;
    room.busy = true;
    try {
      await this.turn(room, waiting);
    } catch (error) {
      this.log(`a turn of ${room.agent.config.name} went wrong: ${messageOf(error)}`);
    } finally {
      room.busy = false;
      // A turn may have changed what the agent is built from (its memory): the copies are read again.
      void this.contexts?.refresh();
      void this.pump(room);
    }
  }

  /**
   * One turn on what waited (Chips ADR 0294): the newest message's, whose note and lines it is
   * handed, with those that waited ahead of it said in full, and what was said after to others.
   */
  private async turn(room: Room, waiting: readonly Asked[]): Promise<void> {
    const { message, speakerId, goal } = waiting.at(-1) as Asked;
    const { agent, spaceId } = room;
    const speaker = speakerId === undefined ? this.options.chips : this.options.chips.as(speakerId);
    const run = await speaker.runs.start({ spaceId, goal: goal ?? goalOf(message, agent.config.name) });
    this.sayPausable(run, speakerId);
    const turn: Turn = {
      run,
      speaker,
      agent,
      who: speakerId ?? agent.agentId,
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
      live: false,
      pausing: false,
      carried: false,
      overheard: [],
      joined: [],
    };
    this.working.set(run.id, turn);
    room.turn = turn;
    try {
      await this.take(turn, room, waiting);
    } finally {
      this.working.delete(run.id);
      room.turn = undefined;
      // Steered into a turn that ended before it settled them, as one stopped while paused: they wait again.
      room.queue.unshift(...turn.joined.splice(0).map((each) => each.asked));
    }
  }

  /**
   * That the run can pause (Chips ADR 0293), said once as it starts, on a status of "Thinking…",
   * which no client draws as a thought. The SDK this bridge bundles (1.0.4) can't say `pausable`
   * in `run.status()`, so it goes on the connection's own `send`, in the envelope the SDK gives
   * the run: its space, itself, and the agent it is. A server from before drops the field, and
   * its runs offer Stop alone; a status that doesn't go fails nothing.
   */
  private sayPausable(run: Run, speakerId: string | undefined): void {
    const envelope = {
      space_id: run.spaceId,
      run_id: run.id,
      ...(speakerId === undefined ? {} : { actor: { kind: "agent", id: speakerId } }),
    };
    void Promise.resolve()
      .then(() => this.options.chips.send("run.status", envelope, { phase: "thinking", verb_phrase: "Thinking…", pausable: true }))
      .catch((error: unknown) => this.log(`couldn't say run ${run.id} can pause: ${messageOf(error)}`));
  }

  /** A turn begun: Hermes's runs of it, from the first words to its end. */
  private async take(turn: Turn, room: Room, waiting: readonly Asked[]): Promise<void> {
    const { message, speakerId, sayWho, since } = waiting.at(-1) as Asked;
    const earlier = waiting.slice(0, -1).map((each) => each.message);
    const { agent } = room;
    const { run } = turn;
    // Heard from the start, so a Stop before Hermes has the run still stops it.
    run.on("cancel", () => {
      turn.cancelled = true;
      if (turn.hermesRun !== "") void agent.client.stop(turn.hermesRun).catch(() => undefined);
    });
    // A Pause with no Hermes run going holds the next prompt instead (`resumed`).
    run.on("pause", () => this.pauseHermes(turn));
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
    turn.rules = rulesFor(message, { taker: speakerId, project });
    let text: string | undefined = promptForAll(message, {
      taker: speakerId,
      sayWho,
      project,
      rulesHeld: true,
      earlier,
      since,
      answered: room.answered,
    });
    if (earlier.length > 0) this.log(`${agent.config.name} takes ${waiting.length} messages that waited in ${room.spaceId} as one turn`);
    for (let round = 0; text !== undefined && !turn.cancelled && !run.over; round += 1) {
      if (!(await this.resumed(turn))) return;
      const last = await this.once(turn, session, text, `${run.id}:${round}`);
      // Its session holds them once Hermes has run on them, however the turn goes on from here.
      if (round === 0 && last !== undefined) keepAnswered(room.answered, [...earlier, message]);
      await this.settleJoined(turn, room, last);
      if (last === undefined) return;
      const paused = turn.pausing;
      turn.pausing = false;
      // Stopped for a pause: Hermes's end of that run is not the turn's.
      if (last.event === "run.cancelled" && paused && !turn.cancelled) {
        text = await this.carryOn(turn, last);
        continue;
      }
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

  /** Whether the turn goes on: at once, or once a pause is resumed; not once the run is stopped. */
  private async resumed(turn: Turn): Promise<boolean> {
    await turn.run.whenRunning();
    return !turn.cancelled && !turn.run.over;
  }

  /**
   * A paused run's Hermes run stopped where it is (Chips ADR 0293), as Stop stops it, but marked as
   * pausing, so that its end holds the turn and doesn't end it. Not while it waits on a person's
   * answer, which a pause doesn't interrupt; nor with no Hermes run going, where the next prompt
   * is held instead. A stop that doesn't reach Hermes is tried again at its next event.
   */
  private pauseHermes(turn: Turn): void {
    if (!turn.run.paused || turn.run.over || turn.cancelled || !turn.live || turn.pausing || this.asking(turn)) return;
    turn.pausing = true;
    const hermesRun = turn.hermesRun;
    void turn.agent.client.stop(hermesRun).catch((error: unknown) => {
      if (turn.hermesRun === hermesRun) turn.pausing = false;
      this.log(`Hermes didn't stop ${turn.agent.config.name}'s run ${hermesRun} for a pause: ${messageOf(error)}`);
    });
  }

  /**
   * Whether the Hermes run going waits on a person's answer to an ask: not once it is answered,
   * here or in Hermes's own tools, nor once every step going when it asked has ended, the call
   * that waited among them (Hermes gives up waiting after its own timeout, and goes on).
   */
  private asking(turn: Turn): boolean {
    const open = new Set([...turn.open.values()].flat());
    return [...turn.approvals.values()].some(
      (pending) =>
        !pending.answered &&
        pending.hermesRun === turn.hermesRun &&
        (pending.during.length === 0 || pending.during.some((stepId) => open.has(stepId))),
    );
  }

  /**
   * A Hermes run stopped for a pause (Chips ADR 0293). What it did stays in its session, as
   * Hermes keeps it: the calls it made, and the words it had written, marked as cut short. None
   * of it is posted, and the run doesn't end. The half-written words are dropped from the reply:
   * the run that carries on is told to give its whole answer (`CARRIED_ON`), which is the reply,
   * so the room reads one answer. Once resumed, the same session is told to carry on, with what
   * Hermes kept back of what was steered into the stopped run and what was steered while paused.
   * Nothing, once the run is stopped while paused: the server has ended it.
   */
  private async carryOn(turn: Turn, last: RunEvent): Promise<string | undefined> {
    await this.closeSteps(turn, "failed", "Paused before it finished.");
    await this.counted(turn, last);
    turn.reply = "";
    if (!(await this.resumed(turn))) return undefined;
    // An interrupt's words, said while it was paused, are among them.
    turn.interrupted = false;
    turn.carried = true;
    const kept = typeof last["pending_steer"] === "string" ? last["pending_steer"].trim() : "";
    return [CARRY_ON, kept, ...turn.next.splice(0)].filter((part) => part !== "").join("\n\n");
  }

  /** One Hermes run of the turn: started, its events heard to the end. The end, or nothing on failure. */
  private async once(turn: Turn, session: string, text: string, key: string): Promise<RunEvent | undefined> {
    const { agent } = turn;
    const carried = turn.carried;
    turn.carried = false;
    try {
      const instructions = instructionsFor(turn.folder, turn.project !== undefined, turn.rules);
      turn.hermesRun = await agent.client.startRun({
        text,
        sessionId: session,
        ...this.runModel(turn),
        key,
        instructions: carried ? `${instructions}\n\n${CARRIED_ON}` : instructions,
      });
    } catch (error) {
      await this.failed(turn, `${agent.config.name} couldn't start in Hermes: ${messageOf(error)}`, true);
      return undefined;
    }
    turn.live = true;
    // A Stop or a Pause heard while Hermes was starting the run stops it now.
    if (turn.cancelled) await agent.client.stop(turn.hermesRun).catch(() => undefined);
    else this.pauseHermes(turn);
    let last: RunEvent | undefined;
    try {
      last = (await agent.client.events(turn.hermesRun, (event) => this.heard(turn, event))) ?? (await this.endOf(turn));
    } catch (error) {
      this.log(`lost ${agent.config.name}'s run ${turn.hermesRun}: ${messageOf(error)}`);
      last = await this.endOf(turn);
    } finally {
      turn.live = false;
    }
    await this.toldWhileWorking(turn, last);
    return last;
  }

  /**
   * Words said in a room, not to the harness, while its agents work there (Chips ADRs 0105, 0106):
   * each turn Chips names hears them as a steer of its Hermes run, which Hermes gives the model
   * after the step it is on. A run that won't take a steer is ending, and its agent's next turn is
   * handed the words.
   */
  private async overheard(message: MessageOverheard): Promise<void> {
    // Where a message waits for one of its agents in the room, kept for the turn that takes it (Chips ADR 0294).
    if (message.space_id !== undefined) this.saidToOthers(message.space_id, message, new Set());
    const line = overheardLine(message);
    for (const { runId } of workingTurnsOf(message)) {
      const turn = this.working.get(runId);
      if (turn === undefined || turn.run.over || turn.hermesRun === "") continue;
      try {
        await turn.agent.client.steer(turn.hermesRun, line);
        turn.overheard.push({ messageId: message.message_id, line });
      } catch {
        // Ending, or not started: the agent's next turn has the words with the room's lines.
      }
    }
  }

  /**
   * Which of the words steered into a run it heard: those Hermes gave it before it completed, not
   * those it kept back as `pending_steer`, nor any in a run that failed or was stopped. Chips is
   * told of each, and the room shows the agent heard it while working (Chips ADR 0106).
   */
  private async toldWhileWorking(turn: Turn, last: RunEvent | undefined): Promise<void> {
    const told = turn.overheard.splice(0);
    const kept = typeof last?.["pending_steer"] === "string" ? last["pending_steer"] : "";
    if (last?.event === "run.cancelled" && turn.pausing && !turn.cancelled) {
      // Stopped for a pause: what Hermes kept back goes into the words that carry on (`carryOn`),
      // and is heard once that run completes.
      turn.overheard.push(...told.filter(({ line }) => kept.includes(line)));
      return;
    }
    if (last?.event !== "run.completed") return;
    for (const { messageId, line } of told) {
      if (kept.includes(line)) continue;
      await turn.run.heard(messageId).catch((error: unknown) => this.log(`couldn't say a turn heard ${messageId}: ${messageOf(error)}`));
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
    const made = await agent.client.newSession(`Chips space ${spaceId}${who === agent.key ? "" : ` · ${who}`}`);
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
        break;
      case "message.interim":
      case "reasoning.available":
        this.sayThought(turn, String(event["text"] ?? ""), event.event === "message.interim" ? "writing" : "thinking");
        break;
      case "tool.started":
      case "subagent.start":
        await this.started(turn, event);
        break;
      case "tool.completed":
      case "subagent.complete":
        await this.completed(turn, event);
        break;
      case "approval.request":
        void this.ask(turn, event);
        break;
      case "approval.responded":
        await this.settled(turn, event);
        break;
      default:
        break;
    }
    // At work while paused: the pause came while it waited on a person, who it waits on no more
    // (answered in Hermes, or given up on), or its stop was lost. It stops now.
    if (WORKING.has(event.event)) this.pauseHermes(turn);
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
    turn.approvals.set(requestId ?? approvalId, {
      approvalId,
      answered: false,
      hermesRun: turn.hermesRun,
      during: [...turn.open.values()].flat(),
    });
    const asked = turn.run.approval({
      approvalId,
      action: {
        kind: command === undefined ? "hermes.approval" : "shell.exec",
        input: { ...(command === undefined ? {} : { command }), ...(description === undefined ? {} : { description }) },
      },
      question: description === undefined ? "Run this command?" : `Allow it to ${cut(lowerFirst(description), QUESTION_MAX - 13)}?`,
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
    // An answer given while the run is paused reaches Hermes once it is resumed (Chips ADR 0293):
    // Hermes waits on it meanwhile, which holds the agent. Stopped meanwhile, Stop has stopped
    // Hermes's run, and the answer goes nowhere.
    if (!(await this.resumed(turn)) || pending.answered) return;
    pending.answered = true;
    if (decision.allowed) turn.allowed.push(approvalId);
    const generation = event["execution_generation"];
    await turn.agent.client
      .approve(turn.hermesRun, {
        choice: choiceOf(decision, choices, command !== undefined),
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
    const { change, note } = await this.sendProject(turn, answer);
    const { folder } = turn;
    const { chips } = this.options;
    const words = [answer, note ?? ""].filter((part) => part !== "").join("\n\n");
    const post = await sendAnswer(words, {
      folders: folder === undefined ? [] : [folder],
      upload: (input) => chips.upload(input),
    });
    const reply = post.text;
    if (reply !== "" || post.uploadIds.length > 0) {
      await turn.speaker.post({ spaceId: run.spaceId, runId: run.id, text: reply, uploadIds: post.uploadIds, change });
    }
    const said = post.summary;
    const summary = said === "" ? "Done." : said.length <= 2000 ? said : `${said.slice(0, 1990)}…`;
    await run.complete({ summary });
    this.log(`${agent.config.name} answered in ${run.spaceId}`);
    this.missingReadings();
  }

  /**
   * A turn ended and Hermes sent no reading at all since the bridge started: its gateway most
   * likely started before Chips's webhook was in its config. Said once, a little after, since a
   * reading comes a moment after its model call.
   */
  private missingReadings(): void {
    if (this.fills === undefined || this.fillsPort === undefined || this.fills.anyHeard || this.toldNoReadings) return;
    this.toldNoReadings = true;
    setTimeout(() => {
      if (this.fills?.anyHeard === false) {
        this.log(
          "context window: Hermes sent no reading after a turn. Start hermes gateway again once, so it takes Chips's webhook from its config.",
        );
      }
    }, 10_000).unref();
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
    const model = typeof runtime["model"] === "string" ? runtime["model"] : (this.runModel(turn).model ?? "hermes");
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

  private async closeSteps(turn: Turn, status: "done" | "failed", error?: string): Promise<void> {
    for (const [, ids] of turn.open) {
      for (const stepId of ids) {
        await turn.run.step({ stepId, status, ...(error === undefined ? {} : { error }) }).catch(() => undefined);
      }
    }
    turn.open.clear();
  }

  private async failed(turn: Turn, error: string, retryable: boolean): Promise<void> {
    if (!turn.run.over) await turn.run.fail({ error, retryable }).catch(() => undefined);
    if (retryable) void this.sayHowItIs();
  }
}

// ------------------------------------------------------------------ small words

/**
 * Hermes's choice for a person's answer: their scope where Hermes offers it, else once. A
 * command's Always or This session is Hermes's once (Chips ADR 0239): Chips remembers how each
 * part of it starts and answers the next ask itself, where Hermes's own would let through more.
 */
export function choiceOf(decision: Decision, choices: readonly string[], command = false): string {
  if (!decision.allowed) return "deny";
  if (command) return "once";
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

/** A space's name from what it is for: the first line, cut at a word near 48 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24))}…`;
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
    `${who} says your reply in this space wasn't right.`,
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

/** The most an approval's question holds: the protocol's `maxLength`, past which Chips refuses the ask. */
const QUESTION_MAX = 200;

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
