/**
 * A Hermes profile of its own for each agent made in Chips (Chips ADR 0241): its name, what the
 * bridge changes in Hermes's clone, Hermes's CLI run on a machine of the test's own, and the
 * gateway's control socket, played by a socket of the test's. Nothing here runs Hermes or touches
 * ~/.hermes.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { EXPAT } from "../src/gateway.ts";
import { envValue } from "../src/home.ts";
import { hookUrl } from "../src/hooks.ts";
import { askGateway, freeProfile, hermesProfiles, readyProfile } from "../src/profiles.ts";

const open: (() => void)[] = [];
afterEach(() => {
  for (const close of open.splice(0).reverse()) close();
});

function scratch(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  open.push(() => rmSync(folder, { recursive: true, force: true }));
  return folder;
}

describe("a profile's name", () => {
  it("is the agent's, in the letters Hermes takes, and the next free one when Hermes or the bridge has it", () => {
    const root = scratch("chips-hermes-names-");
    assert.equal(freeProfile(root, "Nova", []), "nova");
    assert.equal(freeProfile(root, "Nova · fork", []), "nova-fork");
    assert.equal(freeProfile(root, "Zoë & Bo", []), "zoe-bo");
    assert.equal(freeProfile(root, "!!!", []), "agent");
    assert.equal(freeProfile(root, "Nova", ["nova"]), "nova-2");
    mkdirSync(join(root, "profiles", "vega"), { recursive: true });
    assert.equal(freeProfile(root, "Vega", []), "vega-2", "a profile Hermes has, made by hand");
    assert.equal(freeProfile(root, "Hermes", []), "hermes-2", "a name Hermes keeps for itself");
    assert.equal(freeProfile(root, "Default", []), "default-2");
    assert.match(freeProfile(root, "a".repeat(100), []), /^[a-z0-9][a-z0-9_-]{0,63}$/);
  });
});

describe("a clone made the agent's own", () => {
  /** A profile as `hermes profile create nova --clone-from default` leaves it. */
  function cloned(): string {
    const home = join(scratch("chips-hermes-clone-"), "profiles", "nova");
    mkdirSync(join(home, "memories"), { recursive: true });
    writeFileSync(join(home, "SOUL.md"), "You are Hermes.\n");
    writeFileSync(join(home, "memories", "MEMORY.md"), "Arjun likes tea");
    writeFileSync(join(home, "memories", "USER.md"), "Arjun is an engineer");
    writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=k\nCHIPS_HOOK_SECRET=s", { mode: 0o600 });
    writeFileSync(
      join(home, "config.yaml"),
      [
        "model:",
        "  default: heron-2",
        "hooks:",
        "  outbound:",
        "    - name: chips",
        `      url: ${hookUrl(4100, "default")}`,
        "      events: [post_api_request]",
        "      secret_env: CHIPS_HOOK_SECRET",
        "      timeout: 5",
        "",
      ].join("\n"),
    );
    return home;
  }

  it("forgets the Main agent's memory, has a key of its own, and has Chips's webhook at its own address", () => {
    const home = cloned();
    const outcome = readyProfile(home, { from: "default", profile: "nova" }, { port: 4100, secret: "fallback" });
    assert.equal(outcome?.state, "there");
    assert.deepEqual(
      ["MEMORY.md", "USER.md"].map((file) => {
        try {
          return readFileSync(join(home, "memories", file), "utf8");
        } catch {
          return undefined;
        }
      }),
      [undefined, undefined],
    );
    assert.equal(readFileSync(join(home, "SOUL.md"), "utf8"), "You are Hermes.\n", "its persona to start from");
    const key = envValue(home, "API_SERVER_KEY") ?? "";
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(envValue(home, "ANTHROPIC_API_KEY"), "k", "the line before it kept whole");
    assert.equal(statSync(join(home, ".env")).mode & 0o777, 0o600);
    const config = readFileSync(join(home, "config.yaml"), "utf8");
    assert.ok(config.includes(`url: ${hookUrl(4100, "nova")}\n`), config);
    assert.ok(!config.includes("/chips-hermes/default"));
    // Done again, nothing changes: the key is kept.
    readyProfile(home, { from: "default", profile: "nova" }, { port: 4100, secret: "fallback" });
    assert.equal(envValue(home, "API_SERVER_KEY"), key);
  });

  it("adds Chips's webhook where the Main agent's config had none", () => {
    const home = cloned();
    writeFileSync(join(home, "config.yaml"), "model:\n  default: heron-2\n");
    assert.equal(readyProfile(home, { from: "default", profile: "nova" }, { port: 4100, secret: "fallback" })?.state, "added");
    assert.ok(readFileSync(join(home, "config.yaml"), "utf8").includes(`url: ${hookUrl(4100, "nova")}`));
    assert.equal(readyProfile(home, { from: "default", profile: "nova" }), undefined, "no webhook when the bridge listens for none");
  });
});

describe("Hermes's CLI and gateway for profiles", () => {
  const HERMES = "/opt/homebrew/bin/hermes";
  const ENTRY = "/opt/homebrew/Cellar/hermes-agent/0.22.0/libexec/bin/hermes";
  const WRAPPER = `#!/bin/bash\nHERMES_PYTHON="/opt/homebrew/Cellar/hermes-agent/0.22.0/libexec/bin/python3" exec "${ENTRY}"  "$@"\n`;
  const EXPAT_DEATH =
    "ImportError: dlopen(pyexpat.cpython-314-darwin.so, 0x0002): Symbol not found: _XML_SetAllocTrackerActivationThreshold\n";

  /** A machine with Hermes's wrapper on its PATH, and what each run of a command says. */
  function machine(answers: { code: number | null; output: string }[], expat = true) {
    const runs: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const files = new Map([[HERMES, WRAPPER], ...(expat ? [[EXPAT, ""] as const] : [])]);
    return {
      runs,
      system: {
        which: (command: string) => (command === "hermes" ? HERMES : undefined),
        read: (path: string) => files.get(path),
        exists: (path: string) => files.has(path),
        run: async (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
          runs.push({ command, args, env });
          return answers[Math.min(runs.length - 1, answers.length - 1)] ?? { code: 0, output: "" };
        },
      },
    };
  }

  it("makes a profile as hermes profile create does, cloned from the Main agent's, with no shell alias", async () => {
    const { runs, system } = machine([{ code: 0, output: "Profile 'nova' created" }]);
    const made = hermesProfiles({ root: "/nowhere", env: { PATH: "/opt/homebrew/bin", CHIPS_JOIN_LINK: "x" }, system, log: () => undefined });
    await made.create("nova", "default");
    assert.deepEqual(
      runs.map((run) => [run.command, run.args.join(" ")]),
      [[HERMES, "profile create nova --clone-from default --no-alias"]],
    );
    assert.equal(runs[0]?.env["CHIPS_JOIN_LINK"], undefined, "nothing of Chips's goes to Hermes");
  });

  it("runs Hermes's entry point with Homebrew's expat when its Python can't load macOS's", async () => {
    const { runs, system } = machine([{ code: 1, output: EXPAT_DEATH }, { code: 0, output: "Profile 'nova' created" }]);
    const said: string[] = [];
    await hermesProfiles({ root: "/nowhere", env: { PATH: "/opt/homebrew/bin" }, system, log: (line) => void said.push(line) }).create("nova", "default");
    assert.deepEqual(
      runs.map((run) => run.command),
      [HERMES, ENTRY],
    );
    assert.equal(runs[1]?.env["DYLD_LIBRARY_PATH"], "/opt/homebrew/opt/expat/lib");
    assert.equal(runs[1]?.env["HERMES_PYTHON"], "/opt/homebrew/Cellar/hermes-agent/0.22.0/libexec/bin/python3");
    assert.match(said[0] ?? "", /^hermes profile create stopped at once: Homebrew's Python can't load macOS's expat/);
  });

  it("refuses in Hermes's words when Hermes doesn't make it", async () => {
    const { system } = machine([{ code: 1, output: "Error: Profile 'nova' already exists at /x\n" }]);
    await assert.rejects(
      hermesProfiles({ root: "/nowhere", env: {}, system, log: () => undefined }).create("nova", "default"),
      (error: Error) => error.message === "Profile 'nova' already exists at /x",
    );
  });

  /** A gateway's control socket in a home of the test's, answering each verb as `answer` says. */
  async function gateway(answer: (verb: string) => string | undefined, pointed = false) {
    const root = scratch("chips-hermes-gw-");
    const path = pointed ? join(scratch("chips-hermes-sock-"), "hermes-gw.sock") : join(root, "gateway.sock");
    if (pointed) writeFileSync(join(root, "gateway.sock.path"), `${path}\n`);
    const verbs: string[] = [];
    const server: Server = createServer((socket) => {
      socket.on("data", (chunk) => {
        const asked = JSON.parse(String(chunk).trim()) as { verb: string; protocol: number };
        verbs.push(`${asked.verb} ${asked.protocol}`);
        const said = answer(asked.verb);
        if (said === undefined) socket.destroy();
        else socket.end(`${said}\n`);
      });
    });
    await new Promise<void>((done) => server.listen(path, done));
    open.push(() => server.close());
    return { root, verbs };
  }

  it("asks the gateway to serve the profiles there are now, and hears whether it serves each", async () => {
    const both = await gateway(() => JSON.stringify({ ok: true, protocol: 1, id: 1, result: { multiplex: true, added: ["nova"] } }));
    const made = hermesProfiles({ root: both.root, env: {}, system: machine([]).system, log: () => undefined });
    assert.equal(await made.serve(), true);
    assert.deepEqual(both.verbs, ["rescan-profiles 1"]);
    const one = await gateway(() => JSON.stringify({ ok: true, protocol: 1, id: 1, result: { multiplex: false, served_profiles: ["default"] } }), true);
    assert.equal(await hermesProfiles({ root: one.root, env: {}, system: machine([]).system, log: () => undefined }).serve(), false);
  });

  it("hears nothing from a gateway with no socket, a refusal or no answer", async () => {
    assert.equal(await askGateway(scratch("chips-hermes-none-"), "rescan-profiles"), undefined);
    const refused = await gateway(() => JSON.stringify({ ok: false, error: "unknown verb" }));
    assert.equal(await askGateway(refused.root, "rescan-profiles"), undefined);
    const silent = await gateway(() => undefined);
    assert.equal(await askGateway(silent.root, "rescan-profiles", 500), undefined);
  });
});
