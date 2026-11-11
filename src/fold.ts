/**
 * What waited for an agent, as one turn (Chips ADR 0294). An agent works on one turn at a time in
 * a room, so what is said to it meanwhile waits, as does all it was sent while the bridge was
 * away. One turn is made of what waited, not one each: the turn is the newest message's, with its
 * note and the lines said since; the messages that waited ahead of it are said in full before its
 * words, and what was said in the room after, to others, is said last.
 *
 * And what a turn is told of its agent's place in the room: the lines said before the agent joined
 * (`before`, Chips ADR 0088), once, at its first turn there, and that Chips held its last message
 * from the agents it named (`heldPost`, Chips ADR 0097).
 *
 * The Chips SDK words this itself from 1.0.5: `promptFor(message, { earlier, since })`. This is the
 * same text on the SDK this bridge is built on, 1.0.4, and goes when the bridge moves to 1.0.5.
 */

import { type Ack, type PromptOptions, promptFor } from "@chipschat/harness";
import {
  CONTEXT_BUDGET,
  type ContextLine,
  type MessageNew,
  type MessageOverheard,
  type RoomContext,
  renderAttachment,
  renderContext,
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
  /** The room's last lines before the agent joined it (`agent.attached`'s `catch_up`): said once, at its first turn there. */
  readonly before?: Pick<RoomContext, "lines"> | undefined;
  /** What `post` answered when Chips held the agent's last message in the room: said first, as Chips's word. */
  readonly heldPost?: Pick<Ack, "held" | "exchange"> | undefined;
}

/**
 * What an agent is told when Chips held its last message in the room (Chips ADR 0097), from what
 * `post` answered. With `released`, a person has acted in the room since, which hands each agent
 * the newest held message that was for it: the words say the agents have it now.
 */
export function heldWords(answer: Pick<Ack, "held" | "exchange"> | undefined, released = false): string | undefined {
  if (answer?.held !== true) return undefined;
  if (released) {
    return "Your last message in this space was held from the agents it named until a person acted. A person has now, so Chips has handed it to them: do not send it again.";
  }
  const count = answer.exchange?.count;
  const since = typeof count === "number" && count > 0 ? ` (they have sent each other ${count} since a person last acted)` : "";
  return `Your last message in this space was held, so the agents it named do not have it yet: messages between the agents here are held${since} until a person acts. Until then, tell the person what is done and what is blocked, rather than asking the agents again.`;
}

export const BEFORE_HEADING = "Said in this space before you joined:";

/** What was said in the room before the agent joined, without what this turn says as a message. */
function beforeOf(message: MessageNew, earlier: readonly MessageNew[], before: Waited["before"]): string | undefined {
  const said = new Set([message.message_id, ...earlier.map((each) => each.message_id)]);
  const lines = (before?.lines ?? []).filter((line) => line.message_id === undefined || !said.has(line.message_id));
  return lines.length === 0 ? undefined : [BEFORE_HEADING, ...lines.map(renderLine)].join("\n");
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
  const { earlier = [], since = [], answered = [], before, heldPost, ...rest } = options;
  // Held still where this message says so; else a person has acted since, and it was handed over.
  const held = heldWords(heldPost, message.exchange?.stage !== "held");
  const joinedBefore = beforeOf(message, earlier, before);
  if (earlier.length === 0 && since.length === 0 && answered.length === 0 && held === undefined && joinedBefore === undefined) {
    return promptFor(message, rest);
  }
  const taker = rest.taker ?? (message.for?.length === 1 ? message.for[0] : undefined);
  const text = [
    joinedBefore,
    renderContext(contextOf(message, earlier, answered)),
    earlier.length === 0 ? undefined : waitedWords(earlier.length + 1),
    ...earlier.flatMap((each) => saidOf(each, rest, taker)),
    ...saidOf(message, rest, taker),
    sinceOf(since, earlier),
  ]
    .filter((part): part is string => part !== undefined && part !== "")
    .join("\n\n");
  // The words are whole here, under their names, with the lines before them: the SDK's 1.0.4 says
  // them as they are, after the note. What Chips held goes ahead of its word on the agents' talk.
  const { attachments: _files, replying_to: _reply, context: _lines, exchange, ...bare } = message;
  const chips = [held, exchange?.note].filter((part): part is string => part !== undefined && part !== "").join("\n\n");
  const one = { ...bare, text, ...(chips === "" ? {} : { exchange: { ...exchange, note: chips } }) } as MessageNew;
  return promptFor(one, { ...rest, sayWho: false });
}
