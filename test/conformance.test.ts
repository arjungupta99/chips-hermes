/**
 * The golden scenario of Chips's conformance kit, played against the bridge and a scripted Hermes
 * that asks before it acts: what `chips conformance custom --capabilities
 * agents,new_agents,context_files,context_windows` checks of it live. Hermes's own files are in a
 * temporary home, and the scripted Hermes says how full each session is through the webhook.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { formatReport, runConformance } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { Bridge, settingsFor } from "../src/bridge.ts";
import { startFakeHermes } from "./fake-hermes.ts";

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
        capabilities: ["agents", "new_agents", "context_files", "context_windows"],
        start: async (address) => {
          client = await connect({ url: address.url, token: address.token, settings: settingsFor(() => bridge) });
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
          });
          await bridge.start();
          const started = bridge;
          hermes.hook = { url: (profile) => started.hookUrl(profile), secret: "conformance" };
        },
        stop: async () => {
          bridge?.stop();
          client?.close();
        },
      },
    });
    assert.ok(report.passed, formatReport(report).join("\n"));
    assert.deepEqual(
      report.findings.filter((finding) => finding.severity !== "note"),
      [],
      formatReport(report).join("\n"),
    );
    assert.deepEqual(
      report.levels.map((level) => [level.label, level.has]),
      [
        ["Talks", 1],
        ["Supervised", 1],
        ["Lives in Chips", 2],
        ["Managed from Chips", 2],
      ],
    );
  } finally {
    await hermes.close();
  }
});
