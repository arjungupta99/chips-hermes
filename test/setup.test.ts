/**
 * What the bridge checks before it takes up a link (Chips ADR 0122): a link works once, so a
 * config missing, a key left as the command's `…`, Hermes not answering, or Hermes refusing the
 * key stops it first.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkHermes, readConfig, SetupError, STILL_GOOD } from "../src/setup.ts";

const folder = mkdtempSync(join(tmpdir(), "chips-hermes-setup-"));
const config = join(folder, "config.json");
writeFileSync(config, JSON.stringify({ agents: [{ name: "Hermes", profile: "default", keyEnv: "API_SERVER_KEY" }] }));

const stopsWith = (pattern: RegExp) => (error: unknown) =>
  error instanceof SetupError && pattern.test(error.message) && error.message.includes(STILL_GOOD);

describe("before the link is taken up", () => {
  it("stops on a config that isn't there, saying what to write", () => {
    assert.throws(() => readConfig(join(folder, "none.json"), {}), stopsWith(/no config at .*"agents"/));
  });

  it("stops on a key left as the command's placeholder, or not set", () => {
    assert.throws(() => readConfig(config, { API_SERVER_KEY: "…" }), stopsWith(/Hermes's key isn't in \$API_SERVER_KEY/));
    assert.throws(() => readConfig(config, {}), stopsWith(/key isn't in/));
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
      stopsWith(/Hermes at http:\/\/127\.0\.0\.1:8642 refused Hermes's key in \$API_SERVER_KEY/),
    );
  });
});
