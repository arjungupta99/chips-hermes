/**
 * What waited for an agent, as one turn (Chips ADR 0294). An agent works on one turn at a time in
 * a room, so what is said to it meanwhile waits, as does all it was sent while the bridge was
 * away. One turn is made of what waited, not one each: the turn is the newest message's, with its
 * note and the lines said since; the messages that waited ahead of it are said in full before its
 * words, and what was said in the room after, to others, is said last.
 *
 * The Chips SDK words this itself from 1.0.5: `promptFor(message, { earlier, since })`. This is the
 * same text on the SDK this bridge is built on, 1.0.4, and goes when the bridge moves to 1.0.5.
 */

import { type PromptOptions, promptFor } from "@chipschat/harness";
import {
  CONTEXT_BUDGET,
  type ContextLine,
  type MessageNew,
  type MessageOverheard,
  renderAttachment,
  renderLine,
  renderReplyingTo,
  withRole,
} from "@chipschat/protocol";

/** How long an idle agent waits before it starts, so all it is sent at once is one turn. */
export const GATHER_MS = 150;

/** What a bridge keeps of something overheard, to say it to a turn that starts later. */
export type Heard = Pick<MessageOverheard, "from" | "text" | "attachments" | "held">;

export interface Waited {
  /** The messages for the same agent that waited ahead of this one, oldest first. */
  readonly earlier?: readonly MessageNew[] | undefined;
  /** The ids of messages the agent has already had a turn on: left out of the lines since. */
  readonly answered?: readonly string[] | undefined;
  /** What was said in the room to others after this message arrived, oldest first. */
  readonly since?: readonly Heard[] | undefined;
}

/** Whether a message may share a turn with others: not one Chips handed over, whose note is about it alone. */
export function folds(message: MessageNew): boolean {
  return message.handed !== true;
}

/** A turn begun on these: their ids kept, the newest of them, for the lines since of what arrives while it goes. */
export function keepAnswered(answered: string[], messages: readonly MessageNew[]): void {
  answered.push(...messages.map((each) => each.message_id));
  answered.splice(0, Math.max(0, answered.length - CONTEXT_BUDGET.lines));
}

/** What is kept of what was overheard: the newest of it, as many as a turn says. */
export function keepHeard(since: Heard[], heard: Heard): void {
  since.push(heard);
  if (since.length > CONTEXT_BUDGET.lines) since.shift();
}

/** Something overheard as a line of the room, which the plain form says as it does every other. */
function lineOfHeard(heard: Heard): ContextLine {
  const files = heard.attachments ?? [];
  const said = files.flatMap((file) => (file.transcript === undefined ? [] : [file.transcript]));
  return {
    seq: 1,
    at: "",
    kind: "said",
    from: {
      id: heard.from.participant_id,
      kind: heard.from.kind,
      name: heard.from.display_name,
      ...(heard.from.workspace_role === undefined ? {} : { workspace_role: heard.from.workspace_role }),
    },
    text: heard.text,
    ...(said.length === 0 ? {} : { transcript: said.join(" ") }),
    ...(files.length === 0 ? {} : { files: files.map((file) => file.filename) }),
    ...(heard.held === true ? { held: true } : {}),
  } as ContextLine;
}

function sinceOf(since: readonly Heard[], earlier: readonly MessageNew[]): string | undefined {
  const newest = since.slice(-CONTEXT_BUDGET.lines);
  if (newest.length === 0) return undefined;
  const those = earlier.length === 0 ? "that message" : "those messages";
  return [`Said in this space after ${those}, to others:`, ...newest.map((each) => renderLine(lineOfHeard(each)))].join("\n");
}

function waitedWords(count: number): string {
  return `${count} messages for you waited while you were working or away. They follow, oldest first. Answer them together in one reply, and where a later one changes or settles an earlier one, go by the later.`;
}

/** One message as a turn says it: the message it answers, then its words under who said them, and its files. */
function saidOf(message: MessageNew, options: PromptOptions, taker: string | undefined): string[] {
  const who = options.sayWho === false ? "" : `${withRole(message.from.display_name, message.from)}: `;
  const files = (message.attachments ?? []).map(renderAttachment);
  const replying = renderReplyingTo(message.replying_to, {
    sender: {
      id: message.from.participant_id,
      name: message.from.display_name,
      kind: message.from.kind,
      workspace_role: message.from.workspace_role,
    },
    taker,
    at: message.ts,
    zone: options.zone,
  });
  return [replying, [`${who}${message.text}`, ...files].join("\n")];
}

/**
 * What was said since the agent last spoke, without the messages that waited, which are said in
 * full, and without those it has had a turn on: a message that arrived while such a turn was going
 * was sent with them among the lines.
 */
function contextOf(message: MessageNew, earlier: readonly MessageNew[], answered: readonly string[]): MessageNew["context"] {
  const { context } = message;
  const waited = new Set([...earlier.map((each) => each.message_id), ...answered]);
  if (context === undefined || waited.size === 0) return context;
  return { ...context, lines: context.lines.filter((line) => line.message_id === undefined || !waited.has(line.message_id)) };
}

/** The turn's text for this message and those that waited ahead of it: `promptFor`, from the SDK's 1.0.5. */
export function promptForAll(message: MessageNew, options: PromptOptions & Waited = {}): string {
  const { earlier = [], since = [], answered = [], ...rest } = options;
  if (earlier.length === 0 && since.length === 0 && answered.length === 0) return promptFor(message, rest);
  const taker = rest.taker ?? (message.for?.length === 1 ? message.for[0] : undefined);
  const text = [
    earlier.length === 0 ? undefined : waitedWords(earlier.length + 1),
    ...earlier.flatMap((each) => saidOf(each, rest, taker)),
    ...saidOf(message, rest, taker),
    sinceOf(since, earlier),
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
  // The words are whole here, under their names: the SDK's 1.0.4 says them as they are, after the
  // note and the lines since, which no longer hold the messages that waited.
  const { attachments: _files, replying_to: _reply, ...bare } = message;
  const one = { ...bare, text, context: contextOf(message, earlier, answered) } as MessageNew;
  return promptFor(one, { ...rest, sayWho: false });
}
