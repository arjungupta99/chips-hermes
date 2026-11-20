/**
 * The mode a person picks in Chips for Hermes's sessions (Chips ADR 0300, its addendum "Hermes,
 * OpenClaw and OpenCode get the Mode picker too", decision 3). Hermes 0.22.0 has three of its own,
 * in `approvals.mode` (`hermes_cli/approval_mode.py`, `tools/approval_context.py`): `manual`,
 * `smart`, which it runs in when its config names none (`hermes_cli/config_defaults.py`), and
 * `off`. It is kept per profile, in that profile's `config.yaml`, and read again at every check,
 * so a change holds from the next command Hermes counts as risky, with no restart. Nothing in a run
 * or a session can set it.
 *
 * So the bridge writes it into the config of each profile Chips made for one of its agents
 * (`profiles.ts`), and puts back exactly what was there, its absence included, when the time is
 * up, when a person switches back, and when the bridge starts with no pick in force. What was there
 * is kept in the bridge's state before anything is written, so a bridge stopped in the middle of a
 * pick still puts it back. The Main agent runs on Hermes's default profile, which the person's own
 * Hermes reads too, and it is never written.
 *
 * Only the one line changes, as `hooks.ts` adds its lines: every other key and comment, and any
 * line a person adds meanwhile, stays as it is. Hermes's own `hermes config set approvals.mode`
 * writes the whole file again through its YAML round trip, which re-indents the file's lists and
 * keeps a backup of it for each write (tried on a scratch home, 19 November 2026), so it couldn't
 * put back what was there word for word. A mode a person writes into the file while a pick holds
 * is theirs: it is left as they wrote it and nothing is put back, unless a pick after it comes from
 * Chips, which goes in its place and puts theirs back at its end.
 */

import type { OwnMode } from "@chipschat/harness";

/** Hermes's modes, as `approvals.mode` names them. */
export type HermesMode = "manual" | "smart" | "off";

/** Where Hermes starts, and goes back to: its default when its config names none. */
export const BASE_MODE: HermesMode = "smart";

/** Hermes's modes on Chips's picker, in Hermes's order, each with its line on the page (Chips ADR 0300). */
export const HERMES_MODES: readonly OwnMode[] = [
  { id: "manual", name: "Manual", words: "Asks before every command Hermes counts as risky." },
  {
    id: "smart",
    name: "Smart",
    words: "A second model checks each risky command and asks only when it can't clear it.",
  },
  {
    id: "off",
    name: "Off",
    words: "Never asks. Risky commands just run; its hard blocks and your deny list still hold.",
    everything: true,
  },
];

const VALID: readonly string[] = ["manual", "smart", "off"];

/** A mode's name on the picker: `Off`. */
export function modeName(id: string): string {
  return HERMES_MODES.find((mode) => mode.id === id)?.name ?? id;
}

/** How long a pick holds, for the log: `until 2026-11-19T18:41:00.000Z`, or until a person changes it. */
export function untilWords(mode: { readonly until?: string | undefined }): string {
  return mode.until === undefined ? "until a person changes it" : `until ${mode.until}`;
}

/** Names in a line: `nova`, `nova and vega`, `nova, vega and orion`. */
export function listWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What the bridge keeps of a profile while a pick holds there, in its state. */
export interface KeptMode {
  /** The `mode:` line under `approvals:` before Chips wrote one, word for word; `null` for none. */
  readonly was: string | null;
  /** There was no `approvals:` either: Chips added it, and takes it out again once it holds nothing else. */
  readonly section?: true | undefined;
  /** The mode Chips wrote last, to tell it from one a person writes since. */
  readonly wrote: string;
  /** The pick it was written for, as `id|until`: a new one from Chips goes in place of a mode a person wrote. */
  readonly pick: string;
  /** A person wrote their own mode while that pick held: it stays theirs, and nothing is put back. */
  readonly theirs?: true | undefined;
}

/** A config's lines, each with its indent and its words without a comment (`""` for a comment or a blank). */
function linesOf(text: string): { readonly indent: number; readonly words: string }[] {
  return text.split("\n").map((line) => {
    const indent = line.length - line.trimStart().length;
    return { indent, words: line.trimStart().startsWith("#") ? "" : uncomment(line.trim()) };
  });
}

/** A line's words with a comment that isn't inside quotes taken off. */
function uncomment(text: string): string {
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (at === 0 || /\s/.test(text[at - 1] ?? ""))) {
      return text.slice(0, at).trimEnd();
    }
  }
  return text;
}

/** Where `approvals.mode` is in a config. */
interface Place {
  readonly lines: string[];
  /** The top-level `approvals:` line, where there is one. */
  readonly head: number | undefined;
  /** The indent of the keys under it. */
  readonly indent: number;
  /** The `mode:` line under it, where there is one. */
  readonly at: number | undefined;
  /** The lines under it, to the next top-level key. */
  readonly under: readonly number[];
}

const PLAIN = /^(?:"[^"]+"|'[^']+'|[A-Za-z_][\w.-]*)\s*:(?:\s|$)/;
/** A top-level key whose value is on the lines below it: a block, or a list at its own indent. */
const OPENS = /^(?:"[^"]+"|'[^']+'|[A-Za-z_][\w.-]*)\s*:$/;
const APPROVALS = /^["']?approvals["']?\s*:/;
const MODE = /^["']?mode["']?\s*:/;

/**
 * Whether a config's top level is plain `key:` lines, and the lists under them, which may start at
 * the key's own indent (`command_allowlist:` then `- recursive delete`): nothing else, such as a
 * flow `{…}`, a list of its own or a second document.
 */
function plainTop(read: readonly { readonly indent: number; readonly words: string }[]): boolean {
  let list = false;
  for (const line of read) {
    if (line.indent !== 0 || line.words === "") continue;
    if (line.words === "-" || line.words.startsWith("- ")) {
      if (!list) return false;
      continue;
    }
    if (!PLAIN.test(line.words)) return false;
    list = OPENS.test(line.words);
  }
  return true;
}

/**
 * `approvals.mode` found in a config's text, or why it can't be written there as a line: a top
 * level that isn't laid out as `plainTop` reads it, or an `approvals:` written on one line or as a
 * list.
 */
function locate(text: string): { readonly place: Place } | { readonly why: string } {
  const lines = text.split("\n");
  const read = linesOf(text);
  if (!plainTop(read)) return { why: "its top level isn't laid out as this bridge expects" };
  const head = read.findIndex((line) => line.indent === 0 && APPROVALS.test(line.words));
  if (head === -1) return { place: { lines, head: undefined, indent: 2, at: undefined, under: [] } };
  if ((read[head]?.words ?? "").replace(APPROVALS, "").trim() !== "") return { why: "its approvals: is written on one line" };
  const under: number[] = [];
  for (let at = head + 1; at < read.length; at += 1) {
    const line = read[at];
    if (line === undefined) break;
    if (line.words !== "" && line.indent === 0) {
      if (line.words.startsWith("-") && !under.some((each) => read[each]?.words !== "")) {
        return { why: "its approvals: isn't laid out as this bridge expects" };
      }
      break;
    }
    under.push(at);
  }
  const keys = under.filter((at) => read[at]?.words !== "");
  const indent = keys.length === 0 ? 2 : (read[keys[0] ?? 0]?.indent ?? 2);
  if (keys.some((at) => (read[at]?.indent ?? 0) < indent || read[at]?.words.startsWith("-") === true)) {
    return { why: "its approvals: isn't laid out as this bridge expects" };
  }
  const at = keys.find((each) => read[each]?.indent === indent && MODE.test(read[each]?.words ?? ""));
  return { place: { lines, head, indent, at, under } };
}

/** The value a `mode:` line gives, as written, quotes and all, its comment taken off. */
function valueOf(line: string): string {
  return uncomment(line.trim()).replace(MODE, "").trim();
}

/** YAML 1.1's words for yes and no, as Hermes's reader takes them bare (`hermes_yaml.py`). */
const YES = /^(?:y|Y|yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
const NO = /^(?:n|N|no|No|NO|false|False|FALSE|off|Off|OFF)$/;
const NULL = /^(?:~|null|Null|NULL)?$/;

/**
 * The mode Hermes runs in for a value as written, as `_normalize_approval_mode` reads it: a bare no
 * is `off` (YAML reads `off` as false), a bare yes `manual`, a mode by its name, anything else
 * `manual`, and no line at all its default, `smart`.
 */
export function modeOf(value: string | undefined): HermesMode {
  if (value === undefined) return BASE_MODE;
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted === null) {
    if (NO.test(value)) return "off";
    if (YES.test(value) || NULL.test(value)) return "manual";
  }
  const word = (quoted?.[2] ?? value).trim().toLowerCase();
  return VALID.includes(word) ? (word as HermesMode) : "manual";
}

/** The mode a profile's config puts Hermes in: what its `approvals.mode` says, else Hermes's default. */
export function modeIn(text: string): HermesMode {
  const found = locate(text);
  if ("why" in found) return modeOf(flowValue(text));
  const line = found.place.at === undefined ? undefined : found.place.lines[found.place.at];
  return modeOf(line === undefined ? undefined : valueOf(line));
}

/** `approvals.mode` from a one-line `approvals: {mode: off, …}`, as written; nothing for anything else. */
function flowValue(text: string): string | undefined {
  for (const line of linesOf(text)) {
    if (line.indent !== 0 || !APPROVALS.test(line.words)) continue;
    const inner = /^\{(.*)\}$/.exec(line.words.replace(APPROVALS, "").trim())?.[1];
    for (const pair of inner?.split(",") ?? []) {
      const at = pair.indexOf(":");
      if (at !== -1 && pair.slice(0, at).trim().replace(/^["']|["']$/g, "") === "mode") return pair.slice(at + 1).trim();
    }
  }
  return undefined;
}

/** The line Chips writes: as Hermes's own writer has it, `off` in quotes so YAML doesn't read it as false. */
function lineFor(indent: number, mode: string): string {
  return `${" ".repeat(indent)}mode: ${mode === "off" ? '"off"' : mode}`;
}

/** What a person did to the mode line since Chips wrote it, for the log. */
function since(now: string | undefined): string {
  return now === undefined ? "someone took its mode out since" : `someone put it in ${modeOf(valueOf(now))} since`;
}

/**
 * A pick (`pick`, as `id|until`) written into a profile's config: the text to write and what to keep
 * first, or why it can't be. What is kept says what was there before Chips wrote anything; one kept
 * already stays. Where a person wrote another mode while the same pick held, theirs is left
 * (`theirs`); a new pick from Chips goes in its place, and theirs is what is put back.
 */
export function pickInto(
  text: string,
  mode: string,
  kept: KeptMode | undefined,
  pick: string = mode,
): { readonly text: string; readonly kept: KeptMode } | { readonly why: string } | { readonly theirs: string } {
  const found = locate(text);
  if ("why" in found) return found;
  const { lines, head, indent, at } = found.place;
  const now = at === undefined ? undefined : lines[at];
  const ours = kept !== undefined && kept.theirs !== true && now !== undefined && modeOf(valueOf(now)) === kept.wrote;
  if (kept !== undefined && !ours && kept.pick === pick) return { theirs: since(now) };
  const was: Pick<KeptMode, "was" | "section"> = ours
    ? { was: kept.was, ...(kept.section === true ? { section: true } : {}) }
    : { was: now ?? null, ...(head === undefined ? { section: true } : {}) };
  const line = lineFor(at === undefined ? indent : (lines[at] ?? "").length - (lines[at] ?? "").trimStart().length, mode);
  const next = [...lines];
  if (at !== undefined) next[at] = line;
  else if (head !== undefined) next.splice(head + 1, 0, line);
  else {
    // No `approvals:` yet: one at the end, after the file's last line.
    if (next.at(-1) === "") next.pop();
    next.push("approvals:", line, "");
  }
  return { text: next.join("\n"), kept: { ...was, wrote: mode, pick } };
}

/**
 * What was there put back into a profile's config: the text to write, or nothing to write and why
 * it is left (`left`). A mode a person wrote since Chips did is left as they wrote it, and so is a
 * line they took out. The `approvals:` Chips added goes again once it holds nothing else.
 */
export function putBack(
  text: string,
  kept: KeptMode,
): { readonly text: string } | { readonly left: string } {
  const found = locate(text);
  if ("why" in found) return { left: found.why };
  const { lines, head, at, under } = found.place;
  const now = at === undefined ? undefined : lines[at];
  if (now === undefined || head === undefined || at === undefined || kept.theirs === true) return { left: since(now) };
  if (modeOf(valueOf(now)) !== kept.wrote) return { left: since(now) };
  const next = [...lines];
  if (kept.was === null) {
    next.splice(at, 1);
    // What else it holds: a key, or a comment set in under it. One at the left edge is the file's.
    const held = under.filter((each) => each !== at && /^\s+\S|^[^#\s]/.test(lines[each] ?? ""));
    if (kept.section === true && held.length === 0) next.splice(head, 1);
  } else {
    const indent = now.length - now.trimStart().length;
    next[at] = `${" ".repeat(indent)}${kept.was.trimStart()}`;
  }
  return { text: next.join("\n") };
}
