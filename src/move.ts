/**
 * An install from before 1.0.17 brought across to `~/Chips` (Chips ADR 0283), once, when the bridge
 * starts: its config, sessions and state from `~/.chips-hermes`, its agents' folders from
 * `~/chips-hermes/agents`, and the folder paths it saved. Hermes needs nothing more: each run's
 * instructions name the agent's folder, and its profiles name none.
 *
 * Nothing is copied and deleted: a folder is renamed, or, where something is at the new place already,
 * what isn't there yet is moved in and a clash is left where it was, said in the log. A rename that
 * fails leaves the old place in use (`places.ts` reads a path where it is). Each step looks at what is
 * on disk, so a start that stops halfway finishes on the next, and a start with nothing to move does
 * nothing.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fromHome, inside, nowAt, type Places, placesOf } from "./places.js";

type Log = (line: string) => void;

const there = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isFolder = (path: string) => lstatSync(path).isDirectory();

/** `~` for the home in a path, as a person reads it. */
const shown = (path: string, home: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * `from` moved to `to`: renamed where nothing is at `to`; else, both folders, each entry `to` hasn't
 * got moved in, and `from` removed once it is empty. Anything else is left where it is and said.
 */
export function merge(from: string, to: string, log: Log, home: string = homedir(), quiet = false): void {
  if (!there(from)) return;
  try {
    if (!there(to)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      if (!quiet) log(`moved ${shown(from, home)} to ${shown(to, home)}`);
      return;
    }
    if (!isFolder(from) || !isFolder(to)) {
      log(`${shown(from, home)} was left where it is: ${shown(to, home)} is there already`);
      return;
    }
    for (const entry of readdirSync(from)) merge(join(from, entry), join(to, entry), log, home, true);
    if (readdirSync(from).length === 0) rmdirSync(from);
    if (!quiet) log(`moved what was in ${shown(from, home)} into ${shown(to, home)}`);
  } catch (error) {
    log(`${shown(from, home)} couldn't be moved to ${shown(to, home)}, so it is used where it is: ${(error as Error).message}`);
  }
}

/** A folder removed when nothing is left in it. */
function removeIfEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmdirSync(path);
  } catch {
    // Not there, or something of the person's still is.
  }
}

/** The folder a path names before the move and after it, where it is one of the agents' places. */
function pairOf(path: string, places: Places): { readonly old: string; readonly now: string } | undefined {
  const old = inside(places.oldAgents, path);
  if (old !== undefined) return { old: path, now: join(places.agents, old) };
  const now = inside(places.agents, path);
  return now === undefined ? undefined : { old: join(places.oldAgents, now), now: path };
}

/** A JSON file written whole, readable by the person alone, so a stop halfway leaves the old one. */
function writeJson(path: string, value: unknown): void {
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const read = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof read === "object" && read !== null ? (read as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** A folder a config names, as written in it after the move: `~/Chips/Agents/hermes`. */
function movedWords(said: unknown, places: Places, home: string): string | undefined {
  if (typeof said !== "string" || said === "") return undefined;
  const path = resolve(fromHome(said, home));
  const moved = nowAt(path, places.oldAgents, places.agents);
  return moved === path ? undefined : `~/${moved.slice(home.length + 1)}`;
}

/** The bridge whose config goes at `configPath` (`configTargetOf`) brought across from before 1.0.17. */
export function moveOld(configPath: string, log: Log, home: string = homedir()): void {
  const places = placesOf(home);
  const settings = dirname(configPath);

  // The config, the sessions and the SDK's state, where the config is in the settings folder.
  const under = inside(places.settings, settings);
  if (under !== undefined) {
    mkdirSync(dirname(dirname(places.settings)), { recursive: true });
    mkdirSync(dirname(places.settings), { recursive: true, mode: 0o700 });
    merge(join(places.oldSettings, under), settings, log, home);
  }

  // The agents' folders: the config's, else the default, and any it names for one agent or all.
  const config = readJson(configPath);
  const agents = Array.isArray(config?.["agents"]) ? (config["agents"] as Record<string, unknown>[]) : [];
  const roots = [config?.["folders"] ?? places.agents, config?.["folder"], ...agents.map((agent) => agent["folder"])]
    .filter((root): root is string => typeof root === "string" && root !== "")
    .map((root) => resolve(fromHome(root, home)));
  const pairs = roots.map((root) => pairOf(root, places)).filter((pair) => pair !== undefined);
  for (const { old, now } of pairs) merge(old, now, log, home);

  // The config's own words, where it named a folder in the old place.
  if (config !== undefined) {
    let changed = false;
    const folders = movedWords(config["folders"], places, home);
    if (folders !== undefined) {
      config["folders"] = folders;
      changed = true;
    }
    const folder = movedWords(config["folder"], places, home);
    if (folder !== undefined) {
      config["folder"] = folder;
      changed = true;
    }
    for (const agent of agents) {
      const folder = movedWords(agent["folder"], places, home);
      if (folder === undefined) continue;
      agent["folder"] = folder;
      changed = true;
    }
    if (changed) writeJson(configPath, config);
  }

  // The folder each agent works in, as the sessions saved it.
  const statePath = join(settings, "sessions.json");
  const state = readJson(statePath);
  const saved = state?.["folders"];
  if (state !== undefined && typeof saved === "object" && saved !== null) {
    const folders = saved as Record<string, unknown>;
    let changed = false;
    for (const [agentId, folder] of Object.entries(folders)) {
      if (typeof folder !== "string") continue;
      const moved = nowAt(folder, places.oldAgents, places.agents);
      if (moved === folder) continue;
      folders[agentId] = moved;
      changed = true;
    }
    if (changed) writeJson(statePath, state);
  }

  removeIfEmpty(places.oldSettings);
  removeIfEmpty(places.oldAgents);
  removeIfEmpty(dirname(places.oldAgents));
}
