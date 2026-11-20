/**
 * The mode a person picks in Chips, written into a Hermes profile's `config.yaml` and put back
 * (Chips ADR 0300).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { type KeptMode, modeIn, modeOf, pickInto, putBack } from "../src/modes.ts";

/** A profile's config as Hermes clones one: comments, a list, and no `approvals:`. */
const PLAIN = [
  "# Alice's profile",
  "model:",
  "  default: heron-2   # picked by hand",
  "  provider: fake",
  "",
  "command_allowlist:",
  "- recursive delete",
  "",
].join("\n");

/** Written, then put back. */
function roundTrip(text: string, mode: string): { written: string; kept: KeptMode; back: string } {
  const planned = pickInto(text, mode, undefined);
  assert.ok("kept" in planned, JSON.stringify(planned));
  const back = putBack(planned.text, planned.kept);
  assert.ok("text" in back, JSON.stringify(back));
  return { written: planned.text, kept: planned.kept, back: back.text };
}

describe("Hermes's mode, as its config says it", () => {
  it("reads it as Hermes does: its default with none, a bare no as off, anything else it doesn't know as manual", () => {
    assert.equal(modeOf(undefined), "smart");
    assert.equal(modeOf("manual"), "manual");
    assert.equal(modeOf('"off"'), "off");
    assert.equal(modeOf("'Smart'"), "smart");
    assert.equal(modeOf("off"), "off", "YAML reads a bare off as false");
    assert.equal(modeOf("false"), "off");
    assert.equal(modeOf("yes"), "manual");
    assert.equal(modeOf('"false"'), "manual", "in quotes it is a word Hermes doesn't know");
    assert.equal(modeOf("auto"), "manual");
    assert.equal(modeOf(""), "manual");
  });

  it("finds it under approvals:, in a block or on one line", () => {
    assert.equal(modeIn(PLAIN), "smart");
    assert.equal(modeIn("approvals:\n  timeout: 300\n"), "smart");
    assert.equal(modeIn("approvals:\n  timeout: 300\n  mode: manual  # mine\n"), "manual");
    assert.equal(modeIn("approvals: {timeout: 300, mode: off}\n"), "off");
    assert.equal(modeIn("approvals:\n  nested:\n    mode: off\n"), "smart", "only its own key");
  });
});

describe("a pick written into a profile's config, and put back (Chips ADR 0300)", () => {
  it("adds approvals: where there is none, and puts back its absence word for word", () => {
    const { written, kept, back } = roundTrip(PLAIN, "off");
    assert.equal(written, `${PLAIN}approvals:\n  mode: "off"\n`, "off in quotes, as Hermes writes it");
    assert.equal(modeIn(written), "off");
    assert.deepEqual(kept, { was: null, section: true, wrote: "off", pick: "off" });
    assert.equal(back, PLAIN);
  });

  it("adds mode: under an approvals: with none, at its keys' indent, and takes only that line out again", () => {
    const text = "approvals:\n    timeout: 300   # five minutes\n    cron_mode: deny\nother: 1\n";
    const { written, kept, back } = roundTrip(text, "manual");
    assert.equal(written, "approvals:\n    mode: manual\n    timeout: 300   # five minutes\n    cron_mode: deny\nother: 1\n");
    assert.deepEqual(kept, { was: null, wrote: "manual", pick: "manual" });
    assert.equal(back, text);
  });

  it("puts back the line that was there, its comment and quotes included", () => {
    const text = "approvals:\n  mode: 'manual'  # I want to see each one\n  timeout: 60\n";
    const { written, back } = roundTrip(text, "off");
    assert.equal(written, 'approvals:\n  mode: "off"\n  timeout: 60\n');
    assert.equal(back, text);
  });

  it("keeps the lines a person added meanwhile, and approvals: once it holds them", () => {
    const planned = pickInto(PLAIN, "off", undefined);
    assert.ok("kept" in planned);
    const edited = planned.text
      .replace("- recursive delete\n", "- recursive delete\n- git force push\n")
      .replace('  mode: "off"\n', '  mode: "off"\n  timeout: 60\n');
    const back = putBack(edited, planned.kept);
    assert.ok("text" in back);
    assert.equal(back.text, PLAIN.replace("- recursive delete\n", "- recursive delete\n- git force push\n") + "approvals:\n  timeout: 60\n");
  });

  it("takes out the approvals: it added once it holds nothing else, though a comment follows at the left edge", () => {
    const planned = pickInto(PLAIN, "manual", undefined);
    assert.ok("kept" in planned);
    const back = putBack(`${planned.text}# a note of mine\n`, planned.kept);
    assert.ok("text" in back);
    assert.equal(back.text, `${PLAIN}# a note of mine\n`);
    const held = putBack(planned.text.replace("  mode: manual\n", "  mode: manual\n  # mine, for later\n"), planned.kept);
    assert.ok("text" in held);
    assert.equal(held.text, `${PLAIN}approvals:\n  # mine, for later\n`);
  });

  it("counts the line as its own when Hermes wrote the same mode again its way", () => {
    const planned = pickInto(PLAIN, "off", undefined);
    assert.ok("kept" in planned);
    const back = putBack(planned.text.replace('mode: "off"', "mode: 'off'"), planned.kept);
    assert.ok("text" in back);
    assert.equal(back.text, PLAIN);
  });

  it("leaves a mode a person wrote while the pick held, until a new pick from Chips, which puts theirs back at its end", () => {
    const planned = pickInto(PLAIN, "off", undefined, "off|10:41");
    assert.ok("kept" in planned);
    const theirs = planned.text.replace('mode: "off"', "mode: manual");
    assert.deepEqual(putBack(theirs, planned.kept), { left: "someone put it in manual since" });
    assert.deepEqual(pickInto(theirs, "off", planned.kept, "off|10:41"), { theirs: "someone put it in manual since" });
    // Theirs even where they put it back in the mode Chips wrote.
    const same = { ...planned.kept, theirs: true as const };
    assert.deepEqual(pickInto(planned.text, "off", same, "off|10:41"), { theirs: 'someone put it in off since' });
    assert.deepEqual(putBack(planned.text, same), { left: "someone put it in off since" });
    const again = pickInto(theirs, "manual", same, "manual|12:00");
    assert.ok("kept" in again);
    assert.deepEqual(again.kept, { was: "  mode: manual", wrote: "manual", pick: "manual|12:00" });
    const back = putBack(again.text, again.kept);
    assert.ok("text" in back);
    assert.equal(back.text, theirs);
  });

  it("keeps what was there first when the pick changes", () => {
    const text = "approvals:\n  mode: manual\n";
    const first = pickInto(text, "off", undefined);
    assert.ok("kept" in first);
    const second = pickInto(first.text, "manual", first.kept);
    assert.ok("kept" in second);
    assert.deepEqual(second.kept, { was: "  mode: manual", wrote: "manual", pick: "manual" });
    const back = putBack(second.text, second.kept);
    assert.ok("text" in back);
    assert.equal(back.text, text);
  });

  it("writes nothing into a config it can't edit as a line", () => {
    assert.deepEqual(pickInto("approvals: {timeout: 300}\n", "off", undefined), { why: "its approvals: is written on one line" });
    assert.deepEqual(pickInto("- one\n- two\n", "off", undefined), { why: "its top level isn't laid out as this bridge expects" });
    assert.deepEqual(pickInto("approvals:\n  - mode: off\n", "off", undefined), {
      why: "its approvals: isn't laid out as this bridge expects",
    });
    assert.deepEqual(pickInto("approvals:\n- mode: off\n", "off", undefined), {
      why: "its approvals: isn't laid out as this bridge expects",
    });
    assert.deepEqual(pickInto("model: heron\n- stray\n", "off", undefined), {
      why: "its top level isn't laid out as this bridge expects",
    });
  });
});
