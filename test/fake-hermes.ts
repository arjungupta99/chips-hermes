/**
 * A scripted Hermes API server for the tests, on Hermes's own routes and event names: a run plays
 * by the words it was given.
 * - `ask` asks before running a command, and says the choice it was given.
 * - `delegate` hands work to a sub-agent that says what it cost.
 * - `elsewhere` asks, and is answered in Hermes's own tools.
 * - `fail` fails.
 * - `slow` writes until it is stopped.
 * - `drop` loses its stream midway and is read from its state.
 * - Anything else reads a file and answers.
 *
 * With `askFirst`, every run asks before it answers, as the golden scenario needs.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

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
}

export interface Started {
  readonly input: string;
  readonly sessionId: string | undefined;
  readonly model: string | undefined;
  readonly profile: string;
  readonly idempotencyKey: string | undefined;
}

export interface FakeHermes {
  readonly url: string;
  readonly key: string;
  readonly started: Started[];
  readonly sessions: string[];
  readonly answers: Record<string, unknown>[];
  readonly steers: string[];
  readonly stops: string[];
  up: boolean;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeHermes(options: { askFirst?: boolean } = {}): Promise<FakeHermes> {
  const key = "hermes-test-key";
  const runs = new Map<string, FakeRun>();
  let count = 0;
  /** Each session's title, as Hermes keeps it: no two sessions share one. */
  const titles = new Map<string, string>();
  const fake: Omit<FakeHermes, "url" | "close"> = {
    key,
    started: [],
    sessions: [],
    answers: [],
    steers: [],
    stops: [],
    up: true,
  };

  const emit = (run: FakeRun, event: string, fields: Record<string, unknown> = {}) => {
    const sent: Event = { event, run_id: run.id, timestamp: Date.now() / 1000, ...fields };
    run.events.push(sent);
    for (const listener of run.listeners) listener(sent);
  };
  const finish = (run: FakeRun, status: string, fields: Record<string, unknown>) => {
    if (["completed", "failed", "cancelled"].includes(run.status)) return;
    run.status = status;
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
  const usage = { input_tokens: 1200, output_tokens: 40, total_tokens: 1240, cache_read_tokens: 0, cache_write_tokens: 0 };

  const play = async (run: FakeRun) => {
    await sleep(20);
    // The person's words, the input's last line: not the room note before them, which may say "ask".
    const words = run.input.split("\n").at(-1) ?? "";
    if (options.askFirst === true || /\bask\b/.test(words)) {
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
      if (request.headers.authorization !== `Bearer ${key}`) return json(response, 401, { error: { message: "no key" } });
      const profiled = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
      const profile = profiled?.[1] ?? "default";
      const path = profiled?.[2] ?? url.pathname;
      const method = request.method ?? "GET";
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
        if (title !== "") titles.set(title, id);
        return json(response, 200, { id });
      }
      if (method === "POST" && path === "/v1/runs") {
        const body = await bodyOf(request);
        count += 1;
        const run: FakeRun = { id: `run_${count}`, input: String(body["input"]), status: "running", events: [], listeners: new Set() };
        runs.set(run.id, run);
        fake.started.push({
          input: run.input,
          sessionId: typeof body["session_id"] === "string" ? body["session_id"] : undefined,
          model: typeof body["model"] === "string" ? body["model"] : undefined,
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
