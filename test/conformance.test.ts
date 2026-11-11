/**
 * The golden scenario of Chips's conformance kit, played against the bridge and a scripted Hermes
 * that asks before it acts: what `chips conformance custom --capabilities
 * agents,new_spaces,new_agents,context_files,models,context_windows,restarts` checks of it live.
 * Hermes's own files are in a temporary home, where each new agent is a profile of its own, and
 * the scripted Hermes lists its models and says how full each session is through the webhook. A
 * restart here restarts nothing: what Restart does to Hermes's gateway is `gateway.test.ts`'s, on
 * a machine of its own.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { formatReport, runConformance } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { Bridge, settingsFor } from "../src/bridge.ts";
import { restarter } from "../src/gateway.ts";
import { fakeProfiles, startFakeHermes } from "./fake-hermes.ts";

it("passes the golden scenario", async () => {
  const hermes = await startFakeHermes({ askFirst: true });
  const root = mkdtempSync(join(tmpdir(), "chips-hermes-root-"));
  writeFileSync(join(root, "SOUL.md"), "You are Hermes.\n");
  mkdirSync(join(root, "memories"));
  writeFileSync(join(root, "memories", "MEMORY.md"), "Arjun likes tea");
  let client: Chips | undefined;
  let bridge: Bridge | undefined;
  try {
    const report = await runConformance({
      beatTimeoutMs: 3000,
      subject: {
        name: "chips-hermes",
        capabilities: ["agents", "new_spaces", "new_agents", "context_files", "models", "context_windows", "restarts"],
        start: async (address) => {
          const onRestart = restarter({
            restart: async () => undefined,
            hold: (held) => bridge?.hold(held),
            say: async (trouble) => bridge?.restarted(trouble),
            log: () => undefined,
          });
          client = await connect({ url: address.url, token: address.token, settings: settingsFor(() => bridge), onRestart });
          bridge = new Bridge({
            chips: client,
            agents: [{ name: "Hermes", address: { url: hermes.url, key: hermes.key } }],
            home: address.spaceId,
            state: { sessions: {} },
            saveState: () => undefined,
            hermesRoot: root,
            env: {},
            fills: { port: 0, secret: "conformance" },
            fillsEveryMs: 0,
            // Each new agent and each new space's agent a profile of its own (Chips ADR 0241).
            profiles: fakeProfiles(root),
          });
          await bridge.start();
          const started = bridge;
          hermes.hook = { url: (profile) => started.hookUrl(profile), secret: "conformance" };
          hermes.root = root;
        },
        stop: async () => {
          bridge?.stop();
          client?.close();
        },
      },
    });
    assert.ok(report.passed, formatReport(report).join("\n"));
    // Each run says it can pause (Chips ADR 0293), which this kit, from before, warns a server drops:
    // as one from before does, offering Stop alone. Any other warning stands.
    const pausable = (message: string) => message.startsWith("run.status carried `pausable`");
    assert.deepEqual(
      report.findings.filter((finding) => finding.severity !== "note" && !pausable(finding.message)),
      [],
      formatReport(report).join("\n"),
    );
    assert.deepEqual(
      report.levels.map((level) => [level.label, level.has]),
      [
        ["Talks", 1],
        ["Supervised", 1],
        ["Lives in Chips", 4],
        ["Managed from Chips", 3],
      ],
    );
    const outcomes = Object.fromEntries(
      (report.levels[2]?.capabilities ?? []).map((each) => [each.capability, each.outcome]),
    );
    assert.equal(outcomes["new_spaces"], "passed");
    const managed = Object.fromEntries(
      (report.levels[3]?.capabilities ?? []).map((each) => [each.capability, each.outcome]),
    );
    assert.equal(managed["models"], "passed");
  } finally {
    await hermes.close();
  }
});
