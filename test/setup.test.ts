/**
 * What the bridge checks before it takes up a link (Chips ADR 0122): a link works once, so a
 * config missing, a key left as the command's `…`, Hermes not answering, or Hermes refusing the
 * key stops it first.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkedWords, checkHermes, readConfig, SetupError, STILL_GOOD, serverOnLine } from "../src/setup.ts";

const folder = mkdtempSync(join(tmpdir(), "chips-hermes-setup-"));
const config = join(folder, "config.json");
writeFileSync(config, JSON.stringify({ agents: [{ name: "Hermes", profile: "default", keyEnv: "API_SERVER_KEY" }] }));

// Hermes's own settings, kept apart from this Mac's: a test never reads the real ~/.hermes/.env.
const hermesHome = mkdtempSync(join(tmpdir(), "chips-hermes-home-"));
const noHermes = { HERMES_HOME: mkdtempSync(join(tmpdir(), "chips-hermes-none-")) };
// A home of the test's own: where the agents' folders go by default depends on what is in it.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "chips-hermes-home-"));

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
    assert.equal(read.folders, join(homedir(), "Chips", "Agents", "hermes"));
  });

  it("stops on a key left as the command's placeholder, or not set, saying how to turn the API server on", () => {
    assert.throws(
      () => readConfig(config, { ...noHermes, API_SERVER_KEY: "…" }),
      stopsWith(/Hermes's key isn't in \$API_SERVER_KEY or .*\.env\. Turn on Hermes's API server: add API_SERVER_ENABLED=true/),
    );
    assert.throws(() => readConfig(config, noHermes), stopsWith(/key isn't in/));
  });

  it("says Hermes isn't installed, with its own line, only when nothing says it is", () => {
    const none = join(folder, "not-there.json");
    const bin = mkdtempSync(join(tmpdir(), "chips-hermes-bin-"));
    const words = (env: NodeJS.ProcessEnv, path = none) => {
      try {
        readConfig(path, env);
      } catch (error) {
        assert.ok(error instanceof SetupError);
        assert.ok(error.message.includes(STILL_GOOD));
        return error.words;
      }
      return undefined;
    };
    assert.deepEqual(words({ ...noHermes, PATH: bin }), {
      detail: "Hermes isn't on this Mac",
      says: "Hermes isn't installed on this Mac.",
      doing: "Run this in Terminal, then run hermes setup and try again.",
      copy: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    });
    // A config of its own may name a Hermes somewhere else: there the key is what's missing.
    assert.equal(words({ ...noHermes, PATH: bin }, config)?.says, "Hermes's API server isn't set up.");
    writeFileSync(join(bin, "hermes"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(words({ ...noHermes, PATH: bin })?.says, "Hermes's API server isn't set up.");
  });

  it("gives a line to copy that turns on Hermes's API server, which then has a key", () => {
    const home = mkdtempSync(join(tmpdir(), "chips-hermes-home-"));
    // A .env that doesn't end its last line: the line starts one of its own.
    writeFileSync(join(home, ".env"), "OPENAI_API_KEY=sk-1");
    const env = { ...noHermes, HERMES_HOME: home };
    const words = (() => {
      try {
        readConfig(config, env);
      } catch (error) {
        return error instanceof SetupError ? error.words : undefined;
      }
      return undefined;
    })();
    assert.equal(words?.copy, serverOnLine(join(home, ".env")));
    execFileSync("sh", ["-c", serverOnLine(join(home, ".env"))]);
    const key = readConfig(config, env).agents[0]?.address.key;
    assert.match(key ?? "", /^[0-9a-f]{64}$/);
    assert.match(readFileSync(join(home, ".env"), "utf8"), /^OPENAI_API_KEY=sk-1\nAPI_SERVER_ENABLED=true\nAPI_SERVER_KEY=/);
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

  // Chips for Mac's sheet (Chips ADR 0218, phase 5): a few words under the step, the sentence,
  // what to do, and a line to copy; the terminal keeps the whole sentence.
  it("says where it stopped in a few words for Chips for Mac's sheet, and what it found", async () => {
    const read = readConfig(config, { API_SERVER_KEY: "hk-live" });
    const stopped = await checkHermes(read, () => ({ healthy: async () => false, takesKey: async () => true })).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(stopped instanceof SetupError);
    assert.deepEqual(
      { ...stopped.words, doing: stopped.words.doing?.replace(/ to \S+\.env,/, " to .env,") },
      {
        detail: "Nothing answers on port 8642",
        says: "Hermes's API server is off.",
        doing: "Add this line to .env, then start Hermes with hermes gateway.",
        copy: "API_SERVER_ENABLED=true",
      },
    );
    assert.equal(checkedWords(read), "Its API server answers on port 8642");
  });
});
