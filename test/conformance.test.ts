/**
 * The golden scenario of Chips's conformance kit, played against the bridge and a scripted Hermes
 * that asks before it acts: what `chips conformance custom --capabilities agents,new_agents` checks of it live.
 */

import { strict as assert } from "node:assert";
import { it } from "node:test";
import { formatReport, runConformance } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { Bridge } from "../src/bridge.ts";
import { startFakeHermes } from "./fake-hermes.ts";

it("passes the golden scenario", async () => {
  const hermes = await startFakeHermes({ askFirst: true });
  let client: Chips | undefined;
  let bridge: Bridge | undefined;
  try {
    const report = await runConformance({
      beatTimeoutMs: 3000,
      subject: {
        name: "chips-hermes",
        capabilities: ["agents", "new_agents"],
        start: async (address) => {
          client = await connect({ url: address.url, token: address.token });
          bridge = new Bridge({
            chips: client,
            agents: [{ name: "Hermes", address: { url: hermes.url, key: hermes.key } }],
            home: address.spaceId,
            state: { sessions: {} },
            saveState: () => undefined,
          });
          await bridge.start();
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
        ["Managed from Chips", 0],
      ],
    );
  } finally {
    await hermes.close();
  }
});
