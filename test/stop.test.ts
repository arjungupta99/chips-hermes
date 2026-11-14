/**
 * A stop while the bridge is still starting, as `kill` or the service that keeps it running sends
 * one. The bridge is run as it runs for real, `src/main.ts` as a process of its own, with a key it
 * kept before, and is stopped while it waits for a Chips that is down, and while `bridge.start()`
 * waits for Hermes. Either way what the start had opened is closed first: a stop used to be heard
 * only once the start was done, and one before then saved nothing. A start that was stopped still
 * ends as the signal, so `chips connect`, which reads an exit of 0 as connected, never takes it for
 * one that worked; once it has started, a stop is a clean end.
 *
 * Nothing of this machine's is read or written: its home, Hermes's home, its config and its key are
 * in a folder made for the test, Chips is the conformance kit's fake and Hermes the tests' own, and
 * no `hermes` is on its PATH to start.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { type FakeChips, startFakeChips } from "@chipschat/conformance";
import { join as joinChips } from "@chipschat/harness";
import { type FakeHermes, startFakeHermes } from "./fake-hermes.ts";

const here = join(import.meta.dirname, "..");

/** Once `check` holds, looked at every few milliseconds; `why` it didn't is said when it never does. */
async function until(check: () => boolean, why: () => string, ms = 15_000): Promise<void> {
  for (const by = Date.now() + ms; !check(); await new Promise((done) => setTimeout(done, 10))) {
    if (Date.now() > by) assert.fail(why());
  }
}

/** A home of its own for the bridge, with the key a first run keeps and its config. */
async function scratch(chips: FakeChips, hermes: FakeHermes) {
  const home = mkdtempSync(join(tmpdir(), "chips-hermes-stop-"));
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    HERMES_HOME: join(home, "hermes"),
    API_SERVER_KEY: hermes.key,
    CHIPS_URL: chips.address.url,
    CHIPS_CONFIG_HOME: join(home, "config"),
    CHIPS_NO_KEYCHAIN: "true",
    CHIPS_KEEP: "off",
  };
  await joinChips({ link: chips.makeJoinLink(["agents"]), name: "Hermes", env });
  const kept = join(home, "bridge");
  mkdirSync(kept);
  const config = join(kept, "config.json");
  writeFileSync(
    config,
    JSON.stringify({ url: hermes.url, folders: join(home, "agents"), agents: [{ name: "Hermes", profile: "default" }] }),
  );
  return { home, env, config, kept };
}

/** `src/main.ts` as a process: what it has said, a stop sent to it, and how it ended. */
function run(config: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", config], {
    cwd: here,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => (said += String(data)));
  let over = false;
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("exit", (code, signal) => {
      over = true;
      done({ code, signal });
    });
  });
  return {
    said: () => said,
    ended,
    /** Once it has got to `what`; failing, with what it said, when it ended first or never did. */
    until: async (what: string, check: () => boolean) => {
      await until(() => check() || over, () => `it never ${what}:\n${said}`);
      assert.ok(check(), `it ended before it ${what}:\n${said}`);
    },
    stop: () => child.kill("SIGTERM"),
    /** However the test went, no bridge is left running. */
    gone: () => {
      if (!over) child.kill("SIGKILL");
      return ended;
    },
  };
}

it("ends as the signal when it is stopped while it waits for Chips, not as a start that worked", async () => {
  const [chips, hermes] = await Promise.all([startFakeChips({ capabilities: ["agents"] }), startFakeHermes()]);
  const { home, env, config } = await scratch(chips, hermes);
  // Chips is down, and this is the copy the machine keeps running, which waits for it.
  await chips.close();
  const bridge = run(config, { ...env, XPC_SERVICE_NAME: "chat.chips.hermes" });
  try {
    await bridge.until("said it waits for Chips", () => /waiting for Chips/.test(bridge.said()));
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: null, signal: "SIGTERM" }, bridge.said());
  } finally {
    await bridge.gone();
    await hermes.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("saves what it keeps when it is stopped while it starts", async () => {
  const [chips, hermes] = await Promise.all([startFakeChips({ capabilities: ["agents"] }), startFakeHermes()]);
  const { home, env, config, kept } = await scratch(chips, hermes);
  // Hermes answers how it is until the bridge is connected to Chips, so the bridge finds it up and
  // starts none of its own; asked after that, by `bridge.start()`, it keeps the bridge waiting.
  let asked = false;
  let answer = () => {};
  const later = new Promise<void>((done) => {
    answer = done;
  });
  Object.defineProperty(hermes, "held", {
    get: () => {
      if (chips.connections() === 0) return undefined;
      asked = true;
      return later;
    },
  });
  const bridge = run(config, env);
  try {
    await bridge.until("asked Hermes how it is, connected", () => asked);
    // What the SDK keeps is saved by the stop itself: taken away here, it is written again.
    const state = join(kept, "chips-state.json");
    rmSync(state, { force: true });
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: null, signal: "SIGTERM" }, bridge.said());
    assert.ok(existsSync(state), "the SDK's state was saved as it stopped");
  } finally {
    await bridge.gone();
    answer();
    await Promise.all([hermes.close(), chips.close()]);
    rmSync(home, { recursive: true, force: true });
  }
});

it("ends cleanly, with what it keeps saved, when it is stopped once it has started", async () => {
  const [chips, hermes] = await Promise.all([startFakeChips({ capabilities: ["agents"] }), startFakeHermes()]);
  const { home, env, config, kept } = await scratch(chips, hermes);
  const bridge = run(config, env);
  try {
    await bridge.until("said it answers through Hermes", () => /answering for .* through Hermes/.test(bridge.said()));
    const state = join(kept, "chips-state.json");
    rmSync(state, { force: true });
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: 0, signal: null }, bridge.said());
    assert.ok(existsSync(state), "the SDK's state was saved as it stopped");
  } finally {
    await bridge.gone();
    await Promise.all([hermes.close(), chips.close()]);
    rmSync(home, { recursive: true, force: true });
  }
});
