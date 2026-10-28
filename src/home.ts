/**
 * Hermes's own files for a profile, as Hermes 0.22.0 lays them out (read 27 October 2026): its
 * home is `$HERMES_HOME`, else `~/.hermes`, for the default profile, and `<that>/profiles/<name>`
 * for any other (`hermes_cli/profiles.py`, `get_profile_dir`). In it are `config.yaml`, `.env`,
 * `SOUL.md`, `memories/` and, while its gateway runs, `gateway.pid`.
 *
 * The bridge reads a few values of `config.yaml` and never rewrites it (`hooks.ts` only adds to
 * it). The reader here takes Hermes's own block style, `memory:` then `  memory_char_limit: 3000`,
 * and a one-line `{…}` of plain values; anything else reads as not set, and Hermes's default holds.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Hermes's root: `$HERMES_HOME`, else `~/.hermes`. */
export function hermesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env["HERMES_HOME"] || join(homedir(), ".hermes"));
}

/** A profile's home under Hermes's root: the root for `default`, else `profiles/<name>`. */
export function profileHome(root: string, profile: string | undefined): string {
  const name = (profile ?? "default").trim().toLowerCase();
  return name === "" || name === "default" ? root : join(root, "profiles", name);
}

/** A profile's name as Hermes writes it: `default` unless the config names another. */
export function profileName(profile: string | undefined): string {
  const name = (profile ?? "default").trim().toLowerCase();
  return name === "" ? "default" : name;
}

/** A value in a profile's `.env`, as Hermes's own loader reads one: `NAME=value`, quotes taken off. */
export function envValue(home: string, name: string): string | undefined {
  const path = join(home, ".env");
  if (!existsSync(path)) return undefined;
  let found: string | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== name) continue;
    const raw = match[2] ?? "";
    const quoted = /^(["'])(.*)\1/.exec(raw);
    // The last line naming it wins, as python-dotenv has it.
    found = quoted !== null ? (quoted[2] ?? "") : raw.replace(/\s+#.*$/, "");
  }
  return found;
}

/** A line `NAME=value` added to the end of a profile's `.env`, which keeps its mode. */
export function appendEnv(home: string, name: string, value: string): void {
  const path = join(home, ".env");
  const text = readFileSync(path, "utf8");
  const mode = statSync(path).mode & 0o777;
  appendFileSync(path, `${text === "" || text.endsWith("\n") ? "" : "\n"}${name}=${value}\n`);
  chmodSync(path, mode);
}

/** A profile's `config.yaml`, or nothing when it has none. */
export function configText(home: string): string {
  const path = join(home, "config.yaml");
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/** A line's indent, and the line without a comment that isn't inside quotes. */
function uncommented(line: string): { indent: number; text: string } {
  const indent = line.length - line.trimStart().length;
  let quote: string | undefined;
  for (let at = indent; at < line.length; at += 1) {
    const char = line[at];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#" && (at === indent || /\s/.test(line[at - 1] ?? ""))) {
      return { indent, text: line.slice(indent, at).trimEnd() };
    }
  }
  return { indent, text: line.slice(indent).trimEnd() };
}

/** A plain YAML value: quotes taken off. */
function scalar(text: string): string {
  const trimmed = text.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted !== null ? (quoted[2] ?? "") : trimmed;
}

/** The pairs of a one-line `{a: 1, b: two}`, or nothing for anything else. */
function flowPairs(text: string): Map<string, string> | undefined {
  const inner = /^\{(.*)\}$/.exec(text.trim())?.[1];
  if (inner === undefined) return undefined;
  const pairs = new Map<string, string>();
  for (const part of inner.split(",")) {
    if (part.trim() === "") continue;
    const at = part.indexOf(":");
    if (at === -1) return undefined;
    pairs.set(part.slice(0, at).trim(), scalar(part.slice(at + 1)));
  }
  return pairs;
}

/**
 * A value under a top-level section of `config.yaml`: `yamlValue(text, "memory", "memory_char_limit")`.
 * Nothing when the file doesn't set it, or sets it in a way this reader doesn't take.
 */
export function yamlValue(text: string, section: string, key: string): string | undefined {
  const lines = text.split("\n");
  for (let at = 0; at < lines.length; at += 1) {
    const { indent, text: line } = uncommented(lines[at] ?? "");
    if (indent !== 0 || !line.startsWith(`${section}:`)) continue;
    const rest = line.slice(section.length + 1).trim();
    if (rest !== "") return flowPairs(rest)?.get(key);
    let child: number | undefined;
    for (let below = at + 1; below < lines.length; below += 1) {
      const next = uncommented(lines[below] ?? "");
      if (next.text === "") continue;
      if (next.indent === 0) return undefined;
      child ??= next.indent;
      if (next.indent !== child) continue;
      const match = /^([A-Za-z0-9_.-]+):(.*)$/.exec(next.text);
      if (match?.[1] === key) return scalar(match[2] ?? "");
    }
    return undefined;
  }
  return undefined;
}

/** Whether a YAML value is true, as PyYAML reads one; nothing when it isn't a yes or a no. */
export function yamlBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const word = value.toLowerCase();
  if (["true", "yes", "on", "y"].includes(word)) return true;
  if (["false", "no", "off", "n"].includes(word)) return false;
  return undefined;
}

/** A YAML value as a number, or nothing. */
export function yamlNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "null" || value === "~") return undefined;
  const number = Number(value.replace(/_/g, ""));
  return Number.isFinite(number) ? number : undefined;
}

/** A path as Hermes expands one: `~` at the home. */
function expanded(path: string): string {
  return resolve(path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path);
}

function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a profile's gateway works, which its project file is read from: `terminal.cwd` in its
 * `config.yaml`, else `TERMINAL_CWD` (or the older `MESSAGING_CWD`) in its `.env` or the
 * bridge's environment, else the folder its running gateway started in. Nothing when none of
 * those says.
 */
export function workFolder(home: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = yamlValue(configText(home), "terminal", "cwd");
  if (configured !== undefined && configured !== "" && configured !== ".") {
    const folder = expanded(configured);
    if (isFolder(folder)) return folder;
  }
  for (const name of ["TERMINAL_CWD", "MESSAGING_CWD"]) {
    const said = envValue(home, name) ?? env[name];
    if (said !== undefined && said !== "" && isFolder(expanded(said))) return expanded(said);
  }
  return gatewayFolder(home);
}

/** Each profile's gateway folder, by the `gateway.pid` it was read for: asked again only for a new gateway. */
const gateways = new Map<string, { readonly pidFile: string; readonly folder: string | undefined }>();

/**
 * The folder a profile's running gateway started in: its pid from `gateway.pid` (Hermes writes
 * `{"pid": …}`), its working folder from `/proc` on Linux or `lsof` on a Mac.
 */
export function gatewayFolder(home: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(home, "gateway.pid"), "utf8").trim();
  } catch {
    return undefined;
  }
  const known = gateways.get(home);
  if (known?.pidFile === raw) return known.folder;
  const folder = folderOfPid(raw);
  gateways.set(home, { pidFile: raw, folder });
  return folder;
}

function folderOfPid(raw: string): string | undefined {
  let pid: number | undefined;
  try {
    const said = raw.startsWith("{") ? (JSON.parse(raw) as { pid?: unknown }).pid : Number(raw);
    pid = typeof said === "number" && Number.isInteger(said) && said > 0 ? said : undefined;
  } catch {
    return undefined;
  }
  return pid === undefined ? undefined : processFolder(pid);
}

/** The folder a process works in: from `/proc` on Linux, `lsof` on a Mac. Nothing when it can't be read. */
export function processFolder(pid: number): string | undefined {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = out.split("\n").find((each) => each.startsWith("n"));
    return line === undefined ? undefined : line.slice(1);
  } catch {
    return undefined;
  }
}
