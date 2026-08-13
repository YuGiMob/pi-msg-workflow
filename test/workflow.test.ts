import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { userDataPath } from "../src/user-data.js";
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({}));
vi.mock("@earendil-works/pi-tui", () => ({}));

import { getWorkflowConfig, missingReferences } from "../src/workflow-config.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const MSG1 = "Read the entirety of the codebase";
const MSG2 = "inform me about all of the improvements";
const MSG3 = "Are these improvements actually adding value";
const MSG4 = "Implement all of the changes worth implementing";
const MSG5 = "take a look at the git status and git diff";
const MSG6 = "take a closer look at all of the changes";
const MSG7 = "If your review found any issues with the staged changes, fix them now";
const MSG8 = "So, since the last commit you and my other agent have done a couple changes. I need you to summarize all of the changes so far";
const MSG9 = "Look through the codebase for duplicated logic: the same pattern repeated three or more times that should be extracted into shared helpers";
const MSG10 = "Look through the codebase for unnecessary complexity: over-engineering, dead code, redundant branches, and logic that can be simplified without losing clarity";
const MSG11 = "Look through the codebase for bug risks: edge cases, missing error handling, off-by-one errors, race conditions, and resource leaks";
const MSG12 = "Are these deduplication, simplification, and bug-reduction changes actually adding value? Are they really worth implementing?";
const MSG13 = "Implement all of the deduplication, simplification, and bug-reduction changes worth implementing";
const MSG14 = "Take a closer look at all of the changes in this codebase. You can see the changes via 'git diff --staged'";
const MSG15 = "If your review found any issues with the staged changes, fix them now";
const MSG16 = "Take a look at the git status and git diff to validate that the changes you wanted to make, are the same as the changes you actually did";
const MSG17 = "Since the last commit a couple of changes were made to this codebase. Summarize all of the changes so far";

const MESSAGES = {
  "1": MSG1, "2": MSG2, "3": MSG3, "4": MSG4, "5": MSG5, "6": MSG6, "7": MSG7, "8": MSG8,
  "9": MSG9, "10": MSG10, "11": MSG11, "12": MSG12, "13": MSG13, "14": MSG14, "15": MSG15, "16": MSG16, "17": MSG17,
};
const COMMANDS = { "1": "git add ." };

const DEFAULT_WORKFLOW = {
  rounds: 2,
  start: [{ msg: "1" }, { msg: "2" }, { msg: "3" }, { msg: "4" }, { msg: "5" }],
  loop: [
    { tree: "1" },
    { cmd: "1" },
    { msg: "6" },
    { msg: "7" },
    { msg: "5", onlyIfChanges: true },
    { cmd: "1", onlyIfChanges: true },
  ],
  finally: [{ msg: "8" }],
};

const WORKFLOW2 = {
  rounds: 2,
  start: [{ msg: "9" }, { msg: "10" }, { msg: "11" }, { msg: "12" }, { msg: "13" }],
  loop: [
    { tree: "9" },
    { cmd: "1" },
    { msg: "14" },
    { msg: "15" },
    { msg: "16", onlyIfChanges: true },
    { cmd: "1", onlyIfChanges: true },
  ],
  finally: [{ msg: "17" }],
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

function fullPhaseB() {
  return [
    userEntry("u1", MSG9),
    assistantEntry("a1"),
    userEntry("u2", MSG10),
    assistantEntry("a2"),
    userEntry("u3", MSG11),
    assistantEntry("a3"),
    userEntry("u4", MSG12),
    assistantEntry("a4"),
    userEntry("u5", MSG13),
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
    holder.workflow = structuredClone({ "1": DEFAULT_WORKFLOW });
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

  function blockSendsOf(text: string): void {
    pi.sendUserMessage = vi.fn((content: string) => {
      if (content !== text) {
        const id = String(holder.branch.length);
        holder.branch.push(userEntry(`u${id}`, content));
        holder.branch.push(assistantEntry(`a${id}`));
        holder.state.active = true;
      }
    });
  }

  it("registers the workflow, tree-jump, workflow-stop and workflow-reset commands", () => {
    expect(commands["workflow"]).toBeDefined();
    expect(commands["tree-jump"]).toBeDefined();
    expect(commands["workflow-stop"]).toBeDefined();
    expect(commands["workflow-reset"]).toBeDefined();
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
    expect(sent).toEqual([MSG1, MSG2, MSG3, MSG4, MSG5, MSG6, MSG7, MSG6, MSG7, MSG8]);
  });

  it("waits for pending turns before each send and before detection", async () => {
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    const sends = pi.sendUserMessage.mock.invocationCallOrder;
    const waits = ctx.waitForIdle.mock.invocationCallOrder;
    expect(sends).toHaveLength(10);
    expect(waits).toHaveLength(11);
    for (let i = 0; i < sends.length; i++) {
      expect(waits[i]).toBeLessThan(sends[i]!);
      expect(sends[i]).toBeLessThan(waits[i + 1]!);
    }
  });

  it("skips the start phase when all messages are already present", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG8]);
  });

  it("continues the start phase from where it left off", async () => {
    const entries = [userEntry("u1", MSG1), assistantEntry("a1"), userEntry("u2", MSG2), assistantEntry("a2")];
    const ctx = createCtx(entries);
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG3, MSG4, MSG5, MSG6, MSG7, MSG6, MSG7, MSG8]);
  });

  it("does not skip start messages preceded by unrelated conversation", async () => {
    const entries = [
      userEntry("x1", "unrelated conversation"),
      assistantEntry("x2"),
      userEntry("x3", MSG1),
      assistantEntry("x4"),
    ];
    const ctx = createCtx(entries);
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG1, MSG2, MSG3, MSG4, MSG5, MSG6, MSG7, MSG6, MSG7, MSG8]);
  });

  it("runs cmd steps in the start phase", async () => {
    holder.workflow = { "1": { rounds: 1, start: [{ msg: "1" }, { cmd: "1" }, { msg: "2" }], loop: [{ tree: "1" }], finally: [] } };
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG1, MSG2]);
    expect(pi.exec).toHaveBeenCalledWith("git", ["add", "."]);
  });

  it("resumes the start phase past cmd steps", async () => {
    holder.workflow = { "1": { rounds: 1, start: [{ msg: "1" }, { cmd: "1" }, { msg: "2" }, { msg: "3" }], loop: [{ tree: "1" }], finally: [] } };
    const entries = [userEntry("u1", MSG1), assistantEntry("a1"), userEntry("u2", MSG2), assistantEntry("a2")];
    const ctx = createCtx(entries);
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG3]);
    expect(pi.exec).toHaveBeenCalledTimes(1);
  });

  it("aborts when a start command fails", async () => {
    holder.workflow = { "1": { rounds: 1, start: [{ msg: "1" }, { cmd: "1" }], loop: [{ tree: "1" }] } };
    pi.exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 failed: boom", "error");
    expect(pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("aborts when a start command is missing", async () => {
    holder.workflow = { "1": { rounds: 1, start: [{ cmd: "99" }], loop: [{ tree: "1" }] } };
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Missing commands"), "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("dry run shows cmd steps in the start phase", async () => {
    holder.workflow = { "1": { rounds: 1, start: [{ msg: "1" }, { cmd: "1" }], loop: [{ tree: "1" }] } };
    const ctx = createCtx([]);
    await commands["workflow"].handler("dry", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("start: msg 1: Read the entirety of the codebase, cmd 1: git add ."), "info");
  });

  it("runs cmd steps in the finally section", async () => {
    holder.workflow = { "1": { rounds: 1, start: [], loop: [{ tree: "1" }], finally: [{ cmd: "1" }, { msg: "8" }] } };
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG8]);
    expect(pi.exec).toHaveBeenCalledWith("git", ["add", "."]);
  });

  it("aborts when a finally command fails", async () => {
    holder.workflow = { "1": { rounds: 1, start: [], loop: [{ tree: "1" }], finally: [{ cmd: "1" }] } };
    pi.exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 failed: boom", "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("aborts when a finally message is missing", async () => {
    holder.workflow = { "1": { rounds: 1, start: [], loop: [{ tree: "1" }], finally: [{ msg: "99" }] } };
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Missing messages"), "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
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
    await commands["workflow"].handler("1 3", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(9);
    expect(ctx.navigateTree).toHaveBeenCalledTimes(3);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG6, MSG7, MSG8]);
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
    await commands["workflow"].handler("1 99", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(15);
  });

  it("runs the requested workflow by number", async () => {
    holder.workflow = { "1": structuredClone(DEFAULT_WORKFLOW), "2": structuredClone(WORKFLOW2) };
    const ctx = createCtx(fullPhaseB());
    await commands["workflow"].handler("2", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG14, MSG15, MSG14, MSG15, MSG17]);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a1", { summarize: false });
  });

  it("overrides the rounds of a specific workflow", async () => {
    holder.workflow = { "1": structuredClone(DEFAULT_WORKFLOW), "2": structuredClone(WORKFLOW2) };
    const ctx = createCtx(fullPhaseB());
    await commands["workflow"].handler("2 3", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG14, MSG15, MSG14, MSG15, MSG14, MSG15, MSG17]);
  });

  it("reports a missing workflow", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("9", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Workflow 9 does not exist"), "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("treats a legacy single-workflow file as workflow 1", async () => {
    holder.workflow = structuredClone(DEFAULT_WORKFLOW);
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG8]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("legacy single-workflow"), "warning");
  });

  it("dry run prints the plan without sending or executing anything", async () => {
    const ctx = createCtx([]);
    await commands["workflow"].handler("dry", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Dry run: Workflow 1, 2 rounds"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("start: msg 1: Read the entirety of the codebase"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("msg 5 (if-changes): take a look at the git status and git diff"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cmd 1 (if-changes): git add ."), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tree 1"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("finally: msg 8: So, since the last commit"), "info");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.navigateTree).not.toHaveBeenCalled();
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("dry run accepts --dry-run and a rounds argument", async () => {
    const ctx = createCtx([]);
    await commands["workflow"].handler("1 3 --dry-run", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Dry run: Workflow 1, 3 rounds"), "info");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("dry run still validates missing messages", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(holder.workflow);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ "1": MSG1, "2": MSG2 });
    });
    const ctx = createCtx([]);
    await commands["workflow"].handler("dry", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Missing messages"), "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("reports a command that throws during execution", async () => {
    pi.exec = vi.fn(async () => {
      throw new Error("boom");
    });
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 failed: boom", "error");
    expect(ctx.navigateTree).toHaveBeenCalledTimes(1);
  });

  it("anchors the tree step to the most recent occurrence of the message", async () => {
    const entries = [
      ...fullPhaseA(),
      userEntry("u6", MSG6),
      assistantEntry("a6"),
      userEntry("u7", MSG7),
      assistantEntry("a7"),
      userEntry("u8", MSG1),
      assistantEntry("a8"),
    ];
    const ctx = createCtx(entries);
    await commands["workflow"].handler("", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a8", { summarize: false });
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
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 1, start: [], loop: [{ tree: "1" }, { cmd: "1" }] } });
      if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git commit -m \"my message\"" });
      return JSON.stringify(MESSAGES);
    });
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "my message"]);
  });

  it("aborts on a loop command with an unterminated quote", async () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 1, start: [], loop: [{ tree: "1" }, { cmd: "1" }] } });
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
    expect(sent).toEqual([MSG6, MSG7, MSG5, MSG6, MSG7, MSG5, MSG8]);
  });

  it("skips the validation message when no changes are detected", async () => {
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    const sent = pi.sendUserMessage.mock.calls.map((c: any[]) => c[0]);
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG8]);
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
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG5, MSG8]);
    expect(statusCalls).toBe(4);
  });

  it("runs a cmd step with onlyIfChanges when changes are detected", async () => {
    holder.workflow = { "1": { rounds: 1, start: [], loop: [{ tree: "1" }, { cmd: "1", onlyIfChanges: true }], finally: [] } };
    pi.exec = vi.fn(async (cmd: string, args: string[]) =>
      cmd === "git" && args[0] === "status"
        ? { code: 0, stdout: " M modified.txt", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(pi.exec).toHaveBeenCalledWith("git", ["add", "."]);
  });

  it("skips a cmd step with onlyIfChanges when there are no changes", async () => {
    holder.workflow = { "1": { rounds: 1, start: [], loop: [{ tree: "1" }, { cmd: "1", onlyIfChanges: true }], finally: [] } };
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(pi.exec).toHaveBeenCalledTimes(1);
    expect(pi.exec).toHaveBeenCalledWith("git", ["status", "--porcelain"]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("no changes detected"), "info");
  });

  it("warns and falls back when the tree anchor message is not in the session", async () => {
    holder.workflow = { "1": { rounds: 1, start: [{ msg: "1" }], loop: [{ tree: "2" }, { msg: "6" }], finally: [] } };
    const ctx = createCtx([userEntry("x1", MSG3), assistantEntry("x2")]);
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Message 2 is not in the session"), "warning");
    expect(ctx.navigateTree).toHaveBeenCalledWith("x2", { summarize: false });
    expect(pi.sendUserMessage).toHaveBeenCalledWith(MSG6, { deliverAs: "followUp" });
  });

  it("reports a message that disappears from the store during the run", async () => {
    let userReads = 0;
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(holder.workflow);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      if (String(path).includes("defaults.json")) return JSON.stringify({});
      if (String(path).includes(".config")) {
        userReads++;
        return JSON.stringify(userReads === 2 ? MESSAGES : { ...MESSAGES, "6": undefined });
      }
      return JSON.stringify(MESSAGES);
    });
    const ctx = createCtx(fullPhaseA());
    await commands["workflow"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Message 6 does not exist.", "error");
    expect(pi.sendUserMessage).not.toHaveBeenCalledWith(MSG7, { deliverAs: "followUp" });
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
    holder.workflow = { "1": { rounds: 1, start: [{ msg: "1" }], loop: [{ tree: "1" }] } };
    const ctx = createCtx([]);
    await commands["workflow"].handler("", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a0", { summarize: false });
  });

  it("retries and reports failure when a message cannot be sent", async () => {
    vi.useFakeTimers();
    try {
      blockSendsOf(MSG7);
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
      "1": {
        rounds: 1,
        start: [{ msg: "1" }],
        loop: [{ tree: "1" }, { msg: "6" }],
        finally: [],
      },
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
      "1": {
        rounds: 1,
        start: [],
        loop: [{ msg: "6" }],
      },
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
    expect(sent).toEqual([MSG1, MSG2, MSG3, MSG4, MSG5, MSG6, MSG7, MSG6, MSG7, MSG8]);
  });

  it("workflow-stop requires interactive mode", async () => {
    const ctx = createCtx([], { hasUI: false });
    await commands["workflow-stop"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/workflow-stop requires interactive mode", "error");
  });

  it("workflow-stop requests cancellation", async () => {
    vi.useFakeTimers();
    try {
      blockSendsOf(MSG6);
      const ctx = createCtx(fullPhaseA());
      const handlerPromise = commands["workflow"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(100);
      await commands["workflow-stop"].handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("stop after the current step"), "info");
      await vi.advanceTimersByTimeAsync(100);
      await handlerPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it("workflow-stop reports when no workflow is running", async () => {
    const ctx = createCtx();
    await commands["workflow-stop"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("No workflow is currently running", "info");
  });

  it("refuses to start while another workflow is running", async () => {
    vi.useFakeTimers();
    try {
      blockSendsOf(MSG6);
      const ctx = createCtx(fullPhaseA());
      const first = commands["workflow"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(100);
      await commands["workflow"].handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");
      await commands["workflow-stop"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(100);
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an already-running workflow before config validation", async () => {
    vi.useFakeTimers();
    try {
      blockSendsOf(MSG6);
      const ctx = createCtx(fullPhaseA());
      const first = commands["workflow"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(100);
      vi.mocked(readFileSync).mockReturnValue("not json" as never);
      await commands["workflow"].handler("", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("already running"), "warning");
      expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("workflow.json"), "warning");
      await commands["workflow-stop"].handler("", ctx);
      await vi.advanceTimersByTimeAsync(100);
      await first;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the workflow when cancellation is requested during a send", async () => {
    vi.useFakeTimers();
    try {
      blockSendsOf(MSG6);
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
    expect(sent).toEqual([MSG6, MSG7, MSG6, MSG7, MSG8]);
  });

  it("workflow-reset requires interactive mode", async () => {
    const ctx = createCtx([], { hasUI: false });
    await commands["workflow-reset"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("/workflow-reset requires interactive mode", "error");
  });

  it("workflow-reset copies the packaged defaults and records their checksums", async () => {
    const ctx = createCtx();
    await commands["workflow-reset"].handler("", ctx);
    expect(copyFileSync).toHaveBeenCalledWith(join(PACKAGE_ROOT, "workflow.json"), userDataPath("workflow.json"));
    expect(copyFileSync).toHaveBeenCalledWith(join(PACKAGE_ROOT, "messages.json"), userDataPath("messages.json"));
    expect(copyFileSync).toHaveBeenCalledWith(join(PACKAGE_ROOT, "commands.json"), userDataPath("commands.json"));
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("defaults.json.tmp"),
      expect.stringContaining(sha256(JSON.stringify(holder.workflow))),
      "utf-8",
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reset to the packaged defaults"), "info");
  });

  it("workflow-reset reports when a packaged default is missing", async () => {
    vi.mocked(existsSync).mockImplementation((path: unknown) => String(path).includes(".config"));
    const ctx = createCtx();
    await commands["workflow-reset"].handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Could not reset: workflow.json, messages.json, commands.json", "error");
    expect(copyFileSync).not.toHaveBeenCalled();
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
  it("warns when the message is absent even with other user messages present", async () => {
    const ctx = createCtx([userEntry("u1", MSG1), assistantEntry("a1"), userEntry("u2", MSG2), assistantEntry("a2")]);
    await commands["tree-jump"].handler("3", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Could not find message 3 in the session.", "warning");
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

  it("anchors to the response of the last occurrence of the message", async () => {
    const entries = [
      userEntry("u1", MSG1),
      assistantEntry("a1"),
      userEntry("u2", MSG2),
      assistantEntry("a2"),
      userEntry("u3", MSG1),
      assistantEntry("a3"),
    ];
    const ctx = createCtx(entries);
    await commands["tree-jump"].handler("1", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a3", { summarize: false });
  });

  it("falls back to the previous response when the last occurrence has no response yet", async () => {
    const entries = [
      userEntry("u1", MSG1),
      assistantEntry("a1"),
      userEntry("u2", MSG1),
    ];
    const ctx = createCtx(entries);
    await commands["tree-jump"].handler("1", ctx);
    expect(ctx.navigateTree).toHaveBeenCalledWith("a1", { summarize: false });
  });

  it("falls back to the previous response when the last occurrence is followed by another user message", async () => {
    const entries = [
      userEntry("u1", MSG1),
      assistantEntry("a1"),
      userEntry("u2", MSG1),
      userEntry("u3", MSG2),
    ];
    const ctx = createCtx(entries);
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
    const completions = commands["tree-jump"].getArgumentCompletions("17");
    expect(completions).toHaveLength(1);
    expect(completions[0]!.value).toBe("17");
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
    expect(config.start).toEqual([{ msg: "1" }, { msg: "2" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
    expect(config.finally).toEqual([{ msg: "8" }]);
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

  it("rejects boolean rounds", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ rounds: true }) as never);
    const { config, errors } = getWorkflowConfig();
    expect(config.rounds).toBe(2);
    expect(errors.some((e) => e.includes("rounds"))).toBe(true);
  });

  it("skips invalid loop steps", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        "1": {
          loop: [{ tree: "1" }, { msg: "8" }, { bogus: "1" }, { cmd: "" }],
        },
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ tree: "1" }, { msg: "8" }]);
    expect(errors).toHaveLength(2);
  });

  it("accepts a valid custom config", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        "1": {
          rounds: 3,
          start: [{ msg: "1" }],
          loop: [{ tree: "1" }, { cmd: "1" }, { msg: "5", onlyIfChanges: true }],
          finally: [{ msg: "8" }, { cmd: "1" }],
        },
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.rounds).toBe(3);
    expect(config.start).toEqual([{ msg: "1" }]);
    expect(config.loop).toEqual([
      { tree: "1" },
      { cmd: "1" },
      { msg: "5", onlyIfChanges: true },
    ]);
    expect(config.finally).toEqual([{ msg: "8" }, { cmd: "1" }]);
    expect(errors).toEqual([]);
  });

  it("reports a loop whose first step is not a tree step", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        rounds: 1,
        start: [],
        loop: [{ msg: "6" }],
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ msg: "6" }]);
    expect(errors.some((e) => e.includes("tree step"))).toBe(true);
  });

  it("rejects onlyIfChanges on tree steps but accepts it on cmd steps", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        "1": {
          loop: [
            { tree: "1" },
            { tree: "2", onlyIfChanges: true },
            { cmd: "1", onlyIfChanges: true },
            { msg: "6", onlyIfChanges: true },
          ],
        },
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ tree: "1" }, { cmd: "1", onlyIfChanges: true }, { msg: "6", onlyIfChanges: true }]);
    expect(errors).toHaveLength(1);
  });

  it("rejects non-numeric step indices", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        "1": {
          loop: [{ tree: "1" }, { msg: "abc" }, { cmd: "x" }],
        },
      }) as never,
    );
    const { config, errors } = getWorkflowConfig();
    expect(config.loop).toEqual([{ tree: "1" }]);
    expect(errors).toHaveLength(2);
  });
});

describe("missingReferences", () => {
  it("reports referenced messages and commands that are missing", () => {
    const config = {
      rounds: 1,
      start: [{ msg: "1" }, { cmd: "1" }],
      loop: [{ tree: "2" }, { msg: "6" }, { cmd: "2" }],
      finally: [{ msg: "8" }],
    };
    const result = missingReferences(config, { "1": "x", "8": "y" }, { "1": "z" });
    expect(result.messages).toEqual(["2", "6"]);
    expect(result.commands).toEqual(["2"]);
  });

  it("reports nothing when every reference exists", () => {
    const config = { rounds: 1, start: [{ msg: "1" }], loop: [{ tree: "1" }, { cmd: "1" }], finally: [] };
    const result = missingReferences(config, { "1": "x" }, { "1": "y" });
    expect(result.messages).toEqual([]);
    expect(result.commands).toEqual([]);
  });
});
