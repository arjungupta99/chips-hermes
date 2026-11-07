/**
 * Where the bridge keeps things (Chips ADR 0283): everything under `~/Chips`, beside the rooms'
 * folders in `~/Chips/Projects`. Its config and memory are in `~/Chips/.bridges/hermes`, and each
 * agent's folder is in `~/Chips/Agents/hermes/<agent>`.
 *
 * Until 1.0.17 they were `~/.chips-hermes` and `~/chips-hermes/agents`. A path in either is read as
 * the same path in the new place, so a login item kept before still names the right file; `move.ts`
 * brings what was there across, once.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface Places {
  /** `~/Chips/.bridges/hermes`: the config, the sessions, the SDK's state. */
  readonly settings: string;
  /** `~/Chips/Agents/hermes`: the agents' folders. */
  readonly agents: string;
  /** `~/.chips-hermes`, where the settings were before 1.0.17. */
  readonly oldSettings: string;
  /** `~/chips-hermes/agents`, where the agents' folders were before 1.0.17. */
  readonly oldAgents: string;
}

export function placesOf(home: string = homedir()): Places {
  return {
    settings: join(home, "Chips", ".bridges", "hermes"),
    agents: join(home, "Chips", "Agents", "hermes"),
    oldSettings: join(home, ".chips-hermes"),
    oldAgents: join(home, "chips-hermes", "agents"),
  };
}

/** `~/config.json` as a whole path. */
export const fromHome = (path: string, home: string = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

/** Where `path` is in `root`, `fern`, or `""` for `root` itself; nothing when it isn't in it. */
export function inside(root: string, path: string): string | undefined {
  const under = relative(root, path);
  return under === ".." || under.startsWith(`..${sep}`) || isAbsolute(under) ? undefined : under;
}

/**
 * A path in `before` as it is now: the same in `after`, unless what was at `path` is still there and
 * nothing is at the new place yet (a move not made, or one that failed), when it is used where it
 * is. Any other path is itself.
 */
export function nowAt(path: string, before: string, after: string): string {
  const under = inside(before, path);
  if (under === undefined) return path;
  const moved = join(after, under);
  return existsSync(path) && !existsSync(moved) ? path : moved;
}

const configOf = (word: string | undefined, places: Places, home: string) =>
  resolve(fromHome(word ?? join(places.settings, "config.json"), home));

/** The config, named by a word or the default, as a whole path in the new place: where it goes. */
export function configTargetOf(word: string | undefined, home: string = homedir()): string {
  const places = placesOf(home);
  const path = configOf(word, places, home);
  const under = inside(places.oldSettings, path);
  return under === undefined ? path : join(places.settings, under);
}

/**
 * The config, named by a word or the default, as a whole path in the place it is now: the new place,
 * unless its file is still in the old one and not yet in the new.
 */
export function configPathOf(word: string | undefined, home: string = homedir()): string {
  const places = placesOf(home);
  const target = configTargetOf(word, home);
  const under = inside(places.settings, target);
  const old = under === undefined ? undefined : join(places.oldSettings, under);
  return old !== undefined && existsSync(old) && !existsSync(target) ? old : target;
}

/** A folder a config names, as a whole path in the place it is now. */
export function folderPathOf(path: string, home: string = homedir()): string {
  const places = placesOf(home);
  const whole = resolve(fromHome(path, home));
  // A folder in the new place is still the old one while only the old one is there.
  const under = inside(places.agents, whole);
  const old = under === undefined ? undefined : join(places.oldAgents, under);
  if (old !== undefined && existsSync(old) && !existsSync(whole)) return old;
  return nowAt(whole, places.oldAgents, places.agents);
}
