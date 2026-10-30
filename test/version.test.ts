/** The version a bridge tells Chips is the one it was published as, not a number left in the code. */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { VERSION } from "../src/version.js";

it("is the package's own version", () => {
  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, own.version);
  assert.notEqual(VERSION, "1.0.0");
});
