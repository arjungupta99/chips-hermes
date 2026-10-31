/**
 * A scripted Hermes API server for the tests, on Hermes's own routes and event names: a run plays
 * by the words it was given.
 * - `ask` asks before running a command, and says the choice it was given.
 * - `delegate` hands work to a sub-agent that says what it cost.
 * - `elsewhere` asks, and is answered in Hermes's own tools.
 * - `fail` fails.
 * - `slow` writes until it is stopped.
 * - `listen` works until it is steered, or a while, then answers; with `late`, it keeps the steer
 *   back as Hermes does one it couldn't give before the run ended (`pending_steer`).
 * - `drop` loses its stream midway and is read from its state.
 * - A reply a person said wasn't right (Chips ADR 0200) is answered again.
 * - Anything else reads a file and answers.
 *
 * Each session keeps what was said in it, which a run is shown as it starts. A session is forked
 * as Hermes 0.22.0 forks one (`POST /api/sessions/{id}/fork`): the copy made, the original ended
 * as `branched`, then the title, refused when another session has it. `compress` moves a session
 * on to a new id, as Hermes's compression does, which a run naming the old id is taken to.
 *
 * With `askFirst`, every run in the first session it made asks before it answers, as the golden
 * scenario needs. With `usage`, a run's end says it counted that, in place of Hermes 0.22.0's counts.
 *
 * With `hook` set, it says how full the session is as Hermes's outbound webhook does after each
 * model call (`post_api_request`), signed, before the run's events: the prompt tokens in `fills`
 * when a test sets them (one call each), else one call that grows with the session. With `review`
 * set, a memory review follows, as Hermes runs one: the session's id, a task of its own.
 */

import { createHmac, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { envValue, profileHome } from "../src/home.ts";

type Event = Record<string, unknown> & { event: string };

interface FakeRun {
  readonly id: string;
  readonly input: string;
  status: string;
  readonly events: Event[];
  readonly listeners: Set<(event: Event) => void>;
  answer?: (choice: string) => void;
  output?: string;
  drop?: boolean;
  /** The session it is in, where its words and answer are kept. */
  session?: string;
  /** The session it was asked for, and the profile it ran on. */
  named?: string;
  profile?: string;
}

export interface Started {
  readonly input: string;
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  readonly provider: string | undefined;
  /** What the run said to add to the turn's system prompt. */
  readonly instructions: string | undefined;
  readonly profile: string;
  readonly idempotencyKey: string | undefined;
  /** What its session held when it started: each run's input, then its answer. */
  readonly history: readonly string[];
}

/** A fork Hermes was asked for: of which session, under which id, on which profile, and whether made. */
export interface Forked {
  readonly from: string;
  readonly id: string | undefined;
  readonly title: string | undefined;
  readonly profile: string;
  readonly made: boolean;
}

export interface FakeHermes {
  readonly url: string;
  readonly key: string;
  readonly started: Started[];
  readonly sessions: string[];
  readonly answers: Record<string, unknown>[];
  readonly steers: string[];
  readonly stops: string[];
  readonly forks: Forked[];
  /** The sessions ended, and why: `branched` for a fork's original. */
  readonly ended: Map<string, string>;
  up: boolean;
  /** The session compressed: it goes on under a new id with what it held. The new id. */
  compress(sessionId: string): string;
  /** Where Hermes's outbound webhook POSTs each profile's readings, and what it signs them with. */
  hook?: { readonly url: (profile: string) => string | undefined; readonly secret: string } | undefined;
  /** The next run's model calls, each its prompt tokens; taken by that run. */
  fills?: number[] | undefined;
  /** The model's window, as Hermes's compressor says it. */
  window: number;
  /** A memory review after the next run, with these prompt tokens. */
  review?: number | undefined;
  /** The deliveries the webhook made, and how each was answered. */
  readonly delivered: { readonly status: number; readonly body: Record<string, unknown> }[];
  /**
   * What `/api/model/options` answers for each profile, as Hermes's picker lists them: the
   * profile's model and provider, and the providers it is set up for.
   */
  options: (profile: string) => Record<string, unknown>;
  /** The profiles whose models were asked for. */
  readonly optionsAsked: string[];
  /**
   * Hermes's root, once a test has one: a request under `/p/<profile>` for a profile with an
   * `API_SERVER_KEY` in its `.env` there takes that key and no other, as a multiplexing gateway does.
   */
  root?: string | undefined;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeHermes(
  options: { askFirst?: boolean; usage?: Record<string, number> } = {},
): Promise<FakeHermes> {
  const key = "hermes-test-key";
  const runs = new Map<string, FakeRun>();
  let count = 0;
  /** Each session's title, as Hermes keeps it: no two sessions share one. */
  const titles = new Map<string, string>();
  /** What each session holds. */
  const histories = new Map<string, string[]>();
  /** A compressed session → the id it goes on under. */
  const continued = new Map<string, string>();
  const latestOf = (id: string): string => {
    let at = id;
    while (continued.has(at)) at = continued.get(at) ?? at;
    return at;
  };
  const fake: Omit<FakeHermes, "url" | "close"> = {
    key,
    started: [],
    sessions: [],
    answers: [],
    steers: [],
    stops: [],
    forks: [],
    ended: new Map(),
    up: true,
    window: 200_000,
    delivered: [],
    optionsAsked: [],
    options: () => ({
      model: "heron-2",
      provider: "fake",
      providers: [
        { slug: "fake", name: "Fake", is_current: true, authenticated: true, models: ["heron-2", "heron-mini"] },
        { slug: "kite", name: "Kite", is_current: false, authenticated: true, models: ["kite-1"] },
        { slug: "gone", name: "Gone", is_current: false, authenticated: false, models: ["gone-1"] },
      ],
    }),
    compress: (sessionId) => {
      const from = latestOf(sessionId);
      const next = `${from}~`;
      histories.set(next, [...(histories.get(from) ?? [])]);
      continued.set(from, next);
      fake.ended.set(from, "compression");
      return next;
    },
  };

  const emit = (run: FakeRun, event: string, fields: Record<string, unknown> = {}) => {
    const sent: Event = { event, run_id: run.id, timestamp: Date.now() / 1000, ...fields };
    run.events.push(sent);
    for (const listener of run.listeners) listener(sent);
  };
  const finish = (run: FakeRun, status: string, fields: Record<string, unknown>) => {
    if (["completed", "failed", "cancelled"].includes(run.status)) return;
    run.status = status;
    if (run.session !== undefined && typeof fields["output"] === "string") histories.get(run.session)?.push(fields["output"]);
    emit(run, `run.${status}`, fields);
  };
  const asked = (run: FakeRun, fields: Record<string, unknown>) =>
    new Promise<string>((resolve) => {
      run.status = "waiting_for_approval";
      run.answer = (choice) => {
        run.status = "running";
        resolve(choice);
      };
      emit(run, "approval.request", fields);
    });
  // As Hermes 0.22.0 counts: its input_tokens holds the cache's reads and writes (100 fresh here).
  const usage = options.usage ?? {
    input_tokens: 1200,
    output_tokens: 40,
    total_tokens: 1240,
    cache_read_tokens: 900,
    cache_write_tokens: 200,
  };

  /** One model call's reading, POSTed as Hermes's outbound webhook does, signed. */
  const deliver = async (profile: string, sessionId: string, task: string, turn: string, call: number, prompt: number) => {
    const hook = fake.hook;
    const url = hook?.url(profile);
    if (hook === undefined || url === undefined) return;
    const now = Date.now() / 1000;
    const body = JSON.stringify({
      hook_event_name: "post_api_request",
      profile,
      tool_name: null,
      tool_input: null,
      session_id: sessionId,
      cwd: "/tmp",
      extra: {
        task_id: task,
        turn_id: turn,
        api_request_id: `${turn}:api:${call}`,
        platform: "api_server",
        model: "heron-2",
        provider: "fake",
        api_call_count: call,
        started_at: now - 1,
        ended_at: now,
        finish_reason: "stop",
        message_count: call + 1,
        // The words come with the numbers: the bridge keeps only the numbers.
        response: { choices: [{ message: { content: "Here is the answer." } }] },
        usage: {
          input_tokens: prompt - 900,
          output_tokens: 40,
          cache_read_tokens: 900,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          request_count: 1,
          prompt_tokens: prompt,
          total_tokens: prompt + 40,
        },
        context_length: fake.window,
        assistant_message: "Here is the answer.",
      },
      delivery_id: randomUUID().replace(/-/g, ""),
      timestamp: new Date().toISOString(),
    });
    const signature = createHmac("sha256", hook.secret).update(body).digest("hex");
    const answer = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hermes-signature-256": `sha256=${signature}` },
      body,
    }).catch(() => undefined);
    fake.delivered.push({ status: answer?.status ?? 0, body: JSON.parse(body) as Record<string, unknown> });
  };

  /** The run's model calls, said to the webhook before its events, and a memory review after when asked. */
  const readings = async (run: FakeRun, profile: string, named: string | undefined) => {
    const session = run.session ?? named ?? "";
    // As Hermes's API server: the run's task is the session it was asked for.
    const task = named ?? run.id;
    const turn = `${session}:${task}:${run.id}`;
    const fills = fake.fills ?? [2000 + 500 * (histories.get(session)?.length ?? 0)];
    fake.fills = undefined;
    for (const [at, prompt] of fills.entries()) await deliver(profile, session, task, turn, at + 1, prompt);
    const review = fake.review;
    fake.review = undefined;
    if (review !== undefined) await deliver(profile, session, randomUUID(), `${session}:review`, 1, review);
  };

  const play = async (run: FakeRun) => {
    await sleep(20);
    await readings(run, run.profile ?? "default", run.named);
    // Before the words are read: the fix turn's last line asks the agent to "ask them" when unsure.
    if (run.input.includes("says your reply in this space wasn't right.")) {
      const output = "Sunday it is: I moved the plan to Sunday, your flight home.";
      return finish(run, "completed", { completed: true, output, usage, runtime: { model: "heron-2" } });
    }
    // The person's words, the input's last line: not the room note before them, which may say "ask".
    const words = run.input.split("\n").at(-1) ?? "";
    if ((options.askFirst === true && run.session === fake.sessions[0]) || /\bask\b/.test(words)) {
      emit(run, "tool.started", { tool: "terminal", preview: "npm test", tool_call_id: "call_1" });
      const choice = await asked(run, {
        request_id: "req_1",
        command: "npm test",
        description: "Run the tests",
        choices: ["once", "session", "always", "deny"],
      });
      const denied = choice === "deny";
      // Its terminal's result is JSON in the preview, as Hermes 0.22.0 sends it.
      const result = denied
        ? { output: "", exit_code: -1, error: "denied", approval: "Denied." }
        : { output: "12 passed\n", exit_code: 0, error: null, approval: "Approved once." };
      emit(run, "tool.completed", { tool: "terminal", duration: 0.4, error: denied, preview: JSON.stringify(result), tool_call_id: "call_1" });
      if (run.status === "cancelled") return;
      return finish(run, "completed", { completed: true, output: `Given: ${choice}`, usage, runtime: { model: "heron-2" } });
    }
    if (/\belsewhere\b/.test(words)) {
      emit(run, "approval.request", { request_id: "req_2", command: "rm -rf build", choices: ["once", "deny"] });
      await sleep(80);
      emit(run, "approval.responded", { request_id: "req_2", choice: "once", resolved: true });
      return finish(run, "completed", { completed: true, output: "Cleaned.", usage, runtime: { model: "heron-2" } });
    }
    if (/\bfail\b/.test(words)) return finish(run, "failed", { completed: false, error: "The model refused." });
    if (/\bsend\b/.test(words)) {
      // Files named as the Chips SDK tells an agent: one from its folder, one from outside it.
      const output = "The page is ready.\n\nMEDIA:page.html\nMEDIA:../secret.txt";
      return finish(run, "completed", { completed: true, output, usage, runtime: { model: "heron-2" } });
    }
    if (/\bslow\b/.test(words)) {
      for (let i = 0; i < 200 && run.status === "running"; i += 1) {
        emit(run, "message.delta", { delta: "." });
        await sleep(20);
      }
      return;
    }
    if (/\blisten\b/.test(words)) {
      const before = fake.steers.length;
      for (let i = 0; i < 150 && run.status === "running" && fake.steers.length === before; i += 1) await sleep(20);
      const kept = /\blate\b/.test(words) ? fake.steers.slice(before).join("\n") : "";
      const output = "Heard you.";
      return finish(run, "completed", { completed: true, output, usage, runtime: { model: "heron-2" }, ...(kept === "" ? {} : { pending_steer: kept }) });
    }
    if (/\bdelegate\b/.test(words)) {
      emit(run, "subagent.start", { goal: "Find three quotes" });
      emit(run, "subagent.complete", { status: "completed", summary: "Three quotes found.", cost_usd: 0.02, model: "heron-mini" });
      return finish(run, "completed", { completed: true, output: "Quotes are in.", usage, runtime: { model: "heron-2" } });
    }
    emit(run, "reasoning.available", { text: "Let me look at the notes." });
    emit(run, "tool.started", { tool: "read_file", preview: "notes.md" });
    emit(run, "tool.completed", { tool: "read_file", duration: 0.05, error: false, preview: "3 lines" });
    emit(run, "message.delta", { delta: "Here is " });
    if (/\bdrop\b/.test(words)) {
      // The stream is lost on its next word, and the run ends unheard.
      run.drop = true;
      run.output = "Here is the answer.";
      emit(run, "message.delta", { delta: "the answer." });
      await sleep(50);
      run.status = "completed";
      return;
    }
    emit(run, "message.delta", { delta: "the answer." });
    finish(run, "completed", { completed: true, output: "Here is the answer.", usage, runtime: { model: "heron-2" } });
  };

  const json = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  };

  const stream = (run: FakeRun, response: ServerResponse) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": keepalive\n\n");
    let seq = 0;
    const send = (event: Event) => {
      seq += 1;
      response.write(`id: ${seq}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.event.startsWith("run.") && event.event !== "run.steered") response.end();
      if (run.drop === true && event.event === "message.delta") response.destroy();
    };
    for (const event of run.events) send(event);
    run.listeners.add(send);
    response.on("close", () => run.listeners.delete(send));
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      if (url.pathname === "/health") return json(response, fake.up ? 200 : 503, { status: fake.up ? "ok" : "down" });
      const profiled = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
      const profile = profiled?.[1] ?? "default";
      const own = fake.root === undefined || profile === "default" ? undefined : envValue(profileHome(fake.root, profile), "API_SERVER_KEY");
      if (request.headers.authorization !== `Bearer ${own ?? key}`) return json(response, 401, { error: { message: "no key" } });
      const path = profiled?.[2] ?? url.pathname;
      const method = request.method ?? "GET";
      if (method === "GET" && path === "/api/model/options") {
        fake.optionsAsked.push(profile);
        return json(response, 200, fake.options(profile));
      }
      if (method === "GET" && path === "/v1/models") {
        return json(response, 200, { object: "list", data: [{ id: "hermes-agent", object: "model", owned_by: "hermes" }] });
      }
      if (method === "POST" && path === "/api/sessions") {
        // Hermes keeps a session's title to that session, as its API server does.
        const title = String((await bodyOf(request))["title"] ?? "");
        const taken = titles.get(title);
        if (taken !== undefined) {
          return json(response, 400, { error: { message: `Title '${title}' is already in use by session ${taken}` } });
        }
        const id = `sess_${fake.sessions.length + 1}`;
        fake.sessions.push(id);
        histories.set(id, []);
        if (title !== "") titles.set(title, id);
        return json(response, 200, { id });
      }
      const forked = /^\/api\/sessions\/([^/]+)\/fork$/.exec(path);
      if (method === "POST" && forked !== null) {
        const from = decodeURIComponent(forked[1] ?? "");
        const body = await bodyOf(request);
        const asked = typeof body["id"] === "string" ? body["id"] : undefined;
        const title = typeof body["title"] === "string" ? body["title"] : undefined;
        const made = !histories.has(asked ?? "") && histories.has(from);
        fake.forks.push({ from, id: asked, title, profile, made });
        if (!histories.has(from)) return json(response, 404, { error: { message: `Session not found: ${from}` } });
        const id = asked ?? `fork_${fake.forks.length}`;
        if (histories.has(id)) return json(response, 409, { error: { message: `Session already exists: ${id}`, code: "session_exists" } });
        // As Hermes: the copy first, then the original ended, then the title, which may be refused.
        histories.set(id, [...(histories.get(from) ?? [])]);
        if (!fake.ended.has(from)) fake.ended.set(from, "branched");
        const taken = title === undefined ? undefined : titles.get(title);
        if (taken !== undefined) {
          return json(response, 400, { error: { message: `Title '${title}' is already in use by session ${taken}`, code: "invalid_title" } });
        }
        if (title !== undefined) titles.set(title, id);
        return json(response, 201, { object: "hermes.session", session: { id, parent_session_id: from, title } });
      }
      const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
      if (method === "GET" && messages !== null) {
        const id = decodeURIComponent(messages[1] ?? "");
        if (!histories.has(id)) return json(response, 404, { error: { message: `Session not found: ${id}` } });
        const latest = latestOf(id);
        return json(response, 200, { object: "list", session_id: latest, data: histories.get(latest) ?? [] });
      }
      if (method === "POST" && path === "/v1/runs") {
        const body = await bodyOf(request);
        count += 1;
        const run: FakeRun = { id: `run_${count}`, input: String(body["input"]), status: "running", events: [], listeners: new Set() };
        runs.set(run.id, run);
        // A run naming a compressed session goes on in its latest, as Hermes's `/v1/runs` does.
        const named = typeof body["session_id"] === "string" ? body["session_id"] : undefined;
        if (named !== undefined) run.session = latestOf(named);
        if (named !== undefined) run.named = named;
        run.profile = profile;
        const history = run.session === undefined ? [] : (histories.get(run.session) ?? []);
        if (run.session !== undefined) histories.set(run.session, [...history, run.input]);
        fake.started.push({
          history: [...history],
          input: run.input,
          sessionId: typeof body["session_id"] === "string" ? body["session_id"] : undefined,
          model: typeof body["model"] === "string" ? body["model"] : undefined,
          provider: typeof body["provider"] === "string" ? body["provider"] : undefined,
          instructions: typeof body["instructions"] === "string" ? body["instructions"] : undefined,
          profile,
          idempotencyKey: request.headers["idempotency-key"] as string | undefined,
        });
        void play(run);
        return json(response, 202, { run_id: run.id, status: "started", replayed: false });
      }
      const route = /^\/v1\/runs\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
      const run = route === null ? undefined : runs.get(route[1] ?? "");
      if (run === undefined) return json(response, 404, { error: { message: "no such run" } });
      const action = route?.[2];
      if (method === "GET" && action === "events") return stream(run, response);
      if (method === "GET" && action === undefined) {
        return json(response, 200, { object: "hermes.run", run_id: run.id, status: run.status, output: run.output ?? "", usage });
      }
      const body = await bodyOf(request);
      if (action === "stop") {
        fake.stops.push(run.id);
        json(response, 200, { status: "stopping" });
        await sleep(10);
        return finish(run, "cancelled", { completed: false, interrupted: true });
      }
      if (action === "steer") {
        if (run.status !== "running") return json(response, 409, { error: { message: "not running", code: "run_not_accepting_steer" } });
        fake.steers.push(String(body["input"]));
        emit(run, "run.steered", { accepted: true });
        return json(response, 200, { object: "hermes.run.steer", run_id: run.id, accepted: true });
      }
      if (action === "approval") {
        fake.answers.push(body);
        if (run.answer === undefined) return json(response, 409, { error: { message: "nothing pending", code: "approval_not_pending" } });
        const answer = run.answer;
        run.answer = undefined;
        answer(String(body["choice"]));
        emit(run, "approval.responded", { choice: body["choice"], request_id: body["request_id"], resolved: true });
        return json(response, 200, { object: "hermes.run.approval_response", run_id: run.id, choice: body["choice"], resolved: true });
      }
      return json(response, 404, { error: { message: "no such route" } });
    })().catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: { message: String(error) } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  }) as FakeHermes;
}

/** Hermes's CLI and control socket for profiles, as the bridge uses them, on a root of the test's. */
export interface FakeProfiles {
  create(name: string, from: string): Promise<void>;
  serve(): Promise<boolean | undefined>;
  /** Each profile made, from which. */
  readonly made: { readonly name: string; readonly from: string }[];
  /** What the gateway answers when asked to serve them: the first, then the next, the last again. */
  answers: (boolean | undefined)[];
  /** How often it was asked. */
  asked: number;
  /** Words Hermes refuses the next profile with, once. */
  refuse?: string | undefined;
}

/**
 * Profiles made as `hermes profile create <name> --clone-from <from>` makes one in Hermes 0.22.0:
 * the source's `config.yaml`, its `.env` without the API server's lines (a messaging channel, to
 * Hermes), `SOUL.md` and memory files, in `profiles/<name>` under the root.
 */
export function fakeProfiles(root: string): FakeProfiles {
  const fake: FakeProfiles = {
    made: [],
    answers: [true],
    asked: 0,
    async create(name, from) {
      const refused = fake.refuse;
      fake.refuse = undefined;
      if (refused !== undefined) throw new Error(refused);
      const source = profileHome(root, from);
      const home = profileHome(root, name);
      if (existsSync(home)) throw new Error(`Profile '${name}' already exists`);
      mkdirSync(join(home, "memories"), { recursive: true });
      for (const file of ["config.yaml", "SOUL.md", "memories/MEMORY.md", "memories/USER.md"]) {
        if (existsSync(join(source, file))) copyFileSync(join(source, file), join(home, file));
      }
      const env = existsSync(join(source, ".env")) ? readFileSync(join(source, ".env"), "utf8") : "";
      writeFileSync(join(home, ".env"), env.split("\n").filter((line) => !line.startsWith("API_SERVER_")).join("\n"), { mode: 0o600 });
      fake.made.push({ name, from });
    },
    async serve() {
      fake.asked += 1;
      return fake.answers[Math.min(fake.asked - 1, fake.answers.length - 1)];
    },
  };
  return fake;
}
