import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({}));

vi.mock("@earendil-works/pi-tui", () => ({
  Key: {
    tab: "\t",
    escape: "\x1b",
    enter: "\r",
    backspace: "\x7f",
    delete: "\x1b[3~",
    home: "\x1b[H",
    end: "\x1b[F",
    up: "\x1b[A",
    down: "\x1b[B",
    left: "\x1b[D",
    right: "\x1b[C",
    shift: (key: string) => `shift-${key}`,
  },
  matchesKey: (data: string, key: any) => {
    if (key === "\t") return data === "\t";
    if (key === "\x1b") return data === "\x1b";
    if (key === "\r") return data === "\r";
    if (key === "\x7f") return data === "\x7f";
    if (key === "\x1b[3~") return data === "\x1b[3~";
    if (key === "\x1b[H") return data === "\x1b[H";
    if (key === "\x1b[F") return data === "\x1b[F";
    if (key === "\x1b[A") return data === "\x1b[A";
    if (key === "\x1b[B") return data === "\x1b[B";
    if (key === "\x1b[D") return data === "\x1b[D";
    if (key === "\x1b[C") return data === "\x1b[C";
    if (key === "shift-tab") return data === "\x1b[Z";
    if (key === "shift+j") return data === "J" || data === "\x1b[74;2u";
    if (key === "shift+k") return data === "K" || data === "\x1b[75;2u";
    if (typeof key === "string" && key.length === 1) {
      return data === key || data === `\x1b[${key.charCodeAt(0)};1u`;
    }
    return false;
  },
  decodeKittyPrintable: (data: string) => {
    const match = data.match(/^\x1b\[(\d+);1u$/);
    if (!match) return undefined;
    return String.fromCharCode(Number(match[1]));
  },
  visibleWidth: vi.fn((s: string) => s.length),
}));

import { visibleWidth } from "@earendil-works/pi-tui";
import { WorkflowTab, MessagesTab, CommandsTab, WorkflowEditorOverlay, deepEqual } from "../src/workflow-editor.js";

const MSG1 = "Read the entirety of the codebase";
const MSG2 = "inform me about all of the improvements";
const MSG3 = "Are these improvements actually adding value";
const MSG4 = "Implement all of the changes worth implementing";
const MSG5 = "take a look at the git status and git diff";
const MSG6 = "take a closer look at all of the changes";
const MSG7 = "If your review found any issues with the staged changes, fix them now";
const MSG8 = "So, since the last commit you and my other agent have done a couple changes. I need you to summarize all of the changes so far";

const MESSAGES = { "1": MSG1, "2": MSG2, "3": MSG3, "4": MSG4, "5": MSG5, "6": MSG6, "7": MSG7, "8": MSG8 };
const COMMANDS = { "1": "git add ." };

const WORKFLOW_JSON = {
  "1": {
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
  },
  "2": {
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
  },
};

function type(tab: { handleInput(data: string): boolean }, text: string): void {
  for (const ch of text) tab.handleInput(ch);
}

function createTheme() {
  return {
    fg: vi.fn((_color: string, text: string) => text),
    bg: vi.fn((_color: string, text: string) => text),
    bold: vi.fn((text: string) => text),
  };
}

function setupFs() {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockImplementation((path: unknown) => {
    if (String(path).includes("defaults.json")) return JSON.stringify({ "workflow.json": "recorded", "messages.json": "recorded", "commands.json": "recorded" });
    if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
    if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
    return JSON.stringify(MESSAGES);
  });
}

describe("deepEqual", () => {
  it("distinguishes arrays from objects with the same keys", () => {
    expect(deepEqual([], {})).toBe(false);
    expect(deepEqual(["1"], { "0": "1" })).toBe(false);
  });

  it("compares arrays by position and value", () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  it("compares nested arrays", () => {
    expect(deepEqual({ a: [1] }, { a: [1] })).toBe(true);
    expect(deepEqual({ a: [1] }, { a: { "0": 1 } })).toBe(false);
  });
});

describe("WorkflowTab", () => {
  let theme: ReturnType<typeof createTheme>;
  let notify: any;
  let tab: WorkflowTab;

  beforeEach(() => {
    theme = createTheme();
    notify = vi.fn();
    setupFs();
    tab = new WorkflowTab(theme as any, notify);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads the configured workflow into the draft", () => {
    expect(tab.draft.rounds).toBe(2);
    expect(tab.draft.start).toEqual([{ msg: "1" }, { msg: "2" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
    expect(tab.draft.tree).toBe("1");
    expect(tab.draft.loop).toEqual([
      { cmd: "1" },
      { msg: "6" },
      { msg: "7" },
      { msg: "5", onlyIfChanges: true },
      { cmd: "1", onlyIfChanges: true },
    ]);
    expect(tab.draft.finally).toEqual([{ msg: "8" }]);
    expect(tab.dirty).toBe(false);
  });

  it("repairs a misplaced tree step when loading", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 2, start: [], loop: [{ msg: "6" }, { tree: "1" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    expect(tab.draft.tree).toBe("1");
    expect(tab.draft.loop).toEqual([{ msg: "6" }]);
    expect(tab.getAboveContentLine(80)[0]).toContain("moved to the start of the loop");
  });

  it("keeps additional tree steps when repairing a misplaced one", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 2, start: [], loop: [{ msg: "6" }, { tree: "1" }, { tree: "2" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    expect(tab.draft.tree).toBe("1");
    expect(tab.draft.loop).toEqual([{ msg: "6" }, { tree: "2" }]);
    expect(tab.getAboveContentLine(80)[0]).toContain("moved to the start of the loop");
  });

  it("renders embedded tree steps in the loop", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 2, start: [], loop: [{ tree: "1" }, { tree: "2" }, { msg: "6" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    const lines = tab.render(78, 12).join("\n");
    expect(lines).toContain("tree → 2");
  });

  it("edits an embedded tree step index", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 2, start: [], loop: [{ tree: "1" }, { tree: "2" }, { msg: "6" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("3");
    tab.handleInput("\r");
    expect(tab.draft.loop[0]).toEqual({ tree: "3" });
    expect(tab.dirty).toBe(true);
  });

  it("refuses to load a workflow without a tree step", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 2, start: [{ msg: "1" }], loop: [{ msg: "6" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    expect(tab.draft.start).toEqual([]);
    expect(tab.getAboveContentLine(80)[0]).toContain("no tree step");
  });

  it("repairs a misplaced tree step when switching workflows", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": WORKFLOW_JSON["1"], "2": { rounds: 2, start: [], loop: [{ msg: "6" }, { tree: "1" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    tab.handleInput("w");
    type(tab, "2");
    tab.handleInput("\r");
    expect((tab as any).index).toBe("2");
    expect(tab.draft.tree).toBe("1");
    expect(tab.draft.loop).toEqual([{ msg: "6" }]);
    expect(tab.getAboveContentLine(80)[0]).toContain("moved to the start of the loop");
  });

  it("keeps the current workflow when the target has no tree step", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": WORKFLOW_JSON["1"], "2": { rounds: 2, start: [], loop: [{ msg: "6" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    tab.handleInput("w");
    type(tab, "2");
    tab.handleInput("\r");
    expect((tab as any).index).toBe("1");
    expect(tab.draft.start).toEqual([{ msg: "1" }, { msg: "2" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
    expect(tab.getAboveContentLine(80)[0]).toContain("no tree step");
  });

  it("refuses to save when the workflow could not be loaded", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("defaults.json")) return JSON.stringify({ "workflow.json": "recorded", "messages.json": "recorded", "commands.json": "recorded" });
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 2, start: [{ msg: "1" }], loop: [{ msg: "6" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    tab.save();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(tab.getAboveContentLine(80)[0]).toContain("no tree step");
  });

  it("allows saving again after switching to a loadable workflow", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("defaults.json")) return JSON.stringify({ "workflow.json": "recorded", "messages.json": "recorded", "commands.json": "recorded" });
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": WORKFLOW_JSON["1"], "2": { rounds: 2, start: [], loop: [{ msg: "6" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    tab.handleInput("w");
    type(tab, "2");
    tab.handleInput("\r");
    tab.save();
    expect(writeFileSync).not.toHaveBeenCalled();
    tab.handleInput("w");
    type(tab, "1");
    tab.handleInput("\r");
    tab.save();
    expect(writeFileSync).toHaveBeenCalled();
  });

  it("edits the tree anchor index", () => {
    for (let i = 0; i < 5; i++) tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("3");
    tab.handleInput("\r");
    expect(tab.draft.tree).toBe("3");
    expect(tab.dirty).toBe(true);
  });

  it("rejects a non-numeric tree index", () => {
    for (let i = 0; i < 5; i++) tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("x");
    tab.handleInput("\r");
    expect(tab.draft.tree).toBe("1");
    expect(tab.dirty).toBe(false);
    expect(tab.getAboveContentLine(80)[0]).toContain("Index must be a number");
  });

  it("edits a start msg index", () => {
    tab.handleInput("e");
    tab.handleInput("9");
    tab.handleInput("\r");
    expect(tab.draft.start[0]).toEqual({ msg: "9" });
  });

  it("edits a msg step index", () => {
    for (let i = 0; i < 7; i++) tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("7");
    tab.handleInput("\r");
    expect(tab.draft.loop[1]).toEqual({ msg: "7" });
  });

  it("edits a cmd step index", () => {
    for (let i = 0; i < 6; i++) tab.handleInput("j");
    tab.handleInput("e");
    type(tab, "2");
    tab.handleInput("\r");
    expect(tab.draft.loop[0]).toEqual({ cmd: "2" });
  });

  it("adds a msg step", () => {
    for (let i = 0; i < 7; i++) tab.handleInput("j");
    tab.handleInput("a");
    type(tab, "msg 4");
    tab.handleInput("\r");
    expect(tab.draft.loop[tab.draft.loop.length - 1]).toEqual({ msg: "4" });
    expect(tab.draft.loop).toHaveLength(6);
  });

  it("adds a cmd step", () => {
    for (let i = 0; i < 7; i++) tab.handleInput("j");
    tab.handleInput("a");
    type(tab, "cmd 2");
    tab.handleInput("\r");
    expect(tab.draft.loop[tab.draft.loop.length - 1]).toEqual({ cmd: "2" });
  });

  it("adds a start step", () => {
    tab.handleInput("a");
    type(tab, "msg 4");
    tab.handleInput("\r");
    expect(tab.draft.start[tab.draft.start.length - 1]).toEqual({ msg: "4" });
  });

  it("adds a cmd step to the start phase", () => {
    tab.handleInput("a");
    type(tab, "cmd 2");
    tab.handleInput("\r");
    expect(tab.draft.start[tab.draft.start.length - 1]).toEqual({ cmd: "2" });
  });

  it("rejects an invalid added start step", () => {
    tab.handleInput("a");
    type(tab, "bogus");
    tab.handleInput("\r");
    expect(tab.draft.start).toHaveLength(5);
    expect(tab.getAboveContentLine(80)[0]).toContain("Expected: msg <number> or cmd <number>");
  });

  it("edits a start cmd index", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ ...WORKFLOW_JSON, start: [{ msg: "1" }, { cmd: "1" }] });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    tab.handleInput("j");
    tab.handleInput("e");
    type(tab, "2");
    tab.handleInput("\r");
    expect(tab.draft.start[1]).toEqual({ cmd: "2" });
  });

  it("saves start cmd steps to workflow.json", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("defaults.json")) return JSON.stringify({ "workflow.json": "recorded", "messages.json": "recorded", "commands.json": "recorded" });
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git add .", "2": "git status --porcelain" });
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    tab.handleInput("a");
    type(tab, "cmd 2");
    tab.handleInput("\r");
    tab.save();
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(written["1"].start[written["1"].start.length - 1]).toEqual({ cmd: "2" });
  });

  it("adds a finally step", () => {
    for (let i = 0; i < 11; i++) tab.handleInput("j");
    tab.handleInput("a");
    type(tab, "msg 4");
    tab.handleInput("\r");
    expect(tab.draft.finally[tab.draft.finally.length - 1]).toEqual({ msg: "4" });
  });

  it("edits a finally msg index", () => {
    for (let i = 0; i < 11; i++) tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("9");
    tab.handleInput("\r");
    expect(tab.draft.finally[0]).toEqual({ msg: "9" });
  });

  it("deletes a finally step", () => {
    for (let i = 0; i < 11; i++) tab.handleInput("j");
    tab.handleInput("x");
    expect(tab.draft.finally).toEqual([]);
    expect(tab.dirty).toBe(true);
  });

  it("moves a finally step", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ ...WORKFLOW_JSON, finally: [{ msg: "8" }, { cmd: "1" }] });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    for (let i = 0; i < 11; i++) tab.handleInput("j");
    tab.handleInput("J");
    expect(tab.draft.finally[0]).toEqual({ cmd: "1" });
    expect(tab.draft.finally[1]).toEqual({ msg: "8" });
  });

  it("refuses if-changes on a finally step", () => {
    for (let i = 0; i < 11; i++) tab.handleInput("j");
    tab.handleInput("t");
    expect(tab.draft.finally[0]).toEqual({ msg: "8" });
    expect(tab.getAboveContentLine(80)[0]).toContain("if-changes applies to loop msg and cmd steps");
  });
  it("refuses if-changes on a tree step embedded in the loop", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ "1": { rounds: 2, start: [], loop: [{ tree: "1" }, { tree: "2" }, { msg: "6" }], finally: [] } });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    tab.handleInput("j");
    tab.handleInput("t");
    expect(tab.draft.loop[0]).toEqual({ tree: "2" });
    expect(tab.dirty).toBe(false);
  });

  it("saves finally steps to workflow.json", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("defaults.json")) return JSON.stringify({ "workflow.json": "recorded", "messages.json": "recorded", "commands.json": "recorded" });
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git add .", "2": "git status --porcelain" });
      return JSON.stringify(MESSAGES);
    });
    const tab = new WorkflowTab(theme as any, notify);
    for (let i = 0; i < 11; i++) tab.handleInput("j");
    tab.handleInput("a");
    type(tab, "cmd 2");
    tab.handleInput("\r");
    tab.save();
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(written["1"].finally[written["1"].finally.length - 1]).toEqual({ cmd: "2" });
  });

  it("rejects an invalid added step", () => {
    for (let i = 0; i < 7; i++) tab.handleInput("j");
    tab.handleInput("a");
    type(tab, "bogus");
    tab.handleInput("\r");
    expect(tab.draft.loop).toHaveLength(5);
    expect(tab.getAboveContentLine(80)[0]).toContain("Expected: msg <number> or cmd <number>");
  });

  it("cannot add a step on the tree row", () => {
    for (let i = 0; i < 5; i++) tab.handleInput("j");
    tab.handleInput("a");
    expect(tab.getAboveContentLine(80)[0]).toContain("tree step is fixed");
    expect(tab.draft.loop).toHaveLength(5);
  });

  it("deletes a loop step", () => {
    for (let i = 0; i < 6; i++) tab.handleInput("j");
    tab.handleInput("x");
    expect(tab.draft.loop).toHaveLength(4);
    expect(tab.dirty).toBe(true);
  });

  it("cannot delete the tree step", () => {
    for (let i = 0; i < 5; i++) tab.handleInput("j");
    tab.handleInput("x");
    expect(tab.draft.tree).toBe("1");
    expect(tab.getAboveContentLine(80)[0]).toContain("tree step is fixed");
  });

  it("moves a start row down", () => {
    tab.handleInput("J");
    expect(tab.draft.start).toEqual([{ msg: "2" }, { msg: "1" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
  });

  it("moves a loop row down", () => {
    for (let i = 0; i < 6; i++) tab.handleInput("j");
    tab.handleInput("J");
    expect(tab.draft.loop[0]).toEqual({ msg: "6" });
    expect(tab.draft.loop[1]).toEqual({ cmd: "1" });
  });

  it("cannot move the tree step", () => {
    for (let i = 0; i < 5; i++) tab.handleInput("j");
    tab.handleInput("J");
    expect(tab.draft.loop[0]).toEqual({ cmd: "1" });
    expect(tab.getAboveContentLine(80)[0]).toContain("tree step is fixed");
  });

  it("toggles if-changes on a msg step", () => {
    for (let i = 0; i < 7; i++) tab.handleInput("j");
    tab.handleInput("t");
    expect(tab.draft.loop[1]).toEqual({ msg: "6", onlyIfChanges: true });
    tab.handleInput("t");
    expect(tab.draft.loop[1]).toEqual({ msg: "6" });
  });

  it("toggles if-changes on a cmd step", () => {
    for (let i = 0; i < 6; i++) tab.handleInput("j");
    tab.handleInput("t");
    expect(tab.draft.loop[0]).toEqual({ cmd: "1", onlyIfChanges: true });
    tab.handleInput("t");
    expect(tab.draft.loop[0]).toEqual({ cmd: "1" });
  });

  it("adjusts and clamps rounds", () => {
    tab.handleInput("[");
    expect(tab.draft.rounds).toBe(1);
    for (let i = 0; i < 9; i++) tab.handleInput("]");
    expect(tab.draft.rounds).toBe(5);
    for (let i = 0; i < 9; i++) tab.handleInput("[");
    expect(tab.draft.rounds).toBe(1);
  });

  it("saves the workflow to workflow.json", () => {
    for (let i = 0; i < 5; i++) tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("2");
    tab.handleInput("\r");
    tab.save();
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining("workflow.json.tmp"), expect.any(String), "utf-8");
    expect(renameSync).toHaveBeenCalledWith(expect.stringContaining("workflow.json.tmp"), expect.stringContaining("workflow.json"));
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(written["1"].rounds).toBe(2);
    expect(written["1"].loop[0]).toEqual({ tree: "2" });
    expect(written["1"].loop[1]).toEqual({ cmd: "1" });
    expect(written["1"].finally).toEqual([{ msg: "8" }]);
    expect(written["2"]).toEqual(WORKFLOW_JSON["2"]);
    expect(tab.dirty).toBe(false);
    expect(notify).toHaveBeenCalledWith("workflow.json saved", "info");
  });

  it("refuses to save when a referenced message is missing", () => {
    for (let i = 0; i < 5; i++) tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("9");
    tab.handleInput("9");
    tab.handleInput("\r");
    tab.save();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(tab.getAboveContentLine(80)[0]).toContain("Missing messages: 99 - add and save them in the Messages tab first");
    expect(tab.dirty).toBe(true);
  });

  it("refuses to save when a referenced command is missing", () => {
    for (let i = 0; i < 6; i++) tab.handleInput("j");
    tab.handleInput("e");
    tab.handleInput("9");
    tab.handleInput("\r");
    tab.save();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(tab.getAboveContentLine(80)[0]).toContain("Missing commands: 9 - add and save them in the Commands tab first");
    expect(tab.dirty).toBe(true);
  });

  it("reports a failed workflow save", () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    tab.save();
    expect(tab.getAboveContentLine(80)[0]).toContain("Could not save workflow.json");
  });

  it("cancels input mode with escape", () => {
    tab.handleInput("e");
    tab.handleInput("9");
    tab.handleInput("\x1b");
    expect(tab.draft.start[0]).toEqual({ msg: "1" });
    expect(tab.dirty).toBe(false);
  });

  it("moves selection with j sent as a Kitty CSI-u sequence", () => {
    tab.handleInput("\x1b[106;1u");
    expect((tab as any).selection).toBe(1);
  });

  it("moves a row with J sent as a Kitty CSI-u sequence", () => {
    tab.handleInput("\x1b[74;2u");
    expect(tab.draft.start).toEqual([{ msg: "2" }, { msg: "1" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
  });

  it("undoes a deleted step", () => {
    for (let i = 0; i < 6; i++) tab.handleInput("j");
    tab.handleInput("x");
    expect(tab.draft.loop).toHaveLength(4);
    tab.handleInput("u");
    expect(tab.draft.loop).toHaveLength(5);
    expect(tab.draft.loop[0]).toEqual({ cmd: "1" });
    expect(tab.dirty).toBe(false);
  });
  it("undoes an edited step index", () => {
    tab.handleInput("e");
    tab.handleInput("9");
    tab.handleInput("\r");
    expect(tab.draft.start[0]).toEqual({ msg: "9" });
    tab.handleInput("u");
    expect(tab.draft.start[0]).toEqual({ msg: "1" });
  });
  it("undoes a rounds change", () => {
    tab.handleInput("]");
    expect(tab.draft.rounds).toBe(3);
    tab.handleInput("u");
    expect(tab.draft.rounds).toBe(2);
  });
  it("does not push an undo slot or mark dirty when rounds are already at the limit", () => {
    tab.handleInput("[");
    tab.handleInput("[");
    tab.handleInput("u");
    expect(tab.draft.rounds).toBe(2);
    expect(tab.dirty).toBe(false);
  });
  it("undoes an added step", () => {
    for (let i = 0; i < 7; i++) tab.handleInput("j");
    tab.handleInput("a");
    type(tab, "msg 4");
    tab.handleInput("\r");
    expect(tab.draft.loop).toHaveLength(6);
    tab.handleInput("u");
    expect(tab.draft.loop).toHaveLength(5);
  });
  it("flashes when there is nothing to undo", () => {
    tab.handleInput("u");
    expect(tab.getAboveContentLine(80)[0]).toContain("Nothing to undo");
  });
  it("does not consume an undo slot when a move is refused", () => {
    tab.handleInput("J");
    tab.handleInput("K");
    tab.handleInput("K");
    tab.handleInput("u");
    expect(tab.draft.start).toEqual([{ msg: "2" }, { msg: "1" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
  });
  it("restores the selection when undoing", () => {
    for (let i = 0; i < 11; i++) tab.handleInput("j");
    tab.handleInput("x");
    expect((tab as any).selection).toBe(10);
    tab.handleInput("u");
    expect((tab as any).selection).toBe(11);
  });
  it("clears the dirty flag when undoing back to the saved state", () => {
    tab.handleInput("e");
    tab.handleInput("2");
    tab.handleInput("\r");
    expect(tab.dirty).toBe(true);
    tab.handleInput("u");
    expect(tab.dirty).toBe(false);
  });
  it("keeps the tab dirty when undoing past a save", () => {
    tab.handleInput("e");
    tab.handleInput("2");
    tab.handleInput("\r");
    tab.save();
    expect(tab.dirty).toBe(false);
    tab.handleInput("u");
    expect(tab.dirty).toBe(true);
  });
  it("renders rows with previews", () => {
    const lines = tab.render(78, 20);
    expect(lines[0]).toContain("Rounds: 2");
    expect(lines.join("\n")).toContain("tree → 1");
    expect(lines.join("\n")).toContain(`msg 6: ${MSG6}`);
    expect(lines.join("\n")).toContain(`msg 5 [if-changes]: ${MSG5}`);
    expect(lines.join("\n")).toContain("cmd 1: git add .");
    expect(lines.join("\n")).toContain("cmd 1 [if-changes]: git add .");
  });

  it("renders the finally section", () => {
    const lines = tab.render(78, 20);
    expect(lines.join("\n")).toContain(" finally");
    expect(lines.join("\n")).toContain("msg 8");
  });
  it("renders the tree row with a message preview", () => {
    const lines = tab.render(78, 12);
    expect(lines.join("\n")).toContain(`tree → 1: ${MSG1}`);
  });
  it("shows the full message preview up to the window edge", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ ...MESSAGES, "1": "a".repeat(60) });
    });
    const lines = tab.render(78, 12);
    expect(lines.join("\n")).toContain("a".repeat(60));
  });

  it("truncates rows to the visible width for wide characters", () => {
    vi.mocked(visibleWidth).mockImplementation((s: string) => [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e7f ? 2 : 1), 0));
    try {
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
        if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
        return JSON.stringify({ ...MESSAGES, "1": "界".repeat(100) });
      });
      const lines = tab.render(78, 12);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(78);
      }
    } finally {
      vi.mocked(visibleWidth).mockImplementation((s: string) => s.length);
    }
  });

  it("switches to another workflow with w", () => {
    tab.handleInput("w");
    type(tab, "2");
    tab.handleInput("\r");
    expect((tab as any).index).toBe("2");
    expect(tab.name).toBe("Workflow 2");
    expect(tab.draft.start).toEqual([{ msg: "9" }, { msg: "10" }, { msg: "11" }, { msg: "12" }, { msg: "13" }]);
    expect(tab.draft.tree).toBe("9");
    expect(tab.draft.loop[0]).toEqual({ cmd: "1" });
    expect(tab.draft.finally).toEqual([{ msg: "17" }]);
    expect(tab.dirty).toBe(false);
  });

  it("creates a new workflow by switching to an unused number", () => {
    tab.handleInput("w");
    type(tab, "7");
    tab.handleInput("\r");
    expect((tab as any).index).toBe("7");
    expect(tab.draft.start).toEqual([{ msg: "1" }, { msg: "2" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
    expect(tab.draft.loop[0]).toEqual({ cmd: "1" });
    expect(tab.draft.tree).toBe("1");
    expect(tab.getAboveContentLine(80)[0]).toContain("press s to create it");
  });

  it("rejects a non-numeric workflow number", () => {
    tab.handleInput("w");
    type(tab, "x");
    tab.handleInput("\r");
    expect((tab as any).index).toBe("1");
    expect(tab.getAboveContentLine(80)[0]).toContain("Workflow number must be a number");
  });

  it("refuses to switch workflows with unsaved changes", () => {
    tab.handleInput("e");
    type(tab, "9");
    tab.handleInput("\r");
    tab.handleInput("w");
    expect((tab as any).index).toBe("1");
    expect(tab.getAboveContentLine(80)[0]).toContain("Save or undo your changes before switching workflows");
  });

  it("saves a new workflow without touching the others", () => {
    tab.handleInput("w");
    type(tab, "7");
    tab.handleInput("\r");
    tab.handleInput("a");
    type(tab, "msg 4");
    tab.handleInput("\r");
    tab.save();
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(written["7"].start[written["7"].start.length - 1]).toEqual({ msg: "4" });
    expect(written["7"].loop[0]).toEqual({ tree: "1" });
    expect(written["7"].rounds).toBe(2);
    expect(written["1"]).toEqual(WORKFLOW_JSON["1"]);
    expect(written["2"]).toEqual(WORKFLOW_JSON["2"]);
  });

  it("deletes the current workflow after confirmation", () => {
    tab.handleInput("w");
    type(tab, "2");
    tab.handleInput("\r");
    tab.handleInput("d");
    type(tab, "y");
    tab.handleInput("\r");
    expect((tab as any).index).toBe("1");
    expect(tab.draft.start).toEqual([{ msg: "1" }, { msg: "2" }, { msg: "3" }, { msg: "4" }, { msg: "5" }]);
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(written["2"]).toBeUndefined();
    expect(written["1"]).toEqual(WORKFLOW_JSON["1"]);
    expect(tab.dirty).toBe(false);
  });

  it("keeps the workflow when deletion is not confirmed", () => {
    tab.handleInput("w");
    type(tab, "2");
    tab.handleInput("\r");
    tab.handleInput("d");
    type(tab, "n");
    tab.handleInput("\r");
    expect((tab as any).index).toBe("2");
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses to delete a workflow that does not exist", () => {
    tab.handleInput("w");
    type(tab, "7");
    tab.handleInput("\r");
    tab.handleInput("d");
    expect(tab.getAboveContentLine(80)[0]).toContain("nothing to delete");
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});

describe("MessagesTab", () => {
  let theme: ReturnType<typeof createTheme>;
  let notify: any;
  let tab: MessagesTab;

  beforeEach(() => {
    theme = createTheme();
    notify = vi.fn();
    setupFs();
    tab = new MessagesTab(theme as any, notify);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads messages into the draft", () => {
    expect(tab.draft).toEqual(MESSAGES);
    expect(tab.keys).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("edits a message", () => {
    tab.handleInput("e");
    type(tab, "New content here");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("New content here");
    expect(tab.dirty).toBe(true);
  });

  it("rejects short content", () => {
    tab.handleInput("e");
    type(tab, "ab");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe(MSG1);
    expect(tab.getAboveContentLine(80)[0]).toContain("at least 5 characters");
  });

  it("keeps the input open when the commit is rejected", () => {
    tab.handleInput("e");
    type(tab, "ab");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe(MSG1);
    expect(tab.getAboveContentLine(80)[0]).toContain("at least 5 characters");
    expect(tab.getAboveContentLine(80)[1]).toContain("content for message 1");
    type(tab, "cde");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("abcde");
  });

  it("adds a message with the next free index", () => {
    tab.handleInput("a");
    type(tab, "Brand new message");
    tab.handleInput("\r");
    expect(tab.draft["9"]).toBe("Brand new message");
    expect(tab.keys).toContain("9");
  });

  it("adds a message after non-numeric keys", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ "1": "first", "abc": "other" });
    });
    const tab = new MessagesTab(theme as any, notify);
    tab.handleInput("a");
    type(tab, "Brand new message");
    tab.handleInput("\r");
    expect(tab.draft["2"]).toBe("Brand new message");
  });

  it("deletes a message", () => {
    tab.handleInput("x");
    expect(tab.draft["1"]).toBeUndefined();
    expect(tab.keys).toEqual(["2", "3", "4", "5", "6", "7", "8"]);
    expect(tab.dirty).toBe(true);
  });

  it("saves messages to messages.json", () => {
    tab.handleInput("a");
    type(tab, "Brand new message");
    tab.handleInput("\r");
    tab.handleInput("x");
    tab.save();
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining("messages.json"), expect.any(String), "utf-8");
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(written).toEqual(MESSAGES);
    expect(tab.dirty).toBe(false);
    expect(notify).toHaveBeenCalledWith("messages.json saved", "info");
  });

  it("refuses to save when a message used by the workflow is deleted", () => {
    tab.handleInput("x");
    tab.save();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(tab.getAboveContentLine(80)[0]).toContain("Messages still used by the workflow: 1 - remove and save them in the Workflow");
    expect(tab.getAboveContentLine(80)[0]).not.toContain("tab first");
    expect(tab.dirty).toBe(true);
  });

  it("reports a failed messages save", () => {
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    tab.save();
    expect(tab.getAboveContentLine(80)[0]).toContain("Could not save messages.json");
  });

  it("pastes multi-character content into the input", () => {
    tab.handleInput("e");
    tab.handleInput("\x1b[200~Pasted message content\x1b[201~");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("Pasted message content");
    expect(tab.dirty).toBe(true);
  });

  it("flattens line breaks in pasted content", () => {
    tab.handleInput("e");
    tab.handleInput("\x1b[200~line one\nline two\x1b[201~");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("line one line two");
  });

  it("wraps a long pasted input onto extra lines so all content stays visible", () => {
    tab.handleInput("a");
    const pasted = "x".repeat(200);
    tab.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    const lines = tab.getAboveContentLine(80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toContain(pasted);
    expect(lines[lines.length - 1]!.endsWith("▏")).toBe(true);
    expect(lines.join("")).not.toContain("…");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  it("wraps a long input with the cursor in the middle and shows it all", () => {
    tab.handleInput("a");
    tab.handleInput(`\x1b[200~${"x".repeat(100)}${"y".repeat(100)}\x1b[201~`);
    tab.handleInput("\x1b[H");
    const lines = tab.getAboveContentLine(80);
    const joined = lines.join("");
    expect(joined).toContain("▏");
    expect(joined).toContain("x".repeat(100) + "y".repeat(100));
    expect(joined).not.toContain("…");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  it("keeps a short input line on a single line", () => {
    tab.handleInput("a");
    tab.handleInput("\x1b[200~short content\x1b[201~");
    const lines = tab.getAboveContentLine(80);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("short content▏");
    expect(lines[0]).not.toContain("…");
  });

  it("inserts at the cursor position with arrow keys", () => {
    tab.handleInput("e");
    type(tab, "abcde");
    tab.handleInput("\x1b[D");
    tab.handleInput("\x1b[D");
    type(tab, "X");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("abcXde");
  });
  it("moves the cursor with home and end", () => {
    tab.handleInput("e");
    type(tab, "bcdef");
    tab.handleInput("\x1b[H");
    type(tab, "a");
    tab.handleInput("\x1b[F");
    type(tab, "g");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("abcdefg");
  });
  it("deletes at the cursor with delete and backspace", () => {
    tab.handleInput("e");
    type(tab, "abcdefg");
    tab.handleInput("\x1b[H");
    tab.handleInput("\x1b[3~");
    expect(tab.getAboveContentLine(80)[0]).toContain("▏bcdefg");
    tab.handleInput("\x1b[F");
    tab.handleInput("\x7f");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("bcdef");
  });
  it("renders the cursor at the cursor position", () => {
    tab.handleInput("e");
    type(tab, "ab");
    tab.handleInput("\x1b[D");
    expect(tab.getAboveContentLine(80)[0]).toContain("a▏b");
  });
  it("undoes a deleted message", () => {
    tab.handleInput("x");
    expect(tab.draft["1"]).toBeUndefined();
    tab.handleInput("u");
    expect(tab.draft["1"]).toBe(MSG1);
    expect(tab.keys).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(tab.dirty).toBe(false);
  });
  it("undoes an edited message", () => {
    tab.handleInput("e");
    type(tab, "New content here");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("New content here");
    tab.handleInput("u");
    expect(tab.draft["1"]).toBe(MSG1);
  });
  it("undoes an added message", () => {
    tab.handleInput("a");
    type(tab, "Brand new message");
    tab.handleInput("\r");
    expect(tab.draft["9"]).toBe("Brand new message");
    tab.handleInput("u");
    expect(tab.draft["9"]).toBeUndefined();
    expect(tab.keys).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });
  it("clears the dirty flag when undoing back to the saved state", () => {
    tab.handleInput("x");
    tab.handleInput("u");
    expect(tab.dirty).toBe(false);
  });
  it("keeps the tab dirty when undoing past a save", () => {
    tab.handleInput("e");
    type(tab, "New content here");
    tab.handleInput("\r");
    tab.save();
    expect(tab.dirty).toBe(false);
    tab.handleInput("u");
    expect(tab.dirty).toBe(true);
  });

  it("types Kitty CSI-u characters into the input", () => {
    tab.handleInput("e");
    tab.handleInput("\x1b[97;1u");
    tab.handleInput("\x1b[98;1u");
    tab.handleInput("\x1b[99;1u");
    tab.handleInput("\x1b[100;1u");
    tab.handleInput("\x1b[101;1u");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("abcde");
  });

  it("wraps long content across lines up to the window width", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ "1": "one two three four five six seven eight nine ten" });
    });
    const tab = new MessagesTab(theme as any, notify);
    const lines = tab.render(30, 12);
    const content = lines.join("\n");
    expect(content).toContain("one two three");
    expect(content).toContain("nine ten");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(30);
    }
  });

  it("keeps the selected entry visible when content wraps beyond the window", () => {
    const long = "word ".repeat(50).trim();
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ "1": "short", "2": long, "3": "tail" });
    });
    const tab = new MessagesTab(theme as any, notify);
    tab.handleInput("j");
    tab.handleInput("j");
    const lines = tab.render(40, 6);
    expect(lines.join("\n")).toContain("3*1: tail");
  });

  it("marks entries referenced by the workflow", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("workflow.json")) return JSON.stringify({ rounds: 1, start: [{ msg: "1" }], loop: [{ tree: "3" }], finally: [] });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const tab = new MessagesTab(theme as any, notify);
    const content = tab.render(80, 12).join("\n");
    expect(content).toContain("1*1: ");
    expect(content).toContain("3*1: ");
    expect(content).toContain(" 2: ");
    expect(content).toContain(" *N = referenced by workflow N");
  });

  it("marks entries referenced by any workflow", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("defaults.json")) return JSON.stringify({ "workflow.json": "recorded", "messages.json": "recorded", "commands.json": "recorded" });
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ ...MESSAGES, "9": "nine", "10": "ten", "11": "eleven", "12": "twelve", "13": "thirteen", "14": "fourteen", "15": "fifteen", "16": "sixteen", "17": "seventeen" });
    });
    const tab = new MessagesTab(theme as any, notify);
    for (let i = 0; i < 16; i++) tab.handleInput("j");
    const content = tab.render(80, 12).join("\n");
    expect(content).toContain("9*2: ");
    expect(content).toContain("17*2: ");
  });

  it("refuses to delete a message referenced by another workflow", () => {
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("defaults.json")) return JSON.stringify({ "workflow.json": "recorded", "messages.json": "recorded", "commands.json": "recorded" });
      if (String(path).includes("workflow.json")) return JSON.stringify(WORKFLOW_JSON);
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify({ ...MESSAGES, "9": "nine", "10": "ten", "11": "eleven", "12": "twelve", "13": "thirteen", "14": "fourteen", "15": "fifteen", "16": "sixteen", "17": "seventeen" });
    });
    const tab = new MessagesTab(theme as any, notify);
    for (let i = 0; i < 8; i++) tab.handleInput("j");
    tab.handleInput("x");
    tab.save();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(tab.getAboveContentLine(80)[0]).toContain("Messages still used by the workflow: 9");
  });
});

describe("CommandsTab", () => {
  let theme: ReturnType<typeof createTheme>;
  let notify: any;
  let tab: CommandsTab;

  beforeEach(() => {
    theme = createTheme();
    notify = vi.fn();
    setupFs();
    tab = new CommandsTab(theme as any, notify);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads commands into the draft", () => {
    expect(tab.draft).toEqual(COMMANDS);
    expect(tab.keys).toEqual(["1"]);
  });

  it("edits a command", () => {
    tab.handleInput("e");
    type(tab, "git add src");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe("git add src");
    expect(tab.dirty).toBe(true);
  });

  it("rejects short content", () => {
    tab.handleInput("e");
    type(tab, "ab");
    tab.handleInput("\r");
    expect(tab.draft["1"]).toBe(COMMANDS["1"]);
    expect(tab.getAboveContentLine(80)[0]).toContain("at least 5 characters");
  });

  it("adds a command with the next free index", () => {
    tab.handleInput("a");
    type(tab, "git status --porcelain");
    tab.handleInput("\r");
    expect(tab.draft["2"]).toBe("git status --porcelain");
    expect(tab.keys).toContain("2");
  });

  it("deletes a command", () => {
    tab.handleInput("x");
    expect(tab.draft["1"]).toBeUndefined();
    expect(tab.keys).toEqual([]);
    expect(tab.dirty).toBe(true);
  });
  it("undoes a deleted command", () => {
    tab.handleInput("x");
    tab.handleInput("u");
    expect(tab.draft["1"]).toBe(COMMANDS["1"]);
    expect(tab.keys).toEqual(["1"]);
  });

  it("saves commands to commands.json", () => {
    tab.handleInput("a");
    type(tab, "git status --porcelain");
    tab.handleInput("\r");
    tab.save();
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining("commands.json"), expect.any(String), "utf-8");
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(written).toEqual({ "1": "git add .", "2": "git status --porcelain" });
    expect(tab.dirty).toBe(false);
    expect(notify).toHaveBeenCalledWith("commands.json saved", "info");
  });

  it("refuses to save when a command used by the workflow is deleted", () => {
    tab.handleInput("x");
    tab.save();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(tab.getAboveContentLine(80)[0]).toContain("Commands still used by the workflow: 1 - remove and save them in the Workflow");
    expect(tab.getAboveContentLine(80)[0]).not.toContain("tab first");
    expect(tab.dirty).toBe(true);
  });
});

describe("WorkflowEditorOverlay", () => {
  let theme: ReturnType<typeof createTheme>;
  let done: any;
  let showOverlay: any;
  let workflowTab: WorkflowTab;
  let messagesTab: MessagesTab;
  let commandsTab: CommandsTab;
  let overlay: WorkflowEditorOverlay;

  beforeEach(() => {
    theme = createTheme();
    done = vi.fn();
    showOverlay = vi.fn(() => ({ hide: vi.fn() }));
    setupFs();
    workflowTab = new WorkflowTab(theme as any, vi.fn() as any);
    messagesTab = new MessagesTab(theme as any, vi.fn() as any);
    commandsTab = new CommandsTab(theme as any, vi.fn() as any);
    overlay = new WorkflowEditorOverlay({
      title: "Workflow Editor",
      tabs: [workflowTab, messagesTab, commandsTab],
      theme: theme as any,
      tui: { terminal: { rows: 24 }, showOverlay } as any,
      done,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the frame with all three tabs", () => {
    const lines = overlay.render(80);
    expect(lines[0]).toContain("╭");
    expect(lines[lines.length - 1]).toContain("╰");
    expect(lines[2]).toContain("[Workflow 1]");
    expect(lines[2]).toContain("[Messages]");
    expect(lines[2]).toContain("[Commands]");
  });

  it("wraps the footer hints across multiple lines instead of truncating", () => {
    const lines = overlay.render(80);
    const footer = lines.join("\n");
    expect(footer).toContain("u undo");
    expect(footer).toContain("q close");
    expect(footer).not.toContain("…");
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it("switches tabs with tab and shift+tab", () => {
    overlay.handleInput("\t");
    expect((overlay as any).activeTab).toBe(1);
    overlay.handleInput("\x1b[Z");
    expect((overlay as any).activeTab).toBe(0);
  });

  it("does not switch tabs while typing in an input", () => {
    workflowTab.handleInput("e");
    overlay.handleInput("\t");
    expect((overlay as any).activeTab).toBe(0);
  });

  it("closes cleanly when nothing is dirty", () => {
    overlay.handleInput("q");
    expect(done).toHaveBeenCalled();
    expect(showOverlay).not.toHaveBeenCalled();
  });

  it("exits with q sent as a Kitty CSI-u sequence", () => {
    overlay.handleInput("\x1b[113;1u");
    expect(done).toHaveBeenCalled();
  });

  it("shows a confirm popup in front when closing with unsaved changes", () => {
    workflowTab.handleInput("e");
    workflowTab.handleInput("9");
    workflowTab.handleInput("\r");
    overlay.handleInput("q");
    expect(showOverlay).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
    const popup = showOverlay.mock.calls[0]![0];
    const lines = popup.render(50);
    expect(lines.join("\n")).toContain("Unsaved changes - press q again to close");
    expect(showOverlay.mock.calls[0]![1]).toMatchObject({ anchor: "center" });
  });

  it("closes the editor when q is pressed on the confirm popup", () => {
    workflowTab.handleInput("e");
    workflowTab.handleInput("9");
    workflowTab.handleInput("\r");
    overlay.handleInput("q");
    const popup = showOverlay.mock.calls[0]![0];
    popup.handleInput("q");
    expect(done).toHaveBeenCalled();
    expect(showOverlay.mock.results[0]!.value.hide).toHaveBeenCalled();
  });

  it("dismisses the confirm popup on any other key", () => {
    workflowTab.handleInput("e");
    workflowTab.handleInput("9");
    workflowTab.handleInput("\r");
    overlay.handleInput("q");
    const popup = showOverlay.mock.calls[0]![0];
    popup.handleInput("j");
    expect(done).not.toHaveBeenCalled();
    expect(showOverlay.mock.results[0]!.value.hide).toHaveBeenCalled();
  });

  it("dismisses the confirm popup on escape instead of closing", () => {
    workflowTab.handleInput("e");
    workflowTab.handleInput("9");
    workflowTab.handleInput("\r");
    overlay.handleInput("q");
    const popup = showOverlay.mock.calls[0]![0];
    popup.handleInput("\x1b");
    expect(done).not.toHaveBeenCalled();
    expect(showOverlay.mock.results[0]!.value.hide).toHaveBeenCalled();
  });

  it("auto-dismisses the confirm popup after 5 seconds", () => {
    vi.useFakeTimers();
    try {
      workflowTab.handleInput("e");
      workflowTab.handleInput("9");
      workflowTab.handleInput("\r");
      overlay.handleInput("q");
      vi.advanceTimersByTime(5000);
      expect(showOverlay.mock.results[0]!.value.hide).toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks dirty tabs in the tab bar", () => {
    workflowTab.handleInput("e");
    workflowTab.handleInput("9");
    workflowTab.handleInput("\r");
    const lines = overlay.render(80);
    expect(lines[2]).toContain("[Workflow 1*]");
  });

  it("lets the active tab consume keys first", () => {
    workflowTab.handleInput("e");
    expect(workflowTab.handleInput("x")).toBe(true);
  });
});
