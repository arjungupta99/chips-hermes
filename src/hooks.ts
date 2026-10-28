/**
 * The webhook the bridge adds to a profile's `config.yaml`, so Hermes says how full each session
 * is after every model call (`fills.ts`). Hermes reads `hooks.outbound` when its gateway starts
 * (`gateway/run_startup.py`, `_register_config_hooks`), so an entry added while it runs takes one
 * restart of `hermes gateway`.
 *
 * Only ever added to, never rewritten:
 * - With no top-level `hooks:`, a block is appended at the end.
 * - With a block `hooks:` that has no `outbound:` yet, `outbound:` is put first under it, at the
 *   indent its other keys have.
 * - Anything else (a `hooks:` written on one line, an `outbound:` list already there, an entry
 *   called `chips` with another address) is left as it is, and the lines to add are said.
 *
 * The secret Hermes signs with goes where its gateway reads secrets: `.env` beside the config,
 * named by `secret_env`, which Hermes loads into the gateway's environment at start. A profile
 * with no `.env` gets no new one (Hermes treats a `.env` that exists as the whole truth about
 * some of its keys), and the secret goes in the entry itself.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendEnv, envValue } from "./home.js";
import { HOOK_PATH } from "./fills.js";
import { writeWhole } from "./context.js";

/** The entry's name in `hooks.outbound`, which says it is Chips's. */
export const HOOK_NAME = "chips";
/** Where the secret is, in a profile's `.env`. */
export const SECRET_ENV = "CHIPS_HOOK_SECRET";

/** The address Hermes POSTs a profile's readings to. */
export function hookUrl(port: number, profile: string): string {
  return `http://127.0.0.1:${port}${HOOK_PATH}${profile}`;
}

export type HookOutcome =
  /** Added now: Hermes's gateway takes it at its next start. */
  | { readonly state: "added"; readonly path: string }
  /** There already. */
  | { readonly state: "there"; readonly path: string }
  /** Not added: the file is left as it is, and these lines go under its `hooks:`. */
  | { readonly state: "by_hand"; readonly path: string; readonly why: string; readonly lines: string }
  /** No such profile: nothing to add to. */
  | { readonly state: "no_home"; readonly path: string };

/** The lines of a config, each with its indent and its words without a comment. */
function linesOf(text: string): { indent: number; words: string }[] {
  return text.split("\n").map((line) => {
    const indent = line.length - line.trimStart().length;
    const words = line.trimStart().startsWith("#") ? "" : line.trim().replace(/\s+#.*$/, "");
    return { indent, words };
  });
}

/** The port of a `chips` entry already in a profile's config, for the bridge to keep listening on. */
export function hookPortIn(home: string): number | undefined {
  const path = join(home, "config.yaml");
  if (!existsSync(path)) return undefined;
  const escaped = HOOK_PATH.replace(/[/]/g, "\\/");
  const match = new RegExp(`^\\s*(?:-\\s*)?url:\\s*["']?http:\\/\\/127\\.0\\.0\\.1:(\\d+)${escaped}`, "m").exec(
    readFileSync(path, "utf8"),
  );
  const port = match === null ? undefined : Number(match[1]);
  return port !== undefined && Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

/** The entry's lines, at an indent, with its secret by name or inline. */
function entryLines(indent: string, url: string, secret: { readonly env: string } | { readonly inline: string }): string[] {
  return [
    `${indent}outbound:`,
    `${indent}  - name: ${HOOK_NAME}`,
    `${indent}    url: ${url}`,
    `${indent}    events: [post_api_request]`,
    "env" in secret ? `${indent}    secret_env: ${secret.env}` : `${indent}    secret: "${secret.inline}"`,
    `${indent}    timeout: 5`,
  ];
}

/** Whether a profile's `.env` says the secret, adding it when the file is there without it. */
function secretInEnv(home: string, secret: string): boolean {
  const path = join(home, ".env");
  if (!existsSync(path)) return false;
  if (envValue(home, SECRET_ENV) === undefined) appendEnv(home, SECRET_ENV, secret);
  return true;
}

/**
 * Chips's webhook in a profile's `config.yaml`, added if it isn't there. `secret` is what the
 * bridge signs with where the profile's `.env` doesn't say its own.
 */
export function addHook(home: string, port: number, profile: string, secret: string): HookOutcome {
  const path = join(home, "config.yaml");
  if (!existsSync(home)) return { state: "no_home", path };
  const url = hookUrl(port, profile);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = linesOf(text);
  const ours = new RegExp(`^(?:-\\s*)?url:\\s*["']?${url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']?$`);
  if (lines.some((line) => ours.test(line.words))) return { state: "there", path };
  const where = lines.findIndex((line) => line.indent === 0 && /^["']?hooks["']?\s*:/.test(line.words));
  const byHand = (why: string): HookOutcome => {
    const inEnv = secretInEnv(home, secret);
    const shown = entryLines("  ", url, inEnv ? { env: SECRET_ENV } : { inline: secret });
    return { state: "by_hand", path, why, lines: ["hooks:", ...shown].join("\n") };
  };
  // Added as text only to a plain block mapping: a top-level line that isn't `key:` (a flow `{…}`,
  // a list, a second document) could make the file one Hermes can't read.
  const plain = /^(?:"[^"]+"|'[^']+'|[A-Za-z_][\w.-]*)\s*:(?:\s|$)/;
  if (lines.some((line) => line.indent === 0 && line.words !== "" && !plain.test(line.words))) {
    return byHand("its top level isn't laid out as this bridge expects");
  }
  if (where === -1) {
    const inEnv = secretInEnv(home, secret);
    const block = [
      "# Chips: how full each agent's context is, sent to the chips-hermes bridge after each model call.",
      "hooks:",
      ...entryLines("  ", url, inEnv ? { env: SECRET_ENV } : { inline: secret }),
    ];
    const before = text === "" ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    if (text === "") writeFileSync(path, `${block.join("\n")}\n`, { mode: 0o600 });
    else writeWhole(path, `${text}${before}${block.join("\n")}\n`);
    return { state: "added", path };
  }
  const head = lines[where]?.words ?? "";
  if (head.replace(/^["']?hooks["']?\s*:/, "").trim() !== "") return byHand("its hooks: is written on one line");
  // Its keys, until the next top-level line: their indent, and whether outbound is among them.
  const children: { indent: number; words: string }[] = [];
  for (const line of lines.slice(where + 1)) {
    if (line.words === "") continue;
    if (line.indent === 0) break;
    children.push(line);
  }
  const indent = children[0]?.indent ?? 2;
  const named = new RegExp(`^(?:-\\s*)?name:\\s*["']?${HOOK_NAME}["']?$`);
  if (children.some((line) => named.test(line.words))) {
    return byHand(`its hooks have an entry called ${HOOK_NAME} with another address`);
  }
  if (children.some((line) => line.indent === indent && /^["']?outbound["']?\s*:/.test(line.words))) {
    return byHand("its hooks already have an outbound list");
  }
  if (children.some((line) => line.indent !== indent && line.indent < indent) || children[0]?.words.startsWith("-")) {
    return byHand("its hooks: isn't laid out as this bridge expects");
  }
  const inEnv = secretInEnv(home, secret);
  const raw = text.split("\n");
  raw.splice(where + 1, 0, ...entryLines(" ".repeat(indent), url, inEnv ? { env: SECRET_ENV } : { inline: secret }));
  writeWhole(path, raw.join("\n"));
  return { state: "added", path };
}
