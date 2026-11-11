/**
 * What waited for an agent, as one turn (Chips ADR 0294): what a bridge keeps to make it. An agent
 * works on one turn at a time in a room, so what is said to it meanwhile waits, as does all it was
 * sent while the bridge was away, and one turn is made of what waited, not one each.
 *
 * The words of that turn are the Chips SDK's: `promptFor`, given the messages that waited ahead of
 * the newest (`earlier`), what was overheard after it (`since`), what the session already had
 * (`answered`), the room's lines from before the agent joined (`before`) and what Chips answered
 * when it held the agent's last message (`heldPost`). Here is only which messages share a turn,
 * how long an idle agent gathers, and how much is kept.
 */

import { CONTEXT_BUDGET, type MessageNew, type MessageOverheard } from "@chipschat/protocol";

/** How long an idle agent waits before it starts, so all it is sent at once is one turn. */
export const GATHER_MS = 150;

/** What a bridge keeps of something overheard, to say it to a turn that starts later. */
export type Heard = Pick<MessageOverheard, "from" | "text" | "attachments" | "held">;

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
