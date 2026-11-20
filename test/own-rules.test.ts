/**
 * What Hermes runs on its own, as Chips's Permissions page reads it (Chips ADR 0299), with the modes
 * a person may pick for it (Chips ADR 0300).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ownRules } from "@chipschat/protocol";
import { HERMES_MODES } from "../src/modes.ts";
import { hermesOwnRules, OWN_NOTE } from "../src/own-rules.ts";

describe("what Hermes runs on its own, as the page reads it (Chips ADRs 0299, 0300)", () => {
  it("offers Manual, Smart and Off in Hermes's words, Smart where it starts, Off never asking", () => {
    assert.deepEqual(
      HERMES_MODES.map((mode) => [mode.id, mode.name, mode.words, mode.everything ?? false]),
      [
        ["manual", "Manual", "Asks before every command Hermes counts as risky.", false],
        ["smart", "Smart", "A second model checks each risky command and asks only when it can't clear it.", false],
        ["off", "Off", "Never asks. Risky commands just run; its hard blocks and your deny list still hold.", true],
      ],
    );
  });

  it("names the profiles' configs it read, says who keeps which mode, and leaves out a mode of its own", () => {
    const copy = hermesOwnRules({ root: "/Users/ada/.hermes", profiles: ["nova", "vega"], running: "off", home: "/Users/ada" });
    assert.deepEqual(copy.read_from, ["~/.hermes/profiles/nova/config.yaml", "~/.hermes/profiles/vega/config.yaml"]);
    assert.equal(copy.note, OWN_NOTE);
    assert.equal(copy.mode, undefined, "the page would say anything not listed asks");
    assert.equal(copy.everything, undefined, "the Main agent still asks");
    assert.deepEqual(copy.runs, []);
    assert.deepEqual(copy.modes, { base: "smart", running: "off", offers: HERMES_MODES });
    assert.ok(ownRules.safeParse(copy).success, JSON.stringify(ownRules.safeParse(copy).error));
  });

  it("says where each profile's config is, before there is one and past a few, and no mode they run in before there is one", () => {
    const none = hermesOwnRules({ root: "/srv/hermes", profiles: [], running: undefined, home: "/Users/ada" });
    assert.deepEqual(none.read_from, ["/srv/hermes/profiles/<agent's profile>/config.yaml"]);
    assert.deepEqual(none.modes, { base: "smart", offers: HERMES_MODES });
    assert.ok(ownRules.safeParse(none).success);
    const many = hermesOwnRules({ root: "/srv/hermes", profiles: ["a", "b", "c", "d"], running: "smart", home: "/Users/ada" });
    assert.deepEqual(many.read_from, ["/srv/hermes/profiles/<agent's profile>/config.yaml"]);
  });
});
