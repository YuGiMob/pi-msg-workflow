import { describe, expect, it } from "vitest";
import { userMessageText, countLeadingPhaseMatches, countPhaseMatches, findAnchorAfterMessage, countUserTextMatches, lastAssistantMessageText } from "../src/session-helpers.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function userEntry(id: string, text: string): SessionEntry {
  return { id, type: "message", parentId: null, timestamp: "1", message: { role: "user", content: text } } as unknown as SessionEntry;
}

function assistantEntry(id: string): SessionEntry {
  return { id, type: "message", parentId: null, timestamp: "1", message: { role: "assistant", content: "response" } } as unknown as SessionEntry;
}

function toolEntry(id: string): SessionEntry {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "1",
    message: { role: "toolResult", content: [{ type: "text", text: "result" }] },
  } as unknown as SessionEntry;
}

function nonMessageEntry(id: string, type: string): SessionEntry {
  return { id, type, parentId: null, timestamp: "1" } as unknown as SessionEntry;
}

describe("userMessageText", () => {
  it("returns the text of a user message with string content", () => {
    expect(userMessageText(userEntry("u1", "hello"))).toBe("hello");
  });

  it("joins text blocks of an array content", () => {
    const entry = {
      id: "u1",
      type: "message",
      parentId: null,
      timestamp: "1",
      message: { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
    } as unknown as SessionEntry;
    expect(userMessageText(entry)).toBe("ab");
  });

  it("ignores non-text blocks", () => {
    const entry = {
      id: "u1",
      type: "message",
      parentId: null,
      timestamp: "1",
      message: { role: "user", content: [{ type: "image", text: "x" }, { type: "text", text: "y" }] },
    } as unknown as SessionEntry;
    expect(userMessageText(entry)).toBe("y");
  });

  it("returns undefined for non-user messages", () => {
    expect(userMessageText(assistantEntry("a1"))).toBeUndefined();
    expect(userMessageText(toolEntry("t1"))).toBeUndefined();
  });

  it("returns undefined for non-message entries", () => {
    expect(userMessageText(nonMessageEntry("c1", "compaction"))).toBeUndefined();
    expect(userMessageText(nonMessageEntry("l1", "label"))).toBeUndefined();
  });
});

describe("countLeadingPhaseMatches", () => {
  it("counts matching leading user messages", () => {
    const entries = [userEntry("u1", "a"), assistantEntry("a1"), userEntry("u2", "b"), assistantEntry("a2")];
    expect(countLeadingPhaseMatches(entries, ["a", "b", "c"])).toBe(2);
  });

  it("skips non-user entries between matches", () => {
    const entries = [userEntry("u1", "a"), toolEntry("t1"), assistantEntry("a1"), userEntry("u2", "b")];
    expect(countLeadingPhaseMatches(entries, ["a", "b"])).toBe(2);
  });

  it("stops at the first non-matching user message", () => {
    const entries = [userEntry("u1", "x"), assistantEntry("a1"), userEntry("u2", "b")];
    expect(countLeadingPhaseMatches(entries, ["a", "b"])).toBe(0);
  });

  it("returns zero for an empty session", () => {
    expect(countLeadingPhaseMatches([], ["a"])).toBe(0);
  });
});

describe("countPhaseMatches", () => {
  it("counts expected messages in order anywhere in the session", () => {
    const entries = [userEntry("u1", "x"), assistantEntry("a1"), userEntry("u2", "a"), assistantEntry("a2"), userEntry("u3", "b")];
    expect(countPhaseMatches(entries, ["a", "b"])).toBe(2);
  });

  it("skips non-user entries between matches", () => {
    const entries = [userEntry("u1", "a"), toolEntry("t1"), assistantEntry("a1"), userEntry("u2", "b")];
    expect(countPhaseMatches(entries, ["a", "b"])).toBe(2);
  });

  it("does not require the matches to be leading", () => {
    const entries = [userEntry("u1", "other"), assistantEntry("a1"), userEntry("u2", "a"), assistantEntry("a2"), userEntry("u3", "b")];
    expect(countPhaseMatches(entries, ["a", "b"])).toBe(2);
  });

  it("counts only matches in the expected order", () => {
    const entries = [userEntry("u1", "a"), assistantEntry("a1"), userEntry("u2", "b")];
    expect(countPhaseMatches(entries, ["b", "a"])).toBe(1);
  });

  it("returns zero for an empty session", () => {
    expect(countPhaseMatches([], ["a"])).toBe(0);
  });
});

describe("lastAssistantMessageText", () => {
  it("returns the text of the last assistant message", () => {
    const entries = [userEntry("u1", "a"), assistantEntry("a1"), userEntry("u2", "b"), assistantEntry("a2")];
    expect(lastAssistantMessageText(entries)).toBe("response");
  });

  it("skips non-assistant entries when looking for the last message", () => {
    const entries = [assistantEntry("a1"), toolEntry("t1"), nonMessageEntry("c1", "compaction"), userEntry("u2", "b")];
    expect(lastAssistantMessageText(entries)).toBe("response");
  });

  it("joins text blocks of an array content", () => {
    const entry = { ...assistantEntry("a1"), message: { role: "assistant", content: [{ type: "text", text: "FIX: " }, { type: "text", text: "the bug" }] } } as unknown as SessionEntry;
    expect(lastAssistantMessageText([entry])).toBe("FIX: the bug");
  });

  it("ignores assistant messages with empty text", () => {
    const entries = [userEntry("u1", "a"), { ...assistantEntry("a1"), message: { role: "assistant", content: "" } } as unknown as SessionEntry, assistantEntry("a2")];
    expect(lastAssistantMessageText(entries)).toBe("response");
  });

  it("returns undefined when there is no assistant message", () => {
    expect(lastAssistantMessageText([])).toBeUndefined();
    expect(lastAssistantMessageText([userEntry("u1", "a")])).toBeUndefined();
  });
});

describe("findAnchorAfterMessage", () => {
  it("returns the response following the message", () => {
    const entries = [userEntry("u1", "msg"), assistantEntry("a1"), userEntry("u2", "other"), assistantEntry("a2")];
    expect(findAnchorAfterMessage(entries, "msg")?.id).toBe("a1");
  });

  it("prefers the most recent occurrence", () => {
    const entries = [userEntry("u1", "msg"), assistantEntry("a1"), userEntry("u2", "msg"), assistantEntry("a2")];
    expect(findAnchorAfterMessage(entries, "msg")?.id).toBe("a2");
  });

  it("returns the trailing response when the message is the last user message", () => {
    const entries = [userEntry("u1", "msg"), assistantEntry("a1")];
    expect(findAnchorAfterMessage(entries, "msg")?.id).toBe("a1");
  });

  it("skips non-message entries when choosing the response", () => {
    const entries = [userEntry("u1", "msg"), assistantEntry("a1"), nonMessageEntry("c1", "compaction"), userEntry("u2", "other")];
    expect(findAnchorAfterMessage(entries, "msg")?.id).toBe("a1");
  });

  it("does not anchor to a trailing compaction entry", () => {
    const entries = [userEntry("u1", "msg"), assistantEntry("a1"), nonMessageEntry("c1", "compaction")];
    expect(findAnchorAfterMessage(entries, "msg")?.id).toBe("a1");
  });

  it("falls back to the previous response when the last occurrence has none", () => {
    const entries = [userEntry("u1", "msg"), assistantEntry("a1"), userEntry("u2", "msg")];
    expect(findAnchorAfterMessage(entries, "msg")?.id).toBe("a1");
  });

  it("falls back to the response of the first user message when the text is absent", () => {
    const entries = [userEntry("u1", "first"), assistantEntry("a1"), userEntry("u2", "second"), assistantEntry("a2")];
    expect(findAnchorAfterMessage(entries, "absent")?.id).toBe("a1");
  });

  it("falls back to the single response when the text is absent and there is one exchange", () => {
    const entries = [userEntry("u1", "first"), assistantEntry("a1")];
    expect(findAnchorAfterMessage(entries, "absent")?.id).toBe("a1");
  });

  it("falls back to the response after a compaction entry", () => {
    const entries = [nonMessageEntry("c1", "compaction"), userEntry("u1", "first"), assistantEntry("a1")];
    expect(findAnchorAfterMessage(entries, "absent")?.id).toBe("a1");
  });

  it("returns undefined for an empty session", () => {
    expect(findAnchorAfterMessage([], "msg")).toBeUndefined();
  });

  it("returns undefined when the only user message has no response", () => {
    expect(findAnchorAfterMessage([userEntry("u1", "msg")], "msg")).toBeUndefined();
  });
});

describe("countUserTextMatches", () => {
  it("counts exact text matches among user messages", () => {
    const entries = [userEntry("u1", "msg"), assistantEntry("a1"), userEntry("u2", "msg"), userEntry("u3", "other")];
    expect(countUserTextMatches(entries, "msg")).toBe(2);
  });
});
