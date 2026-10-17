/**
 * What the bridge checks before it takes up a link (Chips ADR 0122): a link works once, so a
 * config missing, a key left as the command's `…`, Hermes not answering, or Hermes refusing the
 * key stops it first.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkHermes, readConfig, SetupError, STILL_GOOD } from "../src/setup.ts";

const folder = mkdtempSync(join(tmpdir(), "chips-hermes-setup-"));
const config = join(folder, "config.json");
writeFileSync(config, JSON.stringify({ agents: [{ name: "Hermes", profile: "default", keyEnv: "API_SERVER_KEY" }] }));

// Hermes's own settings, kept apart from this Mac's: a test never reads the real ~/.hermes/.env.
const hermesHome = mkdtempSync(join(tmpdir(), "chips-hermes-home-"));
const noHermes = { HERMES_HOME: mkdtempSync(join(tmpdir(), "chips-hermes-none-")) };

const stopsWith = (pattern: RegExp) => (error: unknown) =>
  error instanceof SetupError && pattern.test(error.message) && error.message.includes(STILL_GOOD);

describe("before the link is taken up", () => {
  it("takes Hermes's default profile with no config, and a folder of its own for each agent", () => {
    // A person who runs Hermes writes nothing first (the setup audit, 17 October 2026).
    const read = readConfig(join(folder, "none.json"), { ...noHermes, API_SERVER_KEY: "hk-live" });
    assert.deepEqual(
      read.agents.map((agent) => [agent.name, agent.address.profile, agent.address.url]),
      [["Hermes", "default", "http://127.0.0.1:8642"]],
    );
    assert.equal(read.folders, join(homedir(), "chips-hermes", "agents"));
  });

  it("stops on a key left as the command's placeholder, or not set, saying how to turn the API server on", () => {
    assert.throws(
      () => readConfig(config, { ...noHermes, API_SERVER_KEY: "…" }),
      stopsWith(/Hermes's key isn't in \$API_SERVER_KEY or .*\.env\. Turn on Hermes's API server: add API_SERVER_ENABLED=true/),
    );
    assert.throws(() => readConfig(config, noHermes), stopsWith(/key isn't in/));
  });

  it("reads the key from Hermes's own settings when the environment doesn't give it", () => {
    writeFileSync(join(hermesHome, ".env"), 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY="hk-from-hermes"\n');
    assert.equal(readConfig(config, { HERMES_HOME: hermesHome }).agents[0]?.address.key, "hk-from-hermes");
    // The card's placeholder is no key: Hermes's own is used in its place.
    assert.equal(readConfig(config, { HERMES_HOME: hermesHome, API_SERVER_KEY: "…" }).agents[0]?.address.key, "hk-from-hermes");
  });

  it("reads each agent with its key when it is filled in", () => {
    const read = readConfig(config, { API_SERVER_KEY: "hk-live" });
    assert.equal(read.agents[0]?.address.key, "hk-live");
  });

  it("stops while Hermes isn't answering, and goes on once it is", async () => {
    const read = readConfig(config, { API_SERVER_KEY: "hk-live" });
    await assert.rejects(
      checkHermes(read, () => ({ healthy: async () => false, takesKey: async () => true })),
      stopsWith(/Hermes isn't answering for Hermes at http:\/\/127\.0\.0\.1:8642/),
    );
    await checkHermes(read, () => ({ healthy: async () => true, takesKey: async () => true }));
  });

  // Its `/health` needs no key, so a key mistyped answers there (C2, 16 October 2026).
  it("stops when Hermes answers but refuses the key", async () => {
    const read = readConfig(config, { API_SERVER_KEY: "hk-mistyped" });
    await assert.rejects(
      checkHermes(read, () => ({ healthy: async () => true, takesKey: async () => false })),
      stopsWith(/Hermes at http:\/\/127\.0\.0\.1:8642 refused Hermes's key, from \$API_SERVER_KEY: it has to be/),
    );
  });
});
