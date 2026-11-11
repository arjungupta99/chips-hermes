/**
 * `npm run keep`: the bridge kept running (Chips's setup audit HS-15). Run as `npm start` is, with
 * a link or without, it joins, then writes a launch agent (a Mac) or a systemd user unit (Linux)
 * that runs `npm start`'s bridge from login and again whenever it stops, and this copy ends:
 * closing the terminal, or restarting the machine, no longer takes the harness offline in Chips.
 * `npm run keep -- --stop` stops it and removes the file.
 *
 * `chips connect <id> '<link>'` runs the published bundle with `--keep` (Chips ADR 0218), and hands
 * over the Node to keep it on (`CHIPS_NODE`, a path an upgrade of Chips keeps) and the line that
 * stops it (`CHIPS_STOP_COMMAND`, `chips disconnect <id>`).
 */

import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { keepEnvironment, keepRunning, keptNode, stopKeeping } from "@chipschat/harness";
import { configTargetOf } from "./places.js";

const flags = process.argv.slice(2);

/** The words that aren't flags: the config's path, where one is given. */
export const words = flags.filter((word) => !word.startsWith("--"));

/**
 * Whether this run hands over to a copy kept running (`--keep`). It moves nothing of an install from
 * before (Chips ADR 0283): the kept copy does, once the one it replaces has stopped, so nothing that
 * one writes as it stops is left in the old place.
 */
export const handsOver = flags.includes("--keep");

/**
 * A word as a whole path, for the kept copy, which runs from elsewhere: a config named in the old
 * place is kept with its path in the new one, where the kept copy moves it (Chips ADR 0283).
 */
const whole = (word: string) => configTargetOf(word);

/** This repository, or the installed package, where the kept bridge runs from. */
const here = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/**
 * Its bundle, as the published package runs (`dist/main.js`), only for a file named `.js`; else its
 * source, run by tsx, as in a checkout.
 */
const self = fileURLToPath(import.meta.url);
const run = self.endsWith(".js") ? [self] : ["--import", "tsx", "src/main.ts"];

/** What a person types to run it again: `npm run keep --` in a checkout, else the command itself. */
const again = process.env["npm_lifecycle_event"] === "keep" ? "npm run keep --" : basename(process.argv[1] ?? "chips");

/** What stops it: what `chips connect` says it is, else this command again with `--stop`. */
const stopLine = process.env["CHIPS_STOP_COMMAND"] || [again, ...words, "--stop"].join(" ");

const end = (line: string, code: number): never => {
  (code === 0 ? process.stdout : process.stderr).write(`${line}\n`);
  process.exit(code);
};

/** `npm run keep -- --stop`: the kept bridge stopped and its file removed, and nothing more. */
export function stopIfAsked(label: string): void {
  if (!flags.includes("--stop")) return;
  const stopped = stopKeeping(label);
  if (stopped.state === "stopped") end(`Stopped ${label}, and removed ${stopped.path}.`, 0);
  if (stopped.state === "theirs") end(`${stopped.path} wasn't written by this bridge: it was left as it is.`, 1);
  end(`Nothing called ${label} was kept running here.`, 0);
}

/**
 * Once joined, with `--keep`: the bridge kept running from `url`, carrying the environment
 * variables `names` where they are set, and this copy ends, `before` it does what it must hand
 * over. Where nothing can keep it, or `CHIPS_KEEP=off` (a test of a card's line), it goes on here.
 */
export function keepIfAsked(
  label: string,
  url: string,
  names: readonly string[],
  log: (line: string) => void,
  before: () => void = () => undefined,
): void {
  if (!flags.includes("--keep")) return;
  const node = keptNode();
  const kept = keepRunning({
    label,
    command: [node, ...run, ...words.map(whole)],
    folder: here,
    environment: keepEnvironment(url, process.env, names, node),
  });
  if (kept.state === "kept") {
    before();
    end(
      `Kept running as ${label}: it starts at login, and again whenever it stops. What it says goes to ${kept.logFile}. \`${stopLine}\` stops it.`,
      0,
    );
  }
  if (kept.state === "theirs") {
    end(
      `${kept.path} is there already and wasn't written by this bridge: it was left as it is, and nothing more was started, so the harness doesn't answer twice.`,
      1,
    );
  }
  // From the SDK's 1.0.5 on, a service manager that refused says why itself, and that it runs here.
  if (kept.state !== "off" && kept.state !== "unsupported") return;
  log(
    kept.state === "off"
      ? "Keeping it running is off here (CHIPS_KEEP=off): it runs here, while this terminal is open."
      : "Nothing on this machine can keep it running (launchd, systemd): it runs here, while this terminal is open.",
  );
}
