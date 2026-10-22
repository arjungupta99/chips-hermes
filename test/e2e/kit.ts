/**
 * Chips's connect kit (its `tools/connect-kit`), loaded from a Chips checkout: a scratch Chips, a
 * gallery card's link made as Chips's Join page makes it, and the card's command run as a person
 * runs it. `CHIPS_REPO` names the checkout, `~/Work/Chips/chips-main` unless set; with none there, the
 * end-to-end tests are skipped and say why.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Run {
  output(): string;
  saw(pattern: RegExp, ms?: number): Promise<void>;
  readonly exited: Promise<number | null>;
  stop(): Promise<void>;
}

export interface CardLink {
  readonly link: string;
  readonly requestId: string;
  readonly capabilities: readonly string[];
  readonly command: string;
}

export interface Said {
  readonly text: string;
  readonly actor: { readonly kind: string; readonly id: string };
}

export interface ScratchChips {
  readonly url: string;
  card(id: string): Promise<CardLink>;
  request(requestId: string): Promise<{ state: string; harness_id?: string; space_id?: string }>;
  capabilities(harnessId: string): Promise<readonly string[]>;
  /** A harness's agents in use, and which is its Main (Chips ADR 0183). */
  agents(harnessId: string): Promise<readonly { readonly name: string; readonly lead: boolean }[]>;
  said(spaceId: string): Promise<readonly Said[]>;
  until<T>(what: string, check: () => Promise<T | undefined | false>, ms?: number): Promise<T>;
  run(command: string, options: { folder: string; home: string; path?: string }): Run;
  stop(): Promise<void>;
}

const repo = process.env["CHIPS_REPO"] ?? join(homedir(), "Work", "Chips", "chips-main");
const kit = join(repo, "tools", "connect-kit", "kit.mts");

/** Why the end-to-end tests can't run here, or false when they can. */
export const skip: string | false = existsSync(kit)
  ? false
  : `no Chips checkout with tools/connect-kit at ${repo}: set CHIPS_REPO to one`;

/**
 * This checkout: packed by the kit and served from a stand-in npm registry to the card's
 * `chips connect` (Chips ADR 0218), as npm will serve it once it is published.
 */
export const here = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export async function scratchChips(): Promise<ScratchChips> {
  const loaded = (await import(kit)) as { scratchChips(): Promise<ScratchChips> };
  return await loaded.scratchChips();
}
