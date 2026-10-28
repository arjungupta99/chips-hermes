/**
 * An agent's context in Chips (Chips ADR 0134): the files Hermes builds each agent from, sent as
 * copies so a person sees them on the agent's page, and a person's edit there saved back where
 * Hermes reads it. Chips adds no context of its own: these are what Hermes 0.22.0 gives an agent
 * (read 27 October 2026), and nothing else.
 *
 * - `SOUL.md` in the profile's home: who it is (`agent/prompt_builder.py`, `load_soul_md`).
 * - `memories/MEMORY.md` and `memories/USER.md`: its notes and what it knows of the person,
 *   entries apart by a line with only `§`, kept to `memory.memory_char_limit` (2,200) and
 *   `memory.user_char_limit` (1,375) characters (`tools/memory_tool_store.py`). Hermes writes them
 *   itself, under a lock on `<file>.lock`, by renaming a whole new file into place; a save here
 *   does the same, and refuses a text that would break the entries or the limit.
 * - One project file in the folder the gateway works in: the first with words in it of
 *   `.hermes.md`, `HERMES.md`, `AGENTS.override.md`, `AGENTS.md`, `agents.md`, `CLAUDE.md`,
 *   `claude.md`, `.cursorrules`. Hermes also walks up to a git root for some of them; this reads
 *   the folder itself only.
 *
 * Hermes builds a session's system prompt once and keeps it word for word until the session
 * compacts (`agent/conversation_loop.py`, `conversation_compression.py`): `READ_NOTE` says so.
 *
 * What is whose: each configured agent is a profile, and so is each agent made in Chips (Chips ADR
 * 0241), cloned from the first: it starts from a copy of the first profile's SOUL.md, with no
 * memory of its own yet. A fork runs on its original's profile, and an agent made before that on
 * the first, so a profile's files are often read by several agents. The first profile's SOUL.md is
 * always in the harness's own set, for the new agents that start from it; so are its memory files
 * where new agents run on the first profile and read them. Any other file goes there once two
 * agents read it. The project file is the gateway's, and always there. An agent's page shows a
 * file it alone reads as its own, and each shared one as the harness's, which it can't have its
 * own of (`replaceable: false`).
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AgentContextCopy, HarnessContextCopy } from "@chipschat/harness";
import { Refuse } from "@chipschat/harness";
import type { ContextEditFrame } from "@chipschat/protocol";
import { configText, workFolder, yamlBool, yamlNumber, yamlValue } from "./home.js";

/** What Chips shows at most of a set, and of one file's text (its `CONTEXT_FILES_SHOWN`, `CONTEXT_FILE_BYTES`). */
const FILES_SHOWN = 8;
const FILE_BYTES = 65_536;

/** When the agent reads these, for the foot under them on its page (Chips ADR 0238). */
export const READ_NOTE =
  "Hermes reads these when a conversation starts. A space already talking picks up a change after it next compacts.";

/** Hermes's memory entries are apart by this (`ENTRY_DELIMITER`). */
export const ENTRY_DELIMITER = "\n§\n";

/** Hermes's limits on its two memory files, in characters, unless `config.yaml` says others. */
export const MEMORY_LIMIT = 2200;
export const USER_LIMIT = 1375;

/** The project files Hermes reads from its working folder, the first with words in it winning. */
export const PROJECT_FILES = [
  ".hermes.md",
  "HERMES.md",
  "AGENTS.override.md",
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  "claude.md",
  ".cursorrules",
] as const;

type Kind = "soul" | "project" | "user" | "memory";

/** Each kind's row, in the order a page shows them. */
const ROWS: Readonly<Record<Kind, { readonly title: string; readonly role: string }>> = {
  soul: { title: "Who it is", role: "identity" },
  project: { title: "Project instructions", role: "instructions" },
  user: { title: "About you", role: "about_you" },
  memory: { title: "Memory", role: "memory" },
};
const ORDER: readonly Kind[] = ["soul", "project", "user", "memory"];

/** One file Hermes gives an agent: where it is, what it is, and whose. */
export interface Source {
  readonly path: string;
  readonly kind: Kind;
  /** Its own name: `SOUL.md`. */
  readonly file: string;
  /** The profile it belongs to: the first that reads it, for a project file. */
  readonly profile: string;
  /** For a memory file: its limit in characters. */
  readonly limit?: number | undefined;
}

/** A profile, as the context needs one: its name and its home. */
export interface Profile {
  readonly name: string;
  readonly home: string;
}

/** One of the harness's agents in Chips, and the profile it runs on. */
export interface Reader {
  readonly agentId: string;
  readonly profile: Profile;
}

/** A file's text as Chips is sent it, and its hash: a missing file reads as empty. */
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8").replace(/^﻿/, "");
  } catch {
    return "";
  }
}

export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A text's length as Python counts it: characters, not UTF-16 units. */
function length(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

const said = (count: number) => count.toLocaleString("en-US");

/** A memory file's entries, as Hermes reads them: split at each `§` line, trimmed, the empty and the repeated dropped. */
export function entriesOf(text: string): string[] {
  return [...new Set(text.split(ENTRY_DELIMITER).map((each) => each.trim()).filter((each) => each !== ""))];
}

/**
 * Why Hermes couldn't take a memory file's text, in plain words, or nothing when it can. A file
 * over its limit takes no more entries, and an entry longer than the whole limit is text Hermes's
 * memory tool refuses to rewrite (its "drift"): keeping the whole file to the limit keeps both away.
 */
export function memoryProblem(text: string, limit: number, what: string): string | undefined {
  const total = length(entriesOf(text).join(ENTRY_DELIMITER));
  if (total > limit) {
    return `That is ${said(total)} characters, and Hermes keeps ${what} to ${said(limit)}. Take out ${said(total - limit)}.`;
  }
  return undefined;
}

/** A profile's memory settings: whether each file is on, and its limit. */
function memorySettings(home: string): { memory?: number; user?: number } {
  const text = configText(home);
  const value = (key: string) => yamlValue(text, "memory", key);
  return {
    ...(yamlBool(value("memory_enabled")) === false ? {} : { memory: yamlNumber(value("memory_char_limit")) ?? MEMORY_LIMIT }),
    ...(yamlBool(value("user_profile_enabled")) === false ? {} : { user: yamlNumber(value("user_char_limit")) ?? USER_LIMIT }),
  };
}

/** The files a profile gives each of its agents, its project file among them. */
export function sourcesOf(profile: Profile, env: NodeJS.ProcessEnv = process.env): Source[] {
  const { name, home } = profile;
  const found: Source[] = [];
  const soul = join(home, "SOUL.md");
  if (existsSync(soul)) found.push({ path: soul, kind: "soul", file: "SOUL.md", profile: name });
  const folder = workFolder(home, env);
  const project = folder === undefined ? undefined : PROJECT_FILES.find((file) => readText(join(folder, file)).trim() !== "");
  if (folder !== undefined && project !== undefined) {
    found.push({ path: join(folder, project), kind: "project", file: project, profile: name });
  }
  const memory = memorySettings(home);
  if (memory.user !== undefined) {
    found.push({ path: join(home, "memories", "USER.md"), kind: "user", file: "USER.md", profile: name, limit: memory.user });
  }
  if (memory.memory !== undefined) {
    found.push({ path: join(home, "memories", "MEMORY.md"), kind: "memory", file: "MEMORY.md", profile: name, limit: memory.memory });
  }
  return found;
}

type Payload = Record<string, unknown>;

/** A memory file's row line: what it holds, and how entries are kept apart. */
function aboutOf(source: Source): string | undefined {
  if (source.limit === undefined) return undefined;
  const what = source.kind === "user" ? "What it knows of you" : "Its notes";
  return `${what}, up to ${said(source.limit)} characters. A line with only § starts the next entry.`;
}

/** One file with its text, as Chips shows it, under the name the set gives it. */
function fileOf(source: Source, name: string): { file: Payload; tooLarge: boolean } {
  const text = readText(source.path);
  const about = aboutOf(source);
  return {
    tooLarge: Buffer.byteLength(text, "utf8") > FILE_BYTES,
    file: {
      name,
      title: ROWS[source.kind].title,
      role: ROWS[source.kind].role,
      ...(about === undefined ? {} : { about }),
      text,
      hash: hashOf(text),
      editable: true,
    },
  };
}

const byOrder = (a: Source, b: Source) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.profile.localeCompare(b.profile);

/** Everything the harness's agents read now, and who reads what. */
export class Picture {
  /** Each file by its path, and the agents that read it. */
  readonly readers = new Map<string, { source: Source; agents: string[] }>();
  /** The shared files, each with its id and the name the set shows. */
  readonly shared = new Map<string, { id: string; name: string }>();
  /** The agents and the files each reads, in page order. */
  readonly agents = new Map<string, Source[]>();

  constructor(
    readers: readonly Reader[],
    /** The first profile: the one new agents start from, whose files the harness's set has. */
    private readonly first: Profile | undefined,
    env: NodeJS.ProcessEnv = process.env,
    /** Whether each new agent gets a profile of its own, not the first's memory (Chips ADR 0241). */
    private readonly ownProfiles = false,
  ) {
    const byProfile = new Map<string, Source[]>();
    const sourcesFor = (profile: Profile): Source[] => {
      let sources = byProfile.get(profile.home);
      if (sources === undefined) {
        sources = sourcesOf(profile, env);
        byProfile.set(profile.home, sources);
      }
      return sources;
    };
    if (first !== undefined) for (const source of sourcesFor(first)) this.readers.set(source.path, { source, agents: [] });
    for (const reader of readers) {
      const sources = sourcesFor(reader.profile);
      this.agents.set(reader.agentId, [...sources].sort(byOrder));
      for (const source of sources) {
        const entry = this.readers.get(source.path) ?? { source, agents: [] };
        if (!entry.agents.includes(reader.agentId)) entry.agents.push(reader.agentId);
        this.readers.set(source.path, entry);
      }
    }
    // Shared: the project file, the first profile's files new agents read, and any other read by two agents.
    const taken = new Set<string>();
    const ids = new Set<string>();
    const sharing = [...this.readers.values()]
      .filter(({ source, agents }) => source.kind === "project" || this.forNewAgents(source) || agents.length > 1)
      .sort((a, b) => (a.source.profile === first?.name ? 0 : 1) - (b.source.profile === first?.name ? 0 : 1) || byOrder(a.source, b.source));
    for (const { source } of sharing) {
      const name = taken.has(source.file) ? `${source.file} (${source.profile})` : source.file;
      taken.add(name);
      let id = `${source.profile}-${source.kind}`.slice(0, 60);
      for (let count = 2; ids.has(id); count += 1) id = `${source.profile}-${source.kind}-${count}`.slice(0, 64);
      ids.add(id);
      this.shared.set(source.path, { id, name });
    }
  }

  /**
   * Whether each new agent starts with this file or a copy of it: the first profile's files, or
   * where each new agent gets a profile of its own, the first profile's SOUL.md and the project file.
   */
  private forNewAgents(source: Source): boolean {
    if (source.profile !== this.first?.name) return false;
    return !this.ownProfiles || source.kind === "soul" || source.kind === "project";
  }

  /** The harness's own set, as `PUT /v1/harnesses/:id/context` takes it. */
  harnessCopy(): HarnessContextCopy {
    const shown: Payload[] = [];
    const notShown: Payload[] = [];
    for (const [path, { id, name }] of this.shared) {
      const entry = this.readers.get(path);
      if (entry === undefined) continue;
      const { source, agents } = entry;
      const { file, tooLarge } = fileOf(source, name);
      if (tooLarge || shown.length >= FILES_SHOWN) {
        notShown.push({ name, title: ROWS[source.kind].title, reason: tooLarge ? "too_large" : "count" });
        continue;
      }
      shown.push({
        ...file,
        id,
        used_by: agents.length,
        ...(this.forNewAgents(source) ? { for_new_agents: true } : {}),
      });
    }
    return {
      shared: shown,
      ...(notShown.length === 0 ? {} : { not_shown: notShown }),
    } as unknown as HarnessContextCopy;
  }

  /** One agent's files, as `PUT /v1/agents/:id/context` takes them: its own, and the shared it reads. */
  agentCopy(agentId: string): AgentContextCopy | undefined {
    const sources = this.agents.get(agentId);
    if (sources === undefined) return undefined;
    const files: Payload[] = [];
    const notShown: Payload[] = [];
    for (const source of sources) {
      const shared = this.shared.get(source.path);
      if (files.length >= FILES_SHOWN) {
        notShown.push({ name: shared?.name ?? source.file, title: ROWS[source.kind].title, reason: "count" });
        continue;
      }
      if (shared !== undefined) {
        files.push({
          name: shared.name,
          title: ROWS[source.kind].title,
          role: ROWS[source.kind].role,
          editable: true,
          shared: shared.id,
          replaceable: false,
        });
        continue;
      }
      const { file, tooLarge } = fileOf(source, source.file);
      if (tooLarge) notShown.push({ name: source.file, title: ROWS[source.kind].title, reason: "too_large" });
      else files.push(file);
    }
    return {
      files,
      ...(notShown.length === 0 ? {} : { not_shown: notShown }),
      read_note: READ_NOTE,
    } as unknown as AgentContextCopy;
  }

  /** The file an edit names: an agent's own, or one of the harness's set; with whether it is shared. */
  find(agentId: string | undefined, name: string): { source: Source; shared: boolean } | undefined {
    if (agentId === undefined) {
      for (const [path, { name: shown }] of this.shared) {
        const source = this.readers.get(path)?.source;
        if (shown === name && source !== undefined) return { source, shared: true };
      }
      return undefined;
    }
    for (const source of this.agents.get(agentId) ?? []) {
      const shared = this.shared.get(source.path);
      if ((shared?.name ?? source.file) === name) return { source, shared: shared !== undefined };
    }
    return undefined;
  }
}

// ------------------------------------------------------------------ saving as Hermes does

/** How long a save waits for Hermes to let go of its memory file's lock. */
const LOCK_WAIT_MS = 10_000;

/**
 * Hold `fcntl.flock` on a lock file, as Hermes's memory store does on `MEMORY.md.lock`, while
 * `work` runs. Node has no flock, so a small `perl`, which macOS and Linux carry, holds it until
 * its input closes.
 */
const LOCKER = [
  "use Fcntl qw(:flock O_RDWR O_CREAT O_NOFOLLOW);",
  "sysopen(my $fh, $ARGV[0], O_RDWR|O_CREAT|O_NOFOLLOW, 0600) or die \"open: $!\\n\";",
  "chmod 0600, $fh;",
  "flock($fh, LOCK_EX) or die \"flock: $!\\n\";",
  "$| = 1; print \"locked\\n\";",
  "while (<STDIN>) {}",
  "flock($fh, LOCK_UN);",
].join(" ");

export async function withLock<T>(lockPath: string, work: () => T | Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
  const child = spawn("perl", ["-e", LOCKER, lockPath], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise<void>((done) => {
    child.on("close", () => done());
    child.on("error", () => done());
  });
  try {
    await new Promise<void>((locked, failed) => {
      const timer = setTimeout(() => failed(new Error("Hermes is writing its memory right now. Try again in a moment.")), waitMs);
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.includes("locked\n")) {
          clearTimeout(timer);
          locked();
        }
      });
      child.on("error", () => {
        clearTimeout(timer);
        failed(new Error("The bridge couldn't lock Hermes's memory file, so it saved nothing: this machine has no perl."));
      });
      child.on("close", () => {
        clearTimeout(timer);
        failed(new Error("The bridge couldn't lock Hermes's memory file, so it saved nothing."));
      });
    });
    return await work();
  } finally {
    child.stdin.end();
    if (child.exitCode === null) {
      const killer = setTimeout(() => child.kill(), 2000);
      await exited;
      clearTimeout(killer);
    }
  }
}

/**
 * A whole new file renamed into place, as Hermes's `atomic_write_text` does: a reader never sees
 * half of one. Its mode stays what it was; a new file is the owner's alone.
 */
export function writeWhole(path: string, text: string): void {
  const target = existsSync(path) && lstatSync(path).isSymbolicLink() ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const temp = join(dirname(target), `.chips_${basename(target)}.${randomBytes(4).toString("hex")}`);
  const fd = openSync(temp, "w", mode);
  try {
    writeSync(fd, text, null, "utf8");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * A person's edit of a file from Chips, saved where Hermes reads it, only if the file is still the
 * version they changed. A memory file is checked against Hermes's own rules first, then saved
 * under its lock as Hermes would write it: its entries apart by `§` lines.
 */
export async function saveEdit(source: Source, edit: Pick<ContextEditFrame, "text" | "base_hash">): Promise<void> {
  const memory = source.limit !== undefined;
  if (memory) {
    const problem = memoryProblem(edit.text, source.limit ?? MEMORY_LIMIT, source.kind === "user" ? "what it knows of you" : "its memory");
    if (problem !== undefined) throw new Refuse(problem, undefined, "failed");
  }
  const save = () => {
    const now = readText(source.path);
    if (edit.base_hash !== null && hashOf(now) !== edit.base_hash) {
      throw new Refuse("", undefined, "changed");
    }
    writeWhole(source.path, memory ? entriesOf(edit.text).join(ENTRY_DELIMITER) : edit.text);
  };
  if (!memory) {
    save();
    return;
  }
  // Hermes makes its memories folder the first time it loads them; a profile that never has, gets it here.
  const folder = dirname(source.path);
  if (!existsSync(dirname(folder))) throw new Refuse(`Hermes has no profile at ${dirname(folder)}.`, undefined, "failed");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  await withLock(`${source.path}.lock`, save);
}

// ------------------------------------------------------------------ the copies, kept current

/** Who reads what now: the harness's agents in Chips, each with its profile, and the first profile. */
export interface Roster {
  readonly readers: readonly Reader[];
  readonly first: Profile | undefined;
  /** Whether each new agent gets a profile of its own (Chips ADR 0241). */
  readonly ownProfiles?: boolean | undefined;
}

/** Where the copies go: the SDK's `chips.settings`. */
export interface ContextsPort {
  readonly agent: (agentId: string, copy: AgentContextCopy) => Promise<unknown>;
  readonly harness: (copy: HarnessContextCopy) => Promise<unknown>;
}

/**
 * The copies Chips holds of the agents' files and the harness's own set, kept current: read from
 * Hermes's files and handed to the SDK, which sends one only when it isn't what Chips took last.
 * Reads, sends and saves go one after another, so a copy read before a save never lands after it.
 */
export class Contexts {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly roster: () => Roster,
    private readonly port: ContextsPort,
    private readonly log: (line: string) => void,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Every copy read again, and sent where it moved. */
  refresh(): Promise<void> {
    return this.inLine(async () => {
      const { readers, first, ownProfiles } = this.roster();
      const picture = new Picture(readers, first, this.env, ownProfiles);
      await this.port.harness(picture.harnessCopy()).catch((error: unknown) => {
        this.log(`the harness's context not sent: ${messageOf(error)}`);
      });
      for (const { agentId } of readers) {
        const copy = picture.agentCopy(agentId);
        if (copy === undefined) continue;
        await this.port.agent(agentId, copy).catch((error: unknown) => {
          this.log(`${agentId}'s context not sent: ${messageOf(error)}`);
        });
      }
    }).catch((error: unknown) => this.log(`the context wasn't read: ${messageOf(error)}`));
  }

  /**
   * A person's edit from Chips: saved, and answered with the copy it is in now; or refused, the
   * copy as it is now beside the reason. The other copies the file is in follow.
   */
  async edit(frame: ContextEditFrame): Promise<AgentContextCopy | HarnessContextCopy> {
    const answer = await this.inLine(async () => {
      const { readers, first, ownProfiles } = this.roster();
      const copyNow = () => {
        const picture = new Picture(readers, first, this.env, ownProfiles);
        return frame.agent_id === undefined ? picture.harnessCopy() : picture.agentCopy(frame.agent_id);
      };
      const found = new Picture(readers, first, this.env, ownProfiles).find(frame.agent_id, frame.name);
      if (found === undefined) {
        throw new Refuse(`Hermes gives this agent no file called ${frame.name}.`, copyNow(), "failed");
      }
      const { source, shared } = found;
      if (frame.base_hash === null) {
        const why =
          source.kind === "project"
            ? "Every agent on Hermes's gateway reads the same project file, so one can't have its own."
            : `Every agent on Hermes's ${source.profile} profile reads the same ${source.file}, so one can't have its own.`;
        throw new Refuse(why, copyNow(), "failed");
      }
      try {
        await saveEdit(source, frame);
      } catch (error) {
        const reason = error instanceof Refuse ? error.reason : "failed";
        this.log(`${source.path} not saved from Chips: ${reason === "changed" ? "it changed since" : messageOf(error)}`);
        throw new Refuse(error instanceof Refuse ? error.message : messageOf(error), copyNow(), reason);
      }
      this.log(`${source.path} saved from Chips${shared ? ", for every agent that reads it" : ""}`);
      const copy = copyNow();
      if (copy === undefined) throw new Refuse("Saved, but the agent is gone.", undefined, "failed");
      return copy;
    });
    void this.refresh();
    return answer;
  }

  private inLine<T>(work: () => Promise<T>): Promise<T> {
    const done = this.chain.catch(() => undefined).then(work);
    this.chain = done.catch(() => undefined);
    return done;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
