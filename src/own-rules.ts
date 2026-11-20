/**
 * What Hermes runs on its own, as Chips's Permissions page reads it (Chips ADR 0299), with the modes
 * a person may pick for it from Chips (Chips ADR 0300, its addendum of 19 November 2026 "Hermes,
 * OpenClaw and OpenCode get the Mode picker too"): Manual, Smart (where it starts) and Off, and the
 * one its profiles run in, read back from their configs.
 *
 * It says no mode of its own (`mode`): the page would add "so anything not on this list asks",
 * and Hermes asks only before commands it counts as risky, in any mode. Nor anything it runs: the
 * profiles' `command_allowlist` names Hermes's own kinds of risky command ("recursive delete"),
 * not what a command starts with, which is what the page's entries say.
 */

import { homedir } from "node:os";
import { join, sep } from "node:path";
import type { OwnRules } from "@chipschat/harness";
import { BASE_MODE, HERMES_MODES } from "./modes.js";

/** Who keeps which mode, on the page under what it read. */
export const OWN_NOTE =
  "Chips puts the mode picked here in the profiles it made for its agents. The Main agent runs on your own Hermes's default profile, so it keeps your Hermes's mode.";

/** How many profiles' configs are named one by one; past that, where each is. */
const NAMED_MOST = 3;

/** A path as a person reads it: their home as `~`. */
function shown(path: string, home: string): string {
  return path === home || path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The copy: read from each profile Chips made, a few by name, else where each is; the note; and
 * the modes, with the one they run in where any was read.
 */
export function hermesOwnRules(options: {
  /** Hermes's root, where `profiles/` is. */
  readonly root: string;
  /** The profiles Chips made for its agents, whose configs say the mode. */
  readonly profiles: readonly string[];
  /** The mode those profiles run in, read back; nothing before there are any. */
  readonly running: string | undefined;
  readonly home?: string | undefined;
}): OwnRules {
  const home = options.home ?? homedir();
  const configOf = (profile: string) => shown(join(options.root, "profiles", profile, "config.yaml"), home);
  const named = options.profiles.length > 0 && options.profiles.length <= NAMED_MOST;
  return {
    read_from: named ? options.profiles.map(configOf) : [configOf("<agent's profile>")],
    note: OWN_NOTE,
    modes: {
      base: BASE_MODE,
      ...(options.running === undefined ? {} : { running: options.running }),
      offers: [...HERMES_MODES],
    },
    runs: [],
  };
}
