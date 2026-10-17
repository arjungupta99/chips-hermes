/**
 * Hermes Agent as one Chips harness, on its Runs API. Each configured profile is a Chips agent
 * (ADR 0087), registered by its own key. The first is the harness's Main agent, in the harness's
 * own room in the place of the default agent Chips gave the harness there, and it answers for
 * that default agent, and for any other of the harness's Chips doesn't name here. A room an agent
 * is in is one Hermes session of its profile, made the first time somebody there speaks to it,
 * and kept across restarts.
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
 * Hermes can't be told anything outside a run, and keeps no schedule this bridge reads yet, so
 * neither is claimed.
 */

import type { Agent, Chips, Decision, Run, Speaker } from "@chipschat/harness";
import { promptFor } from "@chipschat/harness";
import { createIdGenerator, type MessageNew, type StepKind } from "@chipschat/protocol";
import { HermesClient, HermesError, type ProfileAddress, type RunEvent, TERMINAL } from "./hermes.js";

export interface AgentConfig {
  /** What a person sees, and its @handle: `Hermes`. */
  readonly name: string;
  /** Its profile's gateway and key. */
  readonly address: ProfileAddress;
  /** The environment variable its key was read from, to name when Hermes refuses it. */
  readonly keyEnv?: string | undefined;
  /** The model each of its runs asks for, when not the profile's own. */
  readonly model?: string | undefined;
}

/** What the bridge keeps across restarts beside the SDK's own store. */
export interface BridgeState {
  /** `<agent key>|<space id>` → the Hermes session that room is. */
  sessions: Record<string, string>;
}

export interface BridgeOptions {
  readonly chips: Chips;
  readonly agents: readonly AgentConfig[];
  /** The harness's own room, where its Main agent lives. */
  readonly home?: string | undefined;
  readonly state: BridgeState;
  readonly saveState: (state: BridgeState) => void;
  /** How to reach a profile: its gateway, unless a test hands in a client of its own. */
  readonly clientFor?: ((agent: AgentConfig) => HermesClient) | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** How often each gateway is asked whether it is up. */
  readonly healthEveryMs?: number | undefined;
}

/** Ids for the approvals asked here, made before the ask so Hermes's answer can find its card. */
const ids = createIdGenerator();

/** How often a run's status may change, so a stream of thoughts isn't a stream of events. */
const QUIET_MS = 1500;
/** How long the end of a run whose stream was lost is waited for, read from its state. */
const LOST_STREAM_MS = 120_000;

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
}

interface Room {
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
}

export class Bridge {
  private readonly agents: Running[] = [];
  private readonly rooms = new Map<string, Room>();
  /** Every Chips agent of the harness's, configured here or not. */
  private ours = new Set<string>();
  private readonly log: (line: string) => void;
  private health: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Register the agents, start hearing what is said to them, and say how their gateways are. */
  async start(): Promise<void> {
    const { chips } = this.options;
    const known = await chips.agents.list();
    // A Main agent Chips has already is kept, under whatever key: a harness has one at most.
    const main = known.find((agent) => agent.lead);
    for (const [index, config] of this.options.agents.entries()) {
      const key = keyOf(config);
      const kept = index === 0 && main !== undefined && main.key !== key ? main : undefined;
      const registered = kept ?? (await chips.agents.register({ key, name: config.name, lead: index === 0 }));
      const client = this.options.clientFor?.(config) ?? new HermesClient(config.address);
      this.agents.push({ config, key, client, agentId: registered.agentId, up: true });
      if (index === 0) await this.goHome(registered, known);
    }
    this.ours = new Set([...known.map((agent) => agent.agentId), ...this.agents.map((agent) => agent.agentId)]);
    chips.on("message.new", (message) => void this.hear(message));
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

  /** The Main agent into the harness's own room, in the place of whichever of ours is there. */
  private async goHome(main: Agent, known: readonly Agent[]): Promise<void> {
    const { chips, home } = this.options;
    if (home === undefined || main.spaces.includes(home)) return;
    const there = known.find((agent) => agent.agentId !== main.agentId && agent.spaces.includes(home));
    await chips.agents
      .attach(main.agentId, { spaceId: home, replacing: there?.agentId ?? chips.harnessId })
      .catch((error: unknown) => this.log(`${main.name} stays out of its home: ${String(error)}`));
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
  private async hear(message: MessageNew): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    for (const taker of message.for ?? [harnessId]) {
      const agent = await this.runnerOf(taker);
      if (agent === undefined) continue;
      const room = this.roomOf(agent, spaceId);
      room.queue.push({ message, speakerId: taker === harnessId ? undefined : taker });
      void this.pump(room);
    }
  }

  /**
   * Which profile answers for a Chips agent: its own, or the first for the harness itself and for
   * any other of the harness's — its default agent, one Chips made since — read afresh once when
   * a name is new.
   */
  private async runnerOf(taker: string): Promise<Running | undefined> {
    const own = this.agents.find((agent) => agent.agentId === taker);
    if (own !== undefined) return own;
    if (taker !== this.options.chips.harnessId && !this.ours.has(taker)) {
      const listed = await this.options.chips.agents.list().catch(() => []);
      for (const agent of listed) this.ours.add(agent.agentId);
    }
    return taker === this.options.chips.harnessId || this.ours.has(taker) ? this.agents[0] : undefined;
  }

  private roomOf(agent: Running, spaceId: string): Room {
    const id = `${agent.key}|${spaceId}`;
    let room = this.rooms.get(id);
    if (room === undefined) {
      room = { agent, spaceId, queue: [], busy: false };
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

  private async turn(room: Room, { message, speakerId }: Asked): Promise<void> {
    const { agent, spaceId } = room;
    const speaker = speakerId === undefined ? this.options.chips : this.options.chips.as(speakerId);
    const run = await speaker.runs.start({ spaceId, goal: goalOf(message, agent.config.name) });
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
      session = await this.sessionFor(agent, spaceId);
    } catch (error) {
      await this.failed(turn, `${agent.config.name} couldn't open a session in Hermes: ${messageOf(error)}`, true);
      return;
    }
    let text: string | undefined = promptFor(message, speakerId === undefined ? {} : { taker: speakerId });
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
      turn.hermesRun = await agent.client.startRun({ text, sessionId: session, model: agent.config.model, key });
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
  private async sessionFor(agent: Running, spaceId: string): Promise<string> {
    const key = `${agent.key}|${spaceId}`;
    const kept = this.options.state.sessions[key];
    if (kept !== undefined) return kept;
    const made = await agent.client.newSession(`Chips room ${spaceId}`);
    this.options.state.sessions[key] = made;
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
    const summary = sub ? event["summary"] : event["preview"];
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
    const reply = output !== "" ? output : turn.reply.trim();
    if (reply !== "") await turn.speaker.post({ spaceId: run.spaceId, runId: run.id, text: reply });
    const summary = reply === "" ? "Done." : reply.length <= 2000 ? reply : `${reply.slice(0, 1990)}…`;
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

  /** The tokens Hermes counted, as a step's share, so they add up over the turn's runs. */
  private async counted(turn: Turn, last: RunEvent): Promise<void> {
    const usage = (last["usage"] ?? {}) as Record<string, unknown>;
    const input = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
    const output = typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : 0;
    if (input + output === 0) return;
    const runtime = (last["runtime"] ?? {}) as Record<string, unknown>;
    const model = typeof runtime["model"] === "string" ? runtime["model"] : (turn.agent.config.model ?? "hermes");
    await turn.run
      .usage({ scope: "step", model, inputTokens: input, outputTokens: output })
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

/** The run's goal: the message's first line, without the @ it opened with — the agent's whole name. */
export function goalOf(message: MessageNew, name: string): string {
  const first = message.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const named = first.toLowerCase().startsWith(`@${name.toLowerCase()}`);
  const goal = named ? first.slice(name.length + 1).trim() : first.replace(/^@\S+\s*/, "");
  return (goal === "" ? `Answer ${message.from.display_name}` : goal).slice(0, 300);
}

function lastLine(text: string): string {
  const lines = text.split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? "";
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toLowerCase() ?? ""}${text.slice(1)}`;
}
