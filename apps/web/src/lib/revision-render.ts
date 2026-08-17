import {
  isOpenMessageState,
  isTerminalMessageState,
  type Message,
  type MessageRevision,
} from "@chengchenccc/message";

export function getRevisionText(rev: MessageRevision | Message): string {
  return rev.text ?? "";
}

export type { ContentBlock } from "@chengchenccc/message";
export { isOpenMessageState, isTerminalMessageState };
