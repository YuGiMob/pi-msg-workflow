import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface TextBlock {
  type?: string;
  text?: string;
}

export function userMessageText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as TextBlock[])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }
  return undefined;
}

export function countLeadingPhaseMatches(entries: SessionEntry[], expected: string[]): number {
  let matched = 0;
  for (const entry of entries) {
    const text = userMessageText(entry);
    if (text === undefined) continue;
    if (matched < expected.length && text === expected[matched]) {
      matched++;
    } else {
      break;
    }
  }
  return matched;
}

export function countPhaseMatches(entries: SessionEntry[], expected: string[]): number {
  let matched = 0;
  for (const entry of entries) {
    const text = userMessageText(entry);
    if (text === undefined) continue;
    if (matched < expected.length && text === expected[matched]) matched++;
  }
  return matched;
}

function lastNonUserMessage(entries: SessionEntry[], from: number, to: number): SessionEntry | undefined {
  for (let i = to; i >= from; i--) {
    const entry = entries[i]!;
    if (entry.type === "message" && entry.message.role !== "user") return entry;
  }
  return undefined;
}

function lastNonUserBeforeNextUser(entries: SessionEntry[], from: number): SessionEntry | undefined {
  for (let i = from; i < entries.length; i++) {
    if (userMessageText(entries[i]) !== undefined) {
      return lastNonUserMessage(entries, from, i - 1);
    }
  }
  return lastNonUserMessage(entries, from, entries.length - 1);
}

export function findAnchorAfterMessage(entries: SessionEntry[], messageText: string): SessionEntry | undefined {
  let firstUserIndex = -1;
  const messageIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const text = userMessageText(entries[i]);
    if (text === undefined) continue;
    if (firstUserIndex === -1) firstUserIndex = i;
    if (text === messageText) messageIndices.push(i);
  }
  for (let i = messageIndices.length - 1; i >= 0; i--) {
    const anchor = lastNonUserBeforeNextUser(entries, messageIndices[i]! + 1);
    if (anchor !== undefined) return anchor;
  }
  if (firstUserIndex === -1) return undefined;
  return lastNonUserBeforeNextUser(entries, firstUserIndex + 1);
}

export function countUserTextMatches(entries: SessionEntry[], text: string): number {
  return entries.filter((entry) => userMessageText(entry) === text).length;
}
