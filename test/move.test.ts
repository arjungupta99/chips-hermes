/**
 * An install from before 1.0.17 brought across to ~/Chips (Chips ADR 0283): the config, sessions and
 * state, the agents' folders and the folder paths the sessions saved, nothing copied, a clash left
 * where it was, and nothing done twice.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { moveOld } from "../src/move.ts";
import { configPathOf, configTargetOf } from "../src/places.ts";
import { readConfig } from "../src/setup.ts";

// Every default path is under a home of the test's own, never the person's.
let home = "";
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
};
const at = (path: string) => join(home, path);
const json = (path: string) => JSON.parse(readFileSync(at(path), "utf8")) as Record<string, unknown>;

let said: string[] = [];
const log = (line: string) => said.push(line);
const move = (word?: string) => moveOld(configTargetOf(word, home), log, home);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "chips-hermes-move-")));
  process.env["HOME"] = home;
  said = [];
});

/** The bridge as it was kept before 1.0.17. */
function oldInstall(config: Record<string, unknown> = { name: "Hermes", agents: [{ name: "Hermes", profile: "default" }] }): void {
  put(".chips-hermes/config.json", JSON.stringify(config));
  put(".chips-hermes/chips-state.json", "{}");
  put(".chips-hermes/sessions.json", JSON.stringify({ sessions: { "agt_1|spc": "s1" }, folders: { agt_1: at("chips-hermes/agents/fern"), agt_2: "/elsewhere/sage" } }));
  put("chips-hermes/agents/fern/notes.txt", "Fern's\n");
}

describe("where things are kept", () => {
  it("reads a config named in the old place as the same one in the new", () => {
    assert.equal(configPathOf(undefined, home), at("Chips/.bridges/hermes/config.json"));
    assert.equal(configPathOf("~/.chips-hermes/config.json", home), at("Chips/.bridges/hermes/config.json"));
    assert.equal(configPathOf("/elsewhere/hermes.json", home), "/elsewhere/hermes.json");
  });

  it("uses the old place while its file is there and the new one isn't", () => {
    put(".chips-hermes/config.json", "{}");
    assert.equal(configPathOf(undefined, home), at(".chips-hermes/config.json"));
  });

  it("gives the agents their folders in ~/Chips/Agents/hermes", () => {
    put("Chips/.bridges/hermes/config.json", JSON.stringify({ agents: [{ name: "Hermes", profile: "default" }] }));
    assert.equal(readConfig(at("Chips/.bridges/hermes/config.json"), { API_SERVER_KEY: "k" }).folders, at("Chips/Agents/hermes"));
  });
});

describe("an install from before 1.0.17", () => {
  it("moves the settings, the agents' folders and the paths the sessions saved", () => {
    oldInstall();
    put(".chips-hermes/start-hermes-gateway.py", "# a person's own\n");
    put("chips-hermes/hermes-gateway.py", "# a person's own\n");
    move();

    assert.deepEqual((json("Chips/.bridges/hermes/config.json")["agents"] as unknown[]).length, 1);
    assert.ok(existsSync(at("Chips/.bridges/hermes/chips-state.json")));
    assert.ok(existsSync(at("Chips/.bridges/hermes/start-hermes-gateway.py")));
    assert.deepEqual(json("Chips/.bridges/hermes/sessions.json")["folders"], { agt_1: at("Chips/Agents/hermes/fern"), agt_2: "/elsewhere/sage" });
    assert.equal(readFileSync(at("Chips/Agents/hermes/fern/notes.txt"), "utf8"), "Fern's\n");
    assert.ok(!existsSync(at(".chips-hermes")), "the old settings folder goes");
    assert.ok(!existsSync(at("chips-hermes/agents")), "and the old agents' folder");
    assert.ok(existsSync(at("chips-hermes/hermes-gateway.py")), "a file the bridge didn't make stays where it is");
    assert.equal(readConfig(configPathOf(undefined, home), { API_SERVER_KEY: "k" }).folders, at("Chips/Agents/hermes"));
  });

  it("takes the old folder away once nothing is left in it", () => {
    oldInstall();
    move();
    assert.ok(!existsSync(at("chips-hermes")));
  });

  it("names the new place where the config named the old one", () => {
    oldInstall({ agents: [{ name: "Hermes", profile: "default", folder: "~/chips-hermes/agents/fern" }], folders: "~/chips-hermes/agents" });
    move();
    const config = json("Chips/.bridges/hermes/config.json");
    assert.equal(config["folders"], "~/Chips/Agents/hermes");
    assert.equal((config["agents"] as Record<string, unknown>[])[0]?.["folder"], "~/Chips/Agents/hermes/fern");
  });

  it("does nothing the second time, or on a new install", () => {
    oldInstall();
    move();
    said = [];
    move();
    assert.deepEqual(said, []);

    home = realpathSync(mkdtempSync(join(tmpdir(), "chips-hermes-move-")));
    move();
    assert.deepEqual(said, []);
  });

  it("moves into what is at the new place already, and leaves a clash where it was", () => {
    oldInstall();
    put("Chips/Agents/hermes/fern/notes.txt", "a newer one\n");
    put("Chips/Agents/hermes/moss/notes.txt", "Moss's\n");
    move();
    assert.equal(readFileSync(at("Chips/Agents/hermes/fern/notes.txt"), "utf8"), "a newer one\n");
    assert.equal(readFileSync(at("chips-hermes/agents/fern/notes.txt"), "utf8"), "Fern's\n");
    assert.ok(said.some((line) => line.includes("~/chips-hermes/agents/fern/notes.txt was left where it is")));
  });
});
