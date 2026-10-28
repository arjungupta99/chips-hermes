/**
 * The webhook the bridge adds to a profile's `config.yaml`, so Hermes says how full each agent's
 * context is: added once where it can be added as text, never rewriting what is there, and said
 * as lines to add where it can't. In temporary homes: a test never touches the real ~/.hermes.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addHook, hookPortIn, hookUrl, SECRET_ENV } from "../src/hooks.ts";
import { yamlValue } from "../src/home.ts";
import { checkedWords, RESTART, readConfig, readyHooks } from "../src/setup.ts";

const SECRET = "a".repeat(64);

/** Hermes's config as `hermes setup` leaves one: what was set, and the commented sections after. */
const CONFIG = [
  "model:",
  "  default: heron-2",
  "  provider: anthropic",
  "_config_version: 50",
  "",
  "# ── Hooks ──────────────────────────────────────",
  "# hooks:",
  "#   pre_tool_call: []",
  "",
].join("\n");

function home(files: Record<string, string> = {}): string {
  const folder = mkdtempSync(join(tmpdir(), "chips-hermes-hooks-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text, { mode: 0o600 });
  return folder;
}

describe("Chips's webhook in Hermes's config", () => {
  it("appends it to a config with no hooks, once, with its secret in the profile's .env", () => {
    const folder = home({ "config.yaml": CONFIG, ".env": "API_SERVER_KEY=k" });
    const url = hookUrl(8650, "default");
    assert.deepEqual(addHook(folder, 8650, "default", SECRET), { state: "added", path: join(folder, "config.yaml") });
    const written = readFileSync(join(folder, "config.yaml"), "utf8");
    assert.ok(written.startsWith(CONFIG), "what was there is left as it was");
    assert.equal(
      written.slice(CONFIG.length),
      [
        "",
        "# Chips: how full each agent's context is, sent to the chips-hermes bridge after each model call.",
        "hooks:",
        "  outbound:",
        "    - name: chips",
        `      url: ${url}`,
        "      events: [post_api_request]",
        `      secret_env: ${SECRET_ENV}`,
        "      timeout: 5",
        "",
      ].join("\n"),
    );
    assert.equal(readFileSync(join(folder, ".env"), "utf8"), `API_SERVER_KEY=k\n${SECRET_ENV}=${SECRET}\n`);
    assert.equal(statSync(join(folder, "config.yaml")).mode & 0o777, 0o600, "still the owner's alone");
    // Again: there already, and nothing more is written.
    assert.equal(addHook(folder, 8650, "default", SECRET).state, "there");
    assert.equal(readFileSync(join(folder, "config.yaml"), "utf8"), written);
    assert.equal(readFileSync(join(folder, ".env"), "utf8"), `API_SERVER_KEY=k\n${SECRET_ENV}=${SECRET}\n`);
    // The bridge listens where the config says, next time.
    assert.equal(hookPortIn(folder), 8650);
    assert.equal(yamlValue(written, "model", "default"), "heron-2");
  });

  it("keeps the secret in the entry for a profile with no .env, and makes no .env", () => {
    const folder = home({ "config.yaml": "model:\n  default: heron-2" });
    assert.equal(addHook(folder, 8650, "default", SECRET).state, "added");
    const written = readFileSync(join(folder, "config.yaml"), "utf8");
    assert.ok(written.startsWith("model:\n  default: heron-2\n\n# Chips"), written);
    assert.match(written, new RegExp(`      secret: "${SECRET}"\n`));
    assert.ok(!existsSync(join(folder, ".env")));
  });

  it("writes a config for a profile that has none yet", () => {
    const folder = home();
    assert.equal(addHook(folder, 8650, "alice", SECRET).state, "added");
    assert.match(readFileSync(join(folder, "config.yaml"), "utf8"), /^# Chips.*\nhooks:\n {2}outbound:\n {4}- name: chips\n {6}url: http:\/\/127\.0\.0\.1:8650\/chips-hermes\/alice\n/);
    assert.equal(addHook(join(folder, "nobody"), 8650, "bob", SECRET).state, "no_home");
  });

  it("puts outbound first under a hooks: that has shell hooks and no outbound yet", () => {
    const config = [
      "model:",
      "  default: heron-2",
      "hooks:",
      "    # a shell hook",
      "    pre_tool_call:",
      "      - command: ~/bin/check.sh",
      "hooks_auto_accept: true",
      "",
    ].join("\n");
    const folder = home({ "config.yaml": config, ".env": "" });
    assert.equal(addHook(folder, 8650, "default", SECRET).state, "added");
    assert.equal(
      readFileSync(join(folder, "config.yaml"), "utf8"),
      [
        "model:",
        "  default: heron-2",
        "hooks:",
        "    outbound:",
        "      - name: chips",
        "        url: http://127.0.0.1:8650/chips-hermes/default",
        "        events: [post_api_request]",
        `        secret_env: ${SECRET_ENV}`,
        "        timeout: 5",
        "    # a shell hook",
        "    pre_tool_call:",
        "      - command: ~/bin/check.sh",
        "hooks_auto_accept: true",
        "",
      ].join("\n"),
    );
  });

  it("leaves a hooks: it can't add to as text as it was, and says the lines to add", () => {
    for (const config of [
      "hooks: {}\n",
      '"hooks":\n  outbound: []\n',
      "{model: {default: heron-2}}\n",
      "hooks:\n  outbound:\n    - name: mine\n      url: https://example.com/hook\n      events: [on_session_end]\n",
      "hooks:\n  outbound:\n    - name: chips\n      url: http://127.0.0.1:9999/chips-hermes/default\n",
    ]) {
      const folder = home({ "config.yaml": config, ".env": "API_SERVER_KEY=k\n" });
      const outcome = addHook(folder, 8650, "default", SECRET);
      assert.equal(outcome.state, "by_hand", config);
      assert.equal(readFileSync(join(folder, "config.yaml"), "utf8"), config, "untouched");
      assert.ok(outcome.state === "by_hand");
      assert.equal(
        outcome.lines,
        [
          "hooks:",
          "  outbound:",
          "    - name: chips",
          "      url: http://127.0.0.1:8650/chips-hermes/default",
          "      events: [post_api_request]",
          `      secret_env: ${SECRET_ENV}`,
          "      timeout: 5",
        ].join("\n"),
      );
    }
  });

  it("says to start hermes gateway again once when it added the webhook while the gateway runs", () => {
    const root = mkdtempSync(join(tmpdir(), "chips-hermes-root-"));
    writeFileSync(join(root, "config.yaml"), CONFIG);
    mkdirSync(join(root, "profiles", "alice"), { recursive: true });
    writeFileSync(join(root, "profiles", "alice", "config.yaml"), "hooks: {}\n");
    const folder = mkdtempSync(join(tmpdir(), "chips-hermes-config-"));
    writeFileSync(
      join(folder, "config.json"),
      JSON.stringify({
        hookPort: 8650,
        agents: [
          { name: "Hermes", profile: "default", keyEnv: "K" },
          { name: "Alice", profile: "alice", keyEnv: "K" },
          { name: "Bob", profile: "bob", keyEnv: "K" },
        ],
      }),
    );
    const config = readConfig(join(folder, "config.json"), { K: "k" });
    assert.equal(config.hookPort, 8650);
    const ready = readyHooks(config, { root, port: 8650, secret: SECRET, gatewayUp: true });
    assert.equal(ready.restart, true);
    assert.equal(ready.lines.length, 4);
    assert.match(ready.lines[0] ?? "", /^Added Chips's webhook to .*config\.yaml, so Hermes tells Chips how full each agent's context is\.$/);
    assert.match(ready.lines[1] ?? "", /alice\/config\.yaml was left as it is: its hooks: is written on one line\. For Chips to show how full each agent's context is, add these lines to it, then start hermes gateway again:\nhooks:\n {2}outbound:\n/);
    assert.match(ready.lines[2] ?? "", /^Hermes has no bob profile at .*profiles\/bob, so no webhook was added for it\.$/);
    assert.equal(ready.lines[3], RESTART);
    assert.equal(checkedWords({ ...config, agents: config.agents.slice(0, 1) }, true), `Its API server answers on port 8642. ${RESTART}`);
    // Next start: there already, and nothing to say.
    const again = readyHooks({ ...config, agents: config.agents.slice(0, 1) }, { root, port: 8650, secret: SECRET, gatewayUp: true });
    assert.deepEqual(again, { lines: [], restart: false });
    // Added while the gateway is down, it takes it when it starts: no restart to ask for.
    const down = mkdtempSync(join(tmpdir(), "chips-hermes-root-"));
    assert.equal(readyHooks({ ...config, agents: config.agents.slice(0, 1) }, { root: down, port: 8650, secret: SECRET, gatewayUp: false }).restart, false);
  });
});
