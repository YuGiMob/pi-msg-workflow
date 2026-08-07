import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({}));
vi.mock("@earendil-works/pi-tui", () => ({}));

import { getWorkflowConfig } from "../src/workflow-config.js";

const MSG1 = "Read the entirety of the codebase";
const MSG2 = "inform me about all of the improvements";
const MSG3 = "Are these improvements actually adding value";
const MSG4 = "Implement all of the changes worth implementing";
const MSG5 = "take a look at the git status and git diff";
const MSG6 = "take a closer look at all of the changes";
const MSG7 = "If your review found any issues with the staged changes, fix them now";

const MESSAGES = { "1": MSG1, "2": MSG2, "3": MSG3, "4": MSG4, "5": MSG5, "6": MSG6, "7": MSG7 };
const COMMANDS = { "1": "git add ." };

const DEFAULT_WORKFLOW = {
  rounds: 2,
  start: ["1", "2", "3", "4", "5"],
  loop: [
    { tree: "1" },
    { cmd: "1" },
    { send: "6" },
    { send: "7" },
    { send: "5", onlyIfChanges: true },
    { cmd: "1" },
  ],
};

function userEntry(id: string, text: string) {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "1",
    message: { role: "user", content: text },
  };
}

function assistantEntry(id: string) {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "1",
    message: { role: "assistant", content: "response" },
  };
}

function toolResultEntry(id: string) {
  return {
    id,
    type: "message",
    parentId: null,
    timestamp: "1",
    message: { role: "toolResult", content: [{ type: "text", text: "result" }] },
  };
}

function fullPhaseA() {
  return [
    userEntry("u1", MSG1),
    assistantEntry("a1"),
    userEntry("u2", MSG2),
    assistantEntry("a2"),
    userEntry("u3", MSG3),
    assistantEntry("a3"),
    userEntry("u4", MSG4),
    assistantEntry("a4"),
    userEntry("u5", MSG5),
    assistantEntry("a5"),
  ];
}

const holder: {
  branch: any[];
  state: { active: boolean };
  workflow: Record<string, any>;
} = { branch: [], state: { active: false }, workflow: DEFAULT_WORKFLOW };

function createCtx(entries: any[] = [], overrides: Record<string, any> = {}) {
  holder.branch = [...entries];
  holder.state.active = false;
  return {
    hasUI: true,
    ui: { notify: vi.fn(), setWorkingMessage: vi.fn(), custom: vi.fn() },
    isIdle: vi.fn(() => !holder.state.active),
    waitForIdle: vi.fn(async () => {
      holder.state.active = false;
    }),
    navigateTree: vi.fn(async () => ({ cancelled: false })),
    sessionManager: { getBranch: vi.fn(() => holder.branch) },
    ...overrides,
  };
}

describe("workflow extension", () => {
  let pi: any;
  let commands: Record<string, any>;

  beforeEach(async () => {
    commands = {};
    pi = {
      registerCommand: vi.fn((name: string, cmd: any) => {
        commands[name] = cmd;
      }),
      sendUserMessage: vi.fn((content: string) => {
        const id = String(holder.branch.length);
        holder.branch.push(userEntry(`u${id}`, content));
        holder.branch.push(assistantEntry(`a${id}`));
        holder.state.active = true;
      }),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    };
    holder.workflow = structuredClone(DEFAULT_WORKFLOW);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(holder.workflow);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const mod = await import("../index.js");
    mod.default(pi);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("registers the workflow, tree-jump and workflow-stop commands", () => {
    expect(commands["workflow"]).toBeDefined();
    expect(commands["tree-jump"]).toBeDefined();
    expect(commands["workflow-stop"]).toBeDefined();
  });

  it("requires interactive mode", async () => {
    const ctx = createCtx([], { hasUI: false });
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/workflow requires interactive mode", "error");
  });

  it("warns about config errors when opening the editor", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return "not json";
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const ctx = createCtx();
    await commands["workflow-edit"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("workflow.json"), "warning");
  });

  it("aborts when required messages are missing", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(holder.workflow);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ "1": MSG1, "2": MSG2 });
    });
    const ctx = createCtx();
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Missing messages"), "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("aborts when required commands are missing", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(holder.workflow);
      if (String(path).includes("commands.json")) return JSON.stringify({});
      return JSON.stringify(MESSAGES);
    });
    const ctx = createCtx();
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Missing commands"), "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("sends the full start phase when nothing is present yet", async () => {
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG1, MSG2, MSG3, MSG4, MSG5, MSG6, MSG7, MSG6, MSG7]);
  });

  it("waits for pending turns before each send and before detection", async () => {
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    const sends = pi.sendUserMessage.mock.invocationCallOrder;
    const waits = ctx.waitForIdle.mock.invocationCallOrder;
    expect(sends).toHaveLength(9);
    expect(waits).toHaveLength(10);
    for (let i = 0; i < sends.length; i++) {
      expect(waits[i]).toBeLessThan(sends[i]!);
      expect(sends[i]).toBeLessThan(waits[i + 1]!);
    }
  });

  it("skips the start phase when all messages are already present", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7]);
  });

  it("continues the start phase from where it left off", async () => {
    const entries = [userEntry("u1", MSG1), assistantEntry("a1"), userEntry("u2", MSG2), assistantEntry("a2")];
    const ctx = createCtx(entries);
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG3, MSG4, MSG5, MSG6, MSG7, MSG6, MSG7]);
  });

  it("resets context, stages changes, and checks for changes each review round", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(6);
    expect(pi.exec).toHaveBeenCalledWith("git", ["add", "."]);
    expect(pi.exec).toHaveBeenCalledWith("git", ["status", "--porcelain"]);
    expect(ctx.navigateTree).toHaveBeenCalledTimes(2);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a1", { summarize: false });
  });

  it("runs the requested number of rounds", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("3", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(9);
    expect(ctx.navigateTree).toHaveBeenCalledTimes(3);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG6, MSG7]);
  });

  it("uses the configured default round count for invalid arguments", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("abc", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(6);
  });

  it("uses the configured default for partially numeric arguments", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("3abc", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(6);
  });

  it("clamps rounds to the maximum", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("99", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(15);
  });

  it("aborts when a command fails", async () => {
    pi.exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Command 1 failed"), "error");
    expect(ctx.navigateTree).toHaveBeenCalledTimes(1);
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("runs loop commands with quoted arguments", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ rounds: 1, start: [], loop: [{ tree: "1" }, { cmd: "1" }] });
      if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git commit -m \"my message\"" });
      return JSON.stringify(MESSAGES);
    });
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "my message"]);
  });

  it("aborts on a loop command with an unterminated quote", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ rounds: 1, start: [], loop: [{ tree: "1" }, { cmd: "1" }] });
      if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git commit -m \"my message" });
      return JSON.stringify(MESSAGES);
    });
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 has an unterminated quote.", "error");
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("sends the validation message when changes are detected", async () => {
    pi.exec = vi.fn(async (cmd: string, args: string[]) =>
      cmd === "git" && args[0] === "status"
        ? { code: 0, stdout: " M modified.txt", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG5, MSG6, MSG7, MSG5]);
  });

  it("skips the validation message when no changes are detected", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no changes detected"), "info");
  });

  it("skips the validation message only in rounds without changes", async () => {
    let statusCalls = 0;
    pi.exec = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") {
        statusCalls++;
        return statusCalls === 1
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 0, stdout: " M modified.txt", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG5]);
    expect(statusCalls).toBe(2);
  });

  it("aborts when git status fails", async () => {
    pi.exec = vi.fn(async (cmd: string, args: string[]) =>
      cmd === "git" && args[0] === "status"
        ? { code: 1, stdout: "", stderr: "fatal" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("git status --porcelain failed"), "error");
  });

  it("aborts when navigation is cancelled", async () => {
    const ctx = createCtx(fullPhaseA(), {
      navigateTree: vi.fn(async () => ({ cancelled: true })),
    });
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow cancelled", "warning");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("anchors to the last entry before the next user message", async () => {
    const entries = [
      userEntry("u1", MSG1),
      assistantEntry("a1a"),
      toolResultEntry("t1"),
      assistantEntry("a1b"),
      userEntry("u2", MSG2),
      assistantEntry("a2"),
    ];
    const ctx = createCtx(entries);
    await commands["workflow"].handler("", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a1b", { summarize: false });
  });

  it("anchors to the response of the sent start message when message 1 is absent", async () => {
    const entries = [
      userEntry("x1", "unrelated conversation"),
      assistantEntry("x2"),
      userEntry("x3", "more conversation"),
      assistantEntry("x4"),
    ];
    const ctx = createCtx(entries);
    await commands["workflow"].handler("", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a4", { summarize: false });
  });

  it("anchors to the response of the last start message when it is the tree anchor", async () => {
    holder.workflow = { rounds: 1, start: ["1"], loop: [{ tree: "1" }] };
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a0", { summarize: false });
  });

  it("retries and reports failure when a message cannot be sent", async () => {
    vi.useFakeTimers();
    try {
      pi.sendUserMessage = vi.fn((content: string) => {
        if (content !== MSG7) {
          const id = String(holder.branch.length);
          holder.branch.push(userEntry(`u${id}`, content));
          holder.branch.push(assistantEntry(`a${id}`));
          holder.state.active = true;
        }
      });
      const ctx = createCtx(fullPhaseA());
      const handlerPromise = commands["workflow"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(16_000);
      await handlerPromise;
      expect(pi.sendUserMessage).toHaveBeenCalledWith(MSG6, { deliverAs: "followUp" });
      expect(pi.sendUserMessage).toHaveBeenCalledWith(MSG7, { deliverAs: "followUp" });
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(4);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Failed to send message 7", "error");
      expect(ctx.navigateTree).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the default working message after completion", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
  });

  it("uses rounds and loop from the configured workflow.json", async () => {
    holder.workflow = {
      rounds: 1,
      start: ["1"],
      loop: [{ tree: "1" }, { send: "6" }],
    };
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6]);
    expect(ctx.navigateTree).toHaveBeenCalledTimes(1);
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("rejects a loop whose first step is not a tree step", async () => {
    holder.workflow = {
      rounds: 1,
      start: [],
      loop: [{ send: "6" }],
    };
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("The first step of the loop must be a tree step (context reset)", "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("warns and falls back to defaults when workflow.json is invalid", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return "not json";
      return JSON.stringify(MESSAGES);
    });
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("workflow.json"), "warning");
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG1, MSG2, MSG3, MSG4, MSG5, MSG6, MSG7, MSG6, MSG7]);
  });

  it("workflow-stop requires interactive mode", async () => {
    const ctx = createCtx([], { hasUI: false });
    await commands["workflow-stop"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/workflow-stop requires interactive mode", "error");
  });

  it("workflow-stop requests cancellation", async () => {
    const ctx = createCtx();
    await commands["workflow-stop"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("stop after the current step"), "info");
  });

  it("stops the workflow when cancellation is requested during a send", async () => {
    vi.useFakeTimers();
    try {
      pi.sendUserMessage = vi.fn((content: string) => {
        if (content !== MSG6) {
          const id = String(holder.branch.length);
          holder.branch.push(userEntry(`u${id}`, content));
          holder.branch.push(assistantEntry(`a${id}`));
          holder.state.active = true;
        }
      });
      const ctx = createCtx(fullPhaseA());
      const handlerPromise = commands["workflow"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(100);
      await commands["workflow-stop"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(100);
      await handlerPromise;
      expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow stopped", "info");
      expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(pi.sendUserMessage).not.toHaveBeenCalledWith(MSG7, { deliverAs: "followUp" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the cancellation request when a new workflow starts", async () => {
    await commands["workflow-stop"].handler("", createCtx());
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7]);
  });
});

describe("/tree-jump command", () => {
  let pi: any;
  let commands: Record<string, any>;

  beforeEach(async () => {
    commands = {};
    pi = {
      registerCommand: vi.fn((name: string, cmd: any) => {
        commands[name] = cmd;
      }),
      sendUserMessage: vi.fn(),
      exec: vi.fn(),
    };
    holder.workflow = structuredClone(DEFAULT_WORKFLOW);
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(holder.workflow);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const mod = await import("../index.js");
    mod.default(pi);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires interactive mode", async () => {
    const ctx = createCtx([], { hasUI: false });
    await commands["tree-jump"].handler("1", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/tree-jump requires interactive mode", "error");
  });

  it("shows usage when no index is provided", async () => {
    const ctx = createCtx();
    await commands["tree-jump"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /tree-jump <number>", "warning");
  });

  it("warns when the message index does not exist", async () => {
    const ctx = createCtx();
    await commands["tree-jump"].handler("99", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Message 99 does not exist.", "warning");
    expect(ctx.navigateTree).not.toHaveBeenCalled();
  });

  it("warns when the message is not present in the session", async () => {
    const ctx = createCtx([]);
    await commands["tree-jump"].handler("2", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Could not find message 2 in the session.", "warning");
    expect(ctx.navigateTree).not.toHaveBeenCalled();
  });

  it("warns when the message is absent from a non-empty session", async () => {
    const ctx = createCtx([userEntry("u1", MSG1), assistantEntry("a1")]);
    await commands["tree-jump"].handler("2", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Could not find message 2 in the session.", "warning");
    expect(ctx.navigateTree).not.toHaveBeenCalled();
  });

  it("navigates to the anchor of the message response", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["tree-jump"].handler("1", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a1", { summarize: false });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Context reset to the response of message 1", "info");
  });

  it("anchors to the response when the message is the last user message", async () => {
    const ctx = createCtx([userEntry("u1", MSG1), assistantEntry("a1")]);
    await commands["tree-jump"].handler("1", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a1", { summarize: false });
  });

  it("notifies when navigation is cancelled", async () => {
    const ctx = createCtx(fullPhaseA(), {
      navigateTree: vi.fn(async () => ({ cancelled: true })),
    });
    await commands["tree-jump"].handler("1", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Navigation cancelled", "warning");
  });

  it("provides completions for message indices", () => {
    const completions = commands["tree-jump"].getArgumentCompletions("1");
    expect(completions).toHaveLength(1);
    expect(completions[0]!.value).toBe("1");
  });
});

describe("getWorkflowConfig", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to defaults when the file is missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const { config, errors } = getWorkflowConfig();
    expect(config.rounds).toBe(2);
    expect(config.start).toEqual(["1", "2", "3", "4", "5"]);
    expect(config.loop[0]).toEqual({ tree: "1" });
    expect(config.loop[1]).toEqual({ cmd: "1" });
    expect(errors).toEqual([]);
  });

  it("reports invalid JSON", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("{{{" as never);
    const { config, errors } = getWorkflowConfig();
    expect(config.rounds).toBe(2);
    expect(errors.some((e) => e.includes("workflow.json"))).toBe(true);
  });

  it("falls back on invalid rounds", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ rounds: 99 }) as never);
    const { config, errors } = getWorkflowConfig();
    expect(config.rounds).toBe(2);
    expect(errors.some((e) => e.includes("rounds"))).toBe(true);
  });

  it("skips invalid loop steps", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        loop: [{ tree: "1" }, { send: "8" }, { bogus: "1" }, { cmd: "" }],
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ tree: "1" }, { send: "8" }]);
    expect(errors).toHaveLength(2);
  });

  it("accepts a valid custom config", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        rounds: 3,
        start: ["1"],
        loop: [{ tree: "1" }, { cmd: "1" }, { send: "5", onlyIfChanges: true }],
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.rounds).toBe(3);
    expect(config.start).toEqual(["1"]);
    expect(config.loop).toEqual([
      { tree: "1" },
      { cmd: "1" },
      { send: "5", onlyIfChanges: true },
    ]);
    expect(errors).toEqual([]);
  });

  it("reports a loop whose first step is not a tree step", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        rounds: 1,
        start: [],
        loop: [{ send: "6" }],
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ send: "6" }]);
    expect(errors.some((e) => e.includes("tree step"))).toBe(true);
  });

  it("rejects onlyIfChanges on tree and cmd steps", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        loop: [
          { tree: "1" },
          { tree: "2", onlyIfChanges: true },
          { cmd: "1", onlyIfChanges: true },
          { send: "6", onlyIfChanges: true },
        ],
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ tree: "1" }, { send: "6", onlyIfChanges: true }]);
    expect(errors).toHaveLength(2);
  });

  it("rejects non-numeric step indices", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        loop: [{ tree: "1" }, { send: "abc" }, { cmd: "x" }],
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ tree: "1" }]);
    expect(errors).toHaveLength(2);
  });
});
