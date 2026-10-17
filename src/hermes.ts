/**
 * Hermes Agent's API server, as the bridge speaks it (Hermes docs, "API Server"; its source,
 * `gateway/platforms/api_server_runs.py`, read 14 October 2026): a run started with
 * `POST /v1/runs`, its events read from `GET /v1/runs/{id}/events` (server-sent events, a comment
 * line every ten seconds), stopped, steered and answered by `POST`s of its own. Every call carries
 * the profile's key as a bearer. A profile other than the default is reached under `/p/<profile>`,
 * when Hermes multiplexes its profiles; otherwise each profile is a gateway of its own, at its own
 * address.
 */

/** One profile: where its gateway answers, and its key. */
export interface ProfileAddress {
  /** Its gateway: `http://127.0.0.1:8642`. */
  readonly url: string;
  /** `default`, or a profile reached under `/p/<profile>` on a multiplexing gateway. */
  readonly profile?: string | undefined;
  /** Its `API_SERVER_KEY`. */
  readonly key: string;
}

/** An event of a run, as Hermes sends it: `event`, `run_id`, `timestamp`, and its own fields. */
export type RunEvent = Readonly<Record<string, unknown>> & { readonly event: string };

/** The run's last word: its terminal event, or its state read after the stream was lost. */
export const TERMINAL: ReadonlySet<string> = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
]);

export class HermesError extends Error {
  override readonly name = "HermesError";
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string | undefined,
  ) {
    super(message);
  }
}

/** The fetch the client uses: the platform's, unless a test hands in its own. */
export type Fetch = typeof fetch;

export class HermesClient {
  private readonly base: string;

  constructor(
    private readonly address: ProfileAddress,
    private readonly fetcher: Fetch = fetch,
  ) {
    const root = address.url.replace(/\/+$/, "");
    const profile = address.profile;
    this.base = profile === undefined || profile === "default" ? root : `${root}/p/${encodeURIComponent(profile)}`;
  }

  /** Whether its gateway answers at all: `GET /health`, which needs no key. */
  async healthy(): Promise<boolean> {
    try {
      const answer = await this.fetcher(`${this.address.url.replace(/\/+$/, "")}/health`);
      return answer.ok;
    } catch {
      return false;
    }
  }

  /**
   * Whether it takes this profile's key: `GET /v1/models`, which needs it, as `/health` doesn't.
   * Only a 401 or 403 is the key's fault; any other answer isn't.
   */
  async takesKey(): Promise<boolean> {
    try {
      const answer = await this.fetcher(`${this.base}/v1/models`, {
        headers: { authorization: `Bearer ${this.address.key}` },
      });
      return answer.status !== 401 && answer.status !== 403;
    } catch {
      return true;
    }
  }

  /** A session of its own for a room: `POST /api/sessions`, so no other surface owns it. */
  async newSession(title: string): Promise<string> {
    const made = await this.call("POST", "/api/sessions", { title });
    const id = made["id"] ?? made["session_id"] ?? (made["session"] as Record<string, unknown> | undefined)?.["id"];
    if (typeof id !== "string" || id === "") throw new HermesError("Hermes made a session and named none", 502);
    return id;
  }

  /** A run in a session: what it is told, and under a key a retry of the same turn repeats. */
  async startRun(input: {
    readonly text: string;
    readonly sessionId: string;
    readonly model?: string | undefined;
    readonly key: string;
  }): Promise<string> {
    const started = await this.call(
      "POST",
      "/v1/runs",
      {
        input: input.text,
        session_id: input.sessionId,
        ...(input.model === undefined ? {} : { model: input.model }),
      },
      { "Idempotency-Key": input.key.slice(0, 255) },
    );
    if (typeof started["run_id"] !== "string") throw new HermesError("Hermes started a run and named none", 502);
    return started["run_id"];
  }

  /** The run as it stands: for the end of a run whose stream was lost. */
  run(runId: string): Promise<Record<string, unknown>> {
    return this.call("GET", `/v1/runs/${encodeURIComponent(runId)}`);
  }

  async stop(runId: string): Promise<void> {
    await this.call("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`, {});
  }

  /** More words for a run that is going: queued by Hermes for its next step. */
  async steer(runId: string, text: string): Promise<void> {
    await this.call("POST", `/v1/runs/${encodeURIComponent(runId)}/steer`, { input: text });
  }

  /** The answer to an approval: `once`, `session`, `always` or `deny`. */
  async approve(runId: string, answer: Readonly<Record<string, unknown>>): Promise<void> {
    await this.call("POST", `/v1/runs/${encodeURIComponent(runId)}/approval`, answer);
  }

  /**
   * The run's events, each handed to `hear` as it comes, until its terminal event or the stream
   * ends; the terminal event, or nothing when the stream ended first.
   */
  async events(
    runId: string,
    hear: (event: RunEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<RunEvent | undefined> {
    const answer = await this.fetcher(`${this.base}/v1/runs/${encodeURIComponent(runId)}/events`, {
      headers: { authorization: `Bearer ${this.address.key}`, accept: "text/event-stream" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!answer.ok || answer.body === null) throw await failureOf(answer);
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let end = buffered.indexOf("\n\n");
      while (end >= 0) {
        const event = eventOf(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        if (event !== undefined) {
          await hear(event);
          if (TERMINAL.has(event.event)) return event;
        }
        end = buffered.indexOf("\n\n");
      }
    }
    return undefined;
  }

  private async call(
    method: string,
    path: string,
    body?: Readonly<Record<string, unknown>>,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<Record<string, unknown>> {
    const answer = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.address.key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!answer.ok) throw await failureOf(answer);
    const text = await answer.text();
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  }
}

/** One server-sent event's lines: its `data`, read as Hermes's JSON, or nothing for a comment. */
function eventOf(block: string): RunEvent | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (data === "") return undefined;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const named = /^event: ?(.+)$/m.exec(block)?.[1];
    const event = typeof parsed["event"] === "string" ? parsed["event"] : named;
    return event === undefined ? undefined : { ...parsed, event };
  } catch {
    return undefined;
  }
}

async function failureOf(answer: Response): Promise<HermesError> {
  let message = `Hermes answered ${answer.status}`;
  let code: string | undefined;
  try {
    const body = (await answer.json()) as { error?: { message?: string; code?: string } | string; message?: string };
    const error = body.error;
    if (typeof error === "string") message = error;
    else if (error?.message !== undefined) message = error.message;
    else if (body.message !== undefined) message = body.message;
    code = typeof error === "object" ? error.code : undefined;
  } catch {
    // Not JSON: the status says enough.
  }
  return new HermesError(message, answer.status, code);
}
