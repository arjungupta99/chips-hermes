/**
 * An agent's context window in Chips (Chips ADR 0146): how full its Hermes session is, from what
 * Hermes itself says after each model call. Hermes's API server reports no window during a run, so
 * the bridge adds an outbound webhook to the profile's `config.yaml` (`hooks.ts`), and Hermes POSTs
 * here after every model call (`post_api_request`, `agent/turn_response_intake.py`). The body is
 * `{hook_event_name, profile, session_id, …, extra: {task_id, turn_id, model, usage,
 * context_length, …, response, assistant_message}}` (`agent/shell_hooks.py`, `_payload_fields`),
 * signed with HMAC-SHA256 over the raw body in `X-Hermes-Signature-256: sha256=<hex>`
 * (`agent/outbound_webhooks.py`). It carries the reply's words too: the bridge keeps only the
 * numbers.
 *
 * - `used` is the call's prompt tokens (`usage.prompt_tokens`: fresh input and the cache's reads
 *   and writes), what Hermes's own compressor counts and compacts against
 *   (`context_compressor.py`, `update_from_response`). The call's output joins the next call's
 *   prompt, and is counted there.
 * - `window` is the compressor's `context_length`, and `model` the model it ran.
 * - A reading counts for a session the bridge keeps for an agent, from a run it started there:
 *   an API-server run's `task_id` is its session (`api_server_runs.py`). Hermes's background
 *   memory review shares the session's id but runs under a task of its own, and is left out.
 * - Hermes compacts a session in place, under the same id, and says nothing of it: a reading
 *   much lower than the session's last (same model) is a compaction, the agent's `last`.
 * - A turn is Hermes's `turn_id`: its peak, once past half the window, and the compactions in it,
 *   are the agent's `long_turn`.
 *
 * The agent's copy is the session with its latest reading. With no reading, no copy is sent: no
 * number is made up. The last reading, compaction and long turn of each agent are kept, and sent
 * again after a restart.
 *
 * Hermes compacts at `compression.threshold` of the window (0.50; at least 0.75 under 512K
 * tokens), for every agent on its profile, and can't be asked to compact from outside a session:
 * the copy says both, and the handlers refuse a person's change with the same words.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentContextWindowCopy } from "@chipschat/harness";
import { configText, yamlBool, yamlNumber, yamlValue } from "./home.js";

/** The path Hermes POSTs to, before the profile's name. */
export const HOOK_PATH = "/chips-hermes/";

/** The most a delivery may be: the reply's words come in it, which are read past and dropped. */
export const MAX_BODY = 4 * 1024 * 1024;

/** A reading this much lower than the session's last is a compaction. */
const DROP = 0.7;

/** How often one agent's copy is sent at most while readings come fast. */
const SEND_EVERY_MS = 2000;

/** Hermes's own compaction settings (`hermes_cli/config_defaults.py`, `agent/context_compressor.py`). */
const THRESHOLD = 0.5;
const SMALL_WINDOW = 512_000;
const SMALL_THRESHOLD = 0.75;

export const WHY_NOT = "Hermes can't be asked to compact from Chips.";
export const whyReadOnly = (profile: string) => `Hermes sets this for every agent on its ${profile} profile.`;

/** How full one session was after a model call. */
export interface Reading {
  readonly used: number;
  readonly window: number;
  readonly model?: string | undefined;
  readonly at: string;
  /** The session it was read in. */
  readonly session: string;
}

export interface Last {
  readonly at: string;
  readonly from: number;
  readonly to: number;
  readonly by: "asked" | "itself";
}

export interface LongTurn {
  readonly at: string;
  readonly peak: number;
  readonly folds: number;
}

/** What is kept across restarts, in the bridge's state. */
export interface KeptFills {
  /** The port Hermes POSTs to, so the address in its config stays right. */
  port?: number;
  /** What Hermes signs its POSTs with, where its `.env` doesn't say. */
  secret?: string;
  readings?: Record<string, Reading>;
  lasts?: Record<string, Last>;
  longTurns?: Record<string, LongTurn>;
}

/** Whose a session is: the Chips agent, and the profile it runs on. */
export interface Whose {
  readonly agentId: string;
  readonly profile: string;
  readonly home: string;
}

export interface FillsOptions {
  /** The agent a session the bridge keeps is, or nothing for any other. */
  readonly whose: (sessionId: string) => Whose | undefined;
  /** The profile an agent runs on, for the copy's limit. */
  readonly profileOf: (agentId: string) => { readonly profile: string; readonly home: string } | undefined;
  /** What a profile's deliveries are signed with. */
  readonly secretFor: (profile: string) => string | undefined;
  readonly send: (agentId: string, copy: AgentContextWindowCopy) => Promise<unknown>;
  readonly kept: KeptFills;
  readonly save: () => void;
  readonly log: (line: string) => void;
  readonly sendEveryMs?: number | undefined;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The compaction limit of a profile, as a percent of this window, as Hermes works it out. */
export function limitOf(home: string, window: number): AgentContextWindowCopy["limit"] {
  const text = configText(home);
  const enabled = yamlBool(yamlValue(text, "compression", "enabled")) ?? true;
  const threshold = yamlNumber(yamlValue(text, "compression", "threshold")) ?? THRESHOLD;
  let ratio = window < SMALL_WINDOW ? Math.max(threshold, SMALL_THRESHOLD) : threshold;
  const tokens = yamlNumber(yamlValue(text, "compression", "threshold_tokens"));
  if (tokens !== undefined && tokens > 0 && window > 0) ratio = Math.min(ratio, tokens / window);
  const at = Math.min(99, Math.max(1, Math.round(ratio * 100)));
  return enabled
    ? { at, choices: [at], default: at, may_turn_off: false }
    : { at: null, choices: [at], default: null, may_turn_off: true };
}

/** A signature Hermes made over `body` with `secret`, checked in constant time. */
export function signedBy(body: Buffer, header: string | undefined, secret: string): boolean {
  if (header === undefined || !header.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  const made = createHmac("sha256", secret).update(body).digest();
  return given.length === made.length && timingSafeEqual(given, made);
}

/** The numbers of a delivery, and nothing else of it. */
interface Numbers {
  readonly profile: string;
  /** The session the bridge passed the run: its task, else the session Hermes names. */
  readonly session: string;
  readonly turn: string | undefined;
  readonly first: boolean;
  readonly used: number;
  readonly window: number;
  readonly model: string | undefined;
  readonly at: string;
}

/**
 * A delivery's numbers, or nothing for an event or a call that says none, or one another profile
 * sent: a profile cloned for an agent (Chips ADR 0241) has its source's webhook until the bridge
 * moves it to its own address, and Hermes's gateway keeps sending to both until it starts again.
 */
export function numbersOf(profile: string, body: unknown): Numbers | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const top = body as Record<string, unknown>;
  if (top["hook_event_name"] !== "post_api_request") return undefined;
  const sender = top["profile"];
  if (typeof sender === "string" && sender !== profile && sender !== "custom") return undefined;
  const extra = (typeof top["extra"] === "object" && top["extra"] !== null ? top["extra"] : {}) as Record<string, unknown>;
  const named = typeof top["session_id"] === "string" ? top["session_id"] : "";
  const task = typeof extra["task_id"] === "string" && extra["task_id"] !== "" ? extra["task_id"] : undefined;
  const session = task ?? named;
  if (session === "") return undefined;
  const usage = (typeof extra["usage"] === "object" && extra["usage"] !== null ? extra["usage"] : {}) as Record<string, unknown>;
  const prompt =
    num(usage["prompt_tokens"]) ??
    (num(usage["input_tokens"]) === undefined
      ? undefined
      : (num(usage["input_tokens"]) ?? 0) + (num(usage["cache_read_tokens"]) ?? 0) + (num(usage["cache_write_tokens"]) ?? 0));
  const window = num(extra["context_length"]);
  if (prompt === undefined || prompt <= 0 || window === undefined || window <= 0) return undefined;
  const ended = num(extra["ended_at"]);
  const stamped = typeof top["timestamp"] === "string" && !Number.isNaN(Date.parse(top["timestamp"])) ? top["timestamp"] : undefined;
  const at = ended !== undefined ? new Date(ended * 1000).toISOString() : (stamped ?? new Date().toISOString());
  const model = typeof extra["model"] === "string" && extra["model"] !== "" ? extra["model"].slice(0, 120) : undefined;
  const turn = typeof extra["turn_id"] === "string" && extra["turn_id"] !== "" ? extra["turn_id"] : undefined;
  return {
    profile,
    session,
    turn,
    first: num(extra["api_call_count"]) === 1,
    used: Math.round(prompt),
    window: Math.round(window),
    model,
    at: new Date(at).toISOString(),
  };
}

/** The turn going in a session: its peak so far, and how often it compacted. */
interface Turn {
  readonly id: string | undefined;
  peak: number;
  folds: number;
}

export class Fills {
  private server: Server | undefined;
  /** The last reading of each session, for a compaction's drop. */
  private readonly lastOf = new Map<string, Reading>();
  private readonly turns = new Map<string, Turn>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sentAt = new Map<string, number>();
  /** The profiles whose unsigned or wrongly signed deliveries have been said once. */
  private readonly badSaid = new Set<string>();
  private heard = false;

  constructor(private readonly options: FillsOptions) {
    const kept = options.kept;
    kept.readings ??= {};
    kept.lasts ??= {};
    kept.longTurns ??= {};
    for (const reading of Object.values(kept.readings)) this.lastOf.set(reading.session, reading);
  }

  /** Whether any reading has come since the bridge started. */
  get anyHeard(): boolean {
    return this.heard;
  }

  /** Hear Hermes on `127.0.0.1:port`: the port it took (one of its own for 0). */
  listen(port: number, host = "127.0.0.1"): Promise<number> {
    const server = createServer((request, response) => this.handle(request, response));
    this.server = server;
    return new Promise((done, failed) => {
      server.once("error", failed);
      server.listen(port, host, () => {
        server.off("error", failed);
        done((server.address() as AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    // A reading not sent yet is kept, for the start after.
    if (this.timers.size > 0) this.options.save();
    this.timers.clear();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }

  /** An agent's copy, from what is known of it, or nothing when no reading has come. */
  copyOf(agentId: string): AgentContextWindowCopy | undefined {
    const { kept } = this.options;
    const reading = kept.readings?.[agentId];
    const profile = this.options.profileOf(agentId);
    if (reading === undefined || profile === undefined) return undefined;
    const last = kept.lasts?.[agentId];
    const long = kept.longTurns?.[agentId];
    return {
      used: reading.used,
      window: reading.window,
      ...(reading.model === undefined ? {} : { model: reading.model }),
      as_of: reading.at,
      ...(last === undefined ? {} : { last }),
      ...(long === undefined ? {} : { long_turn: long }),
      compacts: false,
      why_not: WHY_NOT,
      limit: limitOf(profile.home, reading.window),
      editable: false,
      why_read_only: whyReadOnly(profile.profile),
    };
  }

  /** Each agent's kept copy, sent: at start, so a restart shows what was known. */
  async sendAll(): Promise<void> {
    for (const agentId of Object.keys(this.options.kept.readings ?? {})) await this.send(agentId);
  }

  /** An agent gone: nothing more is sent for it, and nothing kept. */
  forget(agentId: string): void {
    const { kept } = this.options;
    clearTimeout(this.timers.get(agentId));
    this.timers.delete(agentId);
    if (kept.readings?.[agentId] === undefined && kept.lasts?.[agentId] === undefined) return;
    delete kept.readings?.[agentId];
    delete kept.lasts?.[agentId];
    delete kept.longTurns?.[agentId];
    this.options.save();
  }

  /** One delivery: read whole up to its limit, checked, answered at once, then taken in. */
  handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const profile = url.pathname.startsWith(HOOK_PATH) ? decodeURIComponent(url.pathname.slice(HOOK_PATH.length)) : "";
    if (request.method !== "POST" || profile === "" || profile.includes("/")) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    request.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        over = true;
        response.writeHead(413, { connection: "close" }).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (over) return;
      const body = Buffer.concat(chunks);
      const secret = this.options.secretFor(profile);
      const header = request.headers["x-hermes-signature-256"];
      if (secret === undefined || !signedBy(body, typeof header === "string" ? header : undefined, secret)) {
        response.writeHead(401).end();
        if (!this.badSaid.has(profile)) {
          this.badSaid.add(profile);
          this.options.log(
            `a reading from Hermes's ${profile} profile wasn't signed with Chips's secret, and was dropped: start hermes gateway again if its .env changed`,
          );
        }
        return;
      }
      response.writeHead(204).end();
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch {
        return;
      }
      const numbers = numbersOf(profile, parsed);
      if (numbers !== undefined) this.take(numbers);
    });
  }

  /** A reading taken in: the agent's latest, a compaction when it fell, the turn's peak. */
  private take(numbers: Numbers): void {
    const whose = this.options.whose(numbers.session);
    if (whose === undefined) return;
    this.heard = true;
    const { kept } = this.options;
    const { agentId } = whose;
    const reading: Reading = {
      used: numbers.used,
      window: numbers.window,
      ...(numbers.model === undefined ? {} : { model: numbers.model }),
      at: numbers.at,
      session: numbers.session,
    };
    const before = this.lastOf.get(numbers.session);
    const fell =
      before !== undefined && before.model === reading.model && reading.used < before.used * DROP;
    if (fell && before !== undefined) {
      (kept.lasts ??= {})[agentId] = { at: reading.at, from: before.used, to: reading.used, by: "itself" };
      this.options.log(`${agentId} compacted in Hermes, ${before.used} to ${reading.used} tokens`);
    }
    let turn = this.turns.get(numbers.session);
    const fresh = numbers.turn === undefined ? numbers.first || turn === undefined : turn?.id !== numbers.turn;
    if (turn === undefined || fresh) {
      turn = { id: numbers.turn, peak: 0, folds: 0 };
      this.turns.set(numbers.session, turn);
    }
    turn.peak = Math.max(turn.peak, reading.used);
    if (fell) turn.folds += 1;
    if (turn.peak > reading.window / 2) {
      (kept.longTurns ??= {})[agentId] = { at: reading.at, peak: turn.peak, folds: Math.min(1000, turn.folds) };
    }
    this.lastOf.set(numbers.session, reading);
    (kept.readings ??= {})[agentId] = reading;
    this.schedule(agentId);
  }

  /** The agent's copy sent now, or once readings slow down, and what is kept saved with it. */
  private schedule(agentId: string): void {
    if (this.timers.has(agentId)) return;
    const every = this.options.sendEveryMs ?? SEND_EVERY_MS;
    const wait = Math.max(0, (this.sentAt.get(agentId) ?? 0) + every - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      this.sentAt.set(agentId, Date.now());
      this.options.save();
      void this.send(agentId);
    }, wait);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  private async send(agentId: string): Promise<void> {
    const copy = this.copyOf(agentId);
    if (copy === undefined) return;
    await this.options.send(agentId, copy).catch((error: unknown) => {
      this.options.log(`${agentId}'s context window not sent: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
