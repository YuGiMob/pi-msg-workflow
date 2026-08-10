import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, decodeKittyPrintable, matchesKey, visibleWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { getMessages, setMessages } from "./messages.js";
import { getCommands, setCommands } from "./commands.js";
import { MAX_ROUNDS } from "./constants.js";
import { getWorkflowConfig, setWorkflowConfig, referencedIndices, referencedCommands, type LoopStep, type WorkflowConfig } from "./workflow-config.js";

export interface EditorTab {
  readonly name: string;
  dirty: boolean;
  readonly footerHints: string;
  handleInput(data: string): boolean;
  getAboveContentLine(innerWidth: number): string[];
  render(innerWidth: number, height: number): string[];
  save(): void;
}

export type Notify = (text: string, kind: "info" | "warning" | "error") => void;

interface InputState {
  prompt: string;
  buffer: string;
  cursor: number;
  commit(value: string): string | null;
}

const CONTENT_HEIGHT = 24;
const CHROME_ROWS = 7;
export const MAX_OVERLAY_HEIGHT_RATIO = 0.9;
const FLASH_MS = 2500;
const CONFIRM_POPUP_MS = 5000;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  return `${takePrefix(text, width - 1)}…`;
}

function takePrefix(text: string, width: number): string {
  let result = "";
  let used = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > width) break;
    result += ch;
    used += w;
  }
  return result;
}

function wrapCells(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > width && current !== "") {
      lines.push(current);
      current = "";
      used = 0;
    }
    current += ch;
    used += w;
  }
  if (current !== "") lines.push(current);
  return lines;
}

function wrapText(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") {
      lines.push(current);
      current = "";
    }
    if (visibleWidth(word) > width) {
      lines.push(...wrapCells(word, width));
    } else {
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function wrapHint(text: string, width: number): string[] {
  const segments = text.split(" · ");
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    const candidate = current === "" ? segment : `${current} · ${segment}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
    } else {
      if (current !== "") lines.push(current);
      current = segment;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, i) => key === bKeys[i] && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

abstract class BaseEditorTab implements EditorTab {
  abstract readonly name: string;
  abstract readonly footerHints: string;
  dirty = false;
  protected flash: string | null = null;
  protected input: InputState | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private undoStack: unknown[] = [];

  protected setFlash(text: string): void {
    this.flash = text;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
    }, FLASH_MS);
  }

  protected pushUndo(snapshot: unknown): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  protected popUndo(): unknown | undefined {
    return this.undoStack.pop();
  }

  protected startInput(prompt: string, commit: (value: string) => string | null): void {
    this.input = { prompt, buffer: "", cursor: 0, commit };
  }

  protected handleInputMode(data: string): boolean {
    if (!this.input) return false;
    if (matchesKey(data, Key.escape)) {
      this.input = null;
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const error = this.input.commit(this.input.buffer);
      if (error !== null) this.setFlash(error);
      this.input = null;
      return true;
    }
    if (matchesKey(data, Key.backspace)) {
      if (this.input.cursor > 0) {
        this.input.buffer = this.input.buffer.slice(0, this.input.cursor - 1) + this.input.buffer.slice(this.input.cursor);
        this.input.cursor--;
      }
      return true;
    }
    if (matchesKey(data, Key.delete)) {
      if (this.input.cursor < this.input.buffer.length) {
        this.input.buffer = this.input.buffer.slice(0, this.input.cursor) + this.input.buffer.slice(this.input.cursor + 1);
      }
      return true;
    }
    if (matchesKey(data, Key.left)) {
      this.input.cursor = Math.max(0, this.input.cursor - 1);
      return true;
    }
    if (matchesKey(data, Key.right)) {
      this.input.cursor = Math.min(this.input.buffer.length, this.input.cursor + 1);
      return true;
    }
    if (matchesKey(data, Key.home)) {
      this.input.cursor = 0;
      return true;
    }
    if (matchesKey(data, Key.end)) {
      this.input.cursor = this.input.buffer.length;
      return true;
    }
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      const pasted = data.slice(PASTE_START.length, -PASTE_END.length).replace(/[\r\n]+/g, " ");
      this.input.buffer = this.input.buffer.slice(0, this.input.cursor) + pasted + this.input.buffer.slice(this.input.cursor);
      this.input.cursor += pasted.length;
      return true;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.input.buffer = this.input.buffer.slice(0, this.input.cursor) + kittyPrintable + this.input.buffer.slice(this.input.cursor);
      this.input.cursor += kittyPrintable.length;
      return true;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.input.buffer = this.input.buffer.slice(0, this.input.cursor) + data + this.input.buffer.slice(this.input.cursor);
      this.input.cursor += 1;
      return true;
    }
    return true;
  }

  getAboveContentLine(innerWidth: number): string[] {
    if (this.input) return wrapCells(` ${this.input.prompt}${this.input.buffer.slice(0, this.input.cursor)}▏${this.input.buffer.slice(this.input.cursor)}`, innerWidth);
    if (this.flash) return [truncate(` ${this.flash}`, innerWidth)];
    return [];
  }

  abstract handleInput(data: string): boolean;
  abstract render(innerWidth: number, height: number): string[];
  abstract save(): void;
}

interface WorkflowDraft {
  rounds: number;
  start: LoopStep[];
  tree: string;
  loop: LoopStep[];
  finally: LoopStep[];
}

type WorkflowSnapshot = WorkflowDraft & { selection: number };

type SelectableKind = "start" | "tree" | "loop" | "finally";

export class WorkflowTab extends BaseEditorTab implements EditorTab {
  readonly name = "Workflow";
  readonly footerHints = "j/k sel · e edit · a add · x del · J/K move · t if-chg · [ ] rnds · u undo · s save";
  readonly draft: WorkflowDraft;
  private selection = 0;
  private savedSnapshot: WorkflowSnapshot;

  constructor(private readonly theme: Theme, private readonly notify: Notify) {
    super();
    const { config } = getWorkflowConfig();
    this.draft = {
      rounds: config.rounds,
      start: config.start.map((step) => ({ ...step })),
      tree: config.loop[0]?.tree ?? "1",
      loop: config.loop.slice(1).map((step) => ({ ...step })),
      finally: config.finally.map((step) => ({ ...step })),
    };
    this.savedSnapshot = this.snapshot();
  }

  private snapshot(): WorkflowSnapshot {
    return {
      rounds: this.draft.rounds,
      start: this.draft.start.map((step) => ({ ...step })),
      tree: this.draft.tree,
      loop: this.draft.loop.map((step) => ({ ...step })),
      finally: this.draft.finally.map((step) => ({ ...step })),
      selection: this.selection,
    };
  }
  private restore(snap: WorkflowSnapshot): void {
    this.draft.rounds = snap.rounds;
    this.draft.start = snap.start;
    this.draft.tree = snap.tree;
    this.draft.loop = snap.loop;
    this.draft.finally = snap.finally;
    this.selection = Math.min(snap.selection, this.rowCount() - 1);
  }
  private equalsSaved(): boolean {
    const current = this.snapshot();
    return current.rounds === this.savedSnapshot.rounds
      && current.tree === this.savedSnapshot.tree
      && deepEqual(current.start, this.savedSnapshot.start)
      && deepEqual(current.loop, this.savedSnapshot.loop)
      && deepEqual(current.finally, this.savedSnapshot.finally);
  }
  private undo(): void {
    const snap = this.popUndo();
    if (snap === undefined) {
      this.setFlash("Nothing to undo");
      return;
    }
    this.restore(snap as WorkflowSnapshot);
    this.dirty = !this.equalsSaved();
    this.setFlash(this.dirty ? "Undone (press s to save)" : "Undone");
  }

  private rowCount(): number {
    return this.draft.start.length + 1 + this.draft.loop.length + this.draft.finally.length;
  }

  private rowInfo(index: number): { kind: SelectableKind; position: number } {
    if (index < this.draft.start.length) return { kind: "start", position: index };
    if (index === this.draft.start.length) return { kind: "tree", position: 0 };
    const loopStart = this.draft.start.length + 1;
    if (index < loopStart + this.draft.loop.length) return { kind: "loop", position: index - loopStart };
    return { kind: "finally", position: index - loopStart - this.draft.loop.length };
  }

  private selectLoopRow(position: number): void {
    this.selection = this.draft.start.length + 1 + position;
  }

  private selectFinallyRow(position: number): void {
    this.selection = this.draft.start.length + 1 + this.draft.loop.length + position;
  }

  handleInput(data: string): boolean {
    if (this.handleInputMode(data)) return true;
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selection = Math.min(this.selection + 1, this.rowCount() - 1);
      return true;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selection = Math.max(this.selection - 1, 0);
      return true;
    }
    const { kind, position } = this.rowInfo(this.selection);
    if (matchesKey(data, "e")) {
      this.editRow(kind, position);
      return true;
    }
    if (matchesKey(data, "a")) {
      this.addRow(kind);
      return true;
    }
    if (matchesKey(data, "x")) {
      this.deleteRow(kind, position);
      return true;
    }
    if (matchesKey(data, "shift+j")) {
      this.moveRow(kind, position, 1);
      return true;
    }
    if (matchesKey(data, "shift+k")) {
      this.moveRow(kind, position, -1);
      return true;
    }
    if (matchesKey(data, "t")) {
      this.toggleIfChanges(kind, position);
      return true;
    }
    if (matchesKey(data, "u")) {
      this.undo();
      return true;
    }
    if (matchesKey(data, "[")) {
      this.pushUndo(this.snapshot());
      this.draft.rounds = Math.max(1, this.draft.rounds - 1);
      this.dirty = true;
      return true;
    }
    if (matchesKey(data, "]")) {
      this.pushUndo(this.snapshot());
      this.draft.rounds = Math.min(MAX_ROUNDS, this.draft.rounds + 1);
      this.dirty = true;
      return true;
    }
    if (matchesKey(data, "s")) {
      this.save();
      return true;
    }
    return false;
  }

  private editStepIndex(target: LoopStep[], position: number, action: "msg" | "cmd", current: string): void {
    const label = action === "msg" ? "message" : "command";
    this.startInput(`${label} index for ${action} step (current: ${current}): `, (value) => {
      const index = value.trim();
      if (!/^\d+$/.test(index)) return "Index must be a number.";
      this.pushUndo(this.snapshot());
      const step = target[position]!;
      target[position] = action === "msg" ? { ...step, msg: index } : { ...step, cmd: index };
      this.dirty = true;
      return null;
    });
  }

  private editRow(kind: SelectableKind, position: number): void {
    if (kind === "start") {
      const step = this.draft.start[position]!;
      if (step.msg !== undefined) {
        this.editStepIndex(this.draft.start, position, "msg", step.msg);
      } else if (step.cmd !== undefined) {
        this.editStepIndex(this.draft.start, position, "cmd", step.cmd);
      }
      return;
    }
    if (kind === "tree") {
      const current = this.draft.tree;
      this.startInput(`tree anchor message index (current: ${current}): `, (value) => {
        const index = value.trim();
        if (!/^\d+$/.test(index)) return "Index must be a number.";
        this.pushUndo(this.snapshot());
        this.draft.tree = index;
        this.dirty = true;
        return null;
      });
      return;
    }
    if (kind === "loop") {
      const step = this.draft.loop[position]!;
      if (step.msg !== undefined) {
        this.editStepIndex(this.draft.loop, position, "msg", step.msg);
        return;
      }
      if (step.cmd !== undefined) {
        this.editStepIndex(this.draft.loop, position, "cmd", step.cmd);
        return;
      }
      return;
    }
    const step = this.draft.finally[position]!;
    if (step.msg !== undefined) {
      this.editStepIndex(this.draft.finally, position, "msg", step.msg);
    } else if (step.cmd !== undefined) {
      this.editStepIndex(this.draft.finally, position, "cmd", step.cmd);
    }
  }

  private addStepPrompt(prompt: string, target: LoopStep[], select: () => void): void {
    this.startInput(prompt, (value) => {
      const text = value.trim();
      const msgMatch = text.match(/^msg\s+(\d+)$/);
      if (msgMatch) {
        this.pushUndo(this.snapshot());
        target.push({ msg: msgMatch[1]! });
        select();
        this.dirty = true;
        return null;
      }
      const cmdMatch = text.match(/^cmd\s+(\d+)$/);
      if (cmdMatch) {
        this.pushUndo(this.snapshot());
        target.push({ cmd: cmdMatch[1]! });
        select();
        this.dirty = true;
        return null;
      }
      return "Expected: msg <number> or cmd <number>.";
    });
  }

  private addRow(kind: SelectableKind): void {
    if (kind === "tree") {
      this.setFlash("The tree step is fixed as the first loop step; edit its index with e");
      return;
    }
    if (kind === "start") {
      this.addStepPrompt("add start step (msg <n> | cmd <n>): ", this.draft.start, () => {
        this.selection = this.draft.start.length - 1;
      });
      return;
    }
    if (kind === "loop") {
      this.addStepPrompt("add loop step (msg <n> | cmd <n>): ", this.draft.loop, () => {
        this.selectLoopRow(this.draft.loop.length - 1);
      });
      return;
    }
    this.addStepPrompt("add finally step (msg <n> | cmd <n>): ", this.draft.finally, () => {
      this.selectFinallyRow(this.draft.finally.length - 1);
    });
  }

  private deleteRow(kind: SelectableKind, position: number): void {
    if (kind === "tree") {
      this.setFlash("The tree step is fixed as the first loop step");
      return;
    }
    this.pushUndo(this.snapshot());
    if (kind === "start") {
      this.draft.start.splice(position, 1);
    } else if (kind === "loop") {
      this.draft.loop.splice(position, 1);
    } else {
      this.draft.finally.splice(position, 1);
    }
    this.selection = Math.min(this.selection, this.rowCount() - 1);
    this.dirty = true;
    this.setFlash("Deleted (press s to save)");
  }

  private swapRows(target: LoopStep[], position: number, delta: number): boolean {
    const targetIndex = position + delta;
    if (targetIndex < 0 || targetIndex >= target.length) return false;
    [target[position], target[targetIndex]] = [target[targetIndex]!, target[position]!];
    return true;
  }

  private moveRow(kind: SelectableKind, position: number, delta: number): void {
    if (kind === "tree") {
      this.setFlash("The tree step is fixed as the first loop step");
      return;
    }
    const target = kind === "start" ? this.draft.start : kind === "loop" ? this.draft.loop : this.draft.finally;
    const snap = this.snapshot();
    if (!this.swapRows(target, position, delta)) return;
    this.pushUndo(snap);
    this.selection += delta;
    this.dirty = true;
  }

  private toggleIfChanges(kind: SelectableKind, position: number): void {
    if (kind !== "loop") {
      this.setFlash("if-changes applies to loop msg steps");
      return;
    }
    const step = this.draft.loop[position]!;
    if (step.msg === undefined) {
      this.setFlash("if-changes applies to loop msg steps");
      return;
    }
    this.pushUndo(this.snapshot());
    this.draft.loop[position] = step.onlyIfChanges ? { msg: step.msg } : { ...step, onlyIfChanges: true };
    this.dirty = true;
  }

  save(): void {
    const messages = getMessages();
    const indices = [
      ...this.draft.start.flatMap((step) => (step.msg !== undefined ? [step.msg] : [])),
      this.draft.tree,
      ...this.draft.loop.flatMap((step) => (step.msg !== undefined ? [step.msg] : [])),
      ...this.draft.finally.flatMap((step) => (step.msg !== undefined ? [step.msg] : [])),
    ];
    const missing = [...new Set(indices)].filter((num) => !messages[num]);
    if (missing.length > 0) {
      this.setFlash(`Missing messages: ${missing.join(", ")} - add and save them in the Messages tab first`);
      return;
    }
    const commands = getCommands();
    const cmdIndices = [
      ...this.draft.start.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : [])),
      ...this.draft.loop.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : [])),
      ...this.draft.finally.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : [])),
    ];
    const missingCommands = [...new Set(cmdIndices)].filter((num) => !commands[num]);
    if (missingCommands.length > 0) {
      this.setFlash(`Missing commands: ${missingCommands.join(", ")} - add and save them in the Commands tab first`);
      return;
    }
    const config: WorkflowConfig = {
      rounds: this.draft.rounds,
      start: [...this.draft.start],
      loop: [{ tree: this.draft.tree }, ...this.draft.loop.map((step) => ({ ...step }))],
      finally: this.draft.finally.map((step) => ({ ...step })),
    };
    try {
      setWorkflowConfig(config);
    } catch (err) {
      this.setFlash(`Could not save workflow.json: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.savedSnapshot = this.snapshot();
    this.dirty = false;
    this.setFlash("workflow.json saved");
    this.notify("workflow.json saved", "info");
  }

  render(innerWidth: number, height: number): string[] {
    const th = this.theme;
    const messages = getMessages();
    const commands = getCommands();
    const lines: string[] = [];
    const row = (text: string, selected: boolean) => {
      const trimmed = truncate(` ${text}`, innerWidth);
      lines.push(selected ? th.bg("selectedBg", th.fg("text", trimmed)) : th.fg("text", trimmed));
    };
    lines.push(th.fg("dim", ` Rounds: ${this.draft.rounds}   ([ ] to change)`));
    lines.push(th.fg("dim", " start"));
    this.draft.start.forEach((step, i) => {
      if (step.msg !== undefined) {
        const preview = messages[step.msg] ? messages[step.msg]! : "(missing)";
        row(`msg ${step.msg}: ${preview}`, this.selection === i);
      } else if (step.cmd !== undefined) {
        const preview = commands[step.cmd] ? commands[step.cmd]! : "(missing)";
        row(`cmd ${step.cmd}: ${preview}`, this.selection === i);
      }
    });
    lines.push(th.fg("dim", " loop"));
    const treePreview = messages[this.draft.tree] ? messages[this.draft.tree]! : "(missing)";
    row(`tree → ${this.draft.tree}: ${treePreview}  (fixed first)`, this.selection === this.draft.start.length);
    this.draft.loop.forEach((step, i) => {
      const selected = this.selection === this.draft.start.length + 1 + i;
      if (step.msg !== undefined) {
        row(`msg ${step.msg}${step.onlyIfChanges ? " [if-changes]" : ""}`, selected);
      } else if (step.cmd !== undefined) {
        const preview = commands[step.cmd] ? commands[step.cmd]! : "(missing)";
        row(`cmd ${step.cmd}: ${preview}`, selected);
      }
    });
    lines.push(th.fg("dim", " finally"));
    this.draft.finally.forEach((step, i) => {
      const selected = this.selection === this.draft.start.length + 1 + this.draft.loop.length + i;
      if (step.msg !== undefined) {
        const preview = messages[step.msg] ? messages[step.msg]! : "(missing)";
        row(`msg ${step.msg}: ${preview}`, selected);
      } else if (step.cmd !== undefined) {
        const preview = commands[step.cmd] ? commands[step.cmd]! : "(missing)";
        row(`cmd ${step.cmd}: ${preview}`, selected);
      }
    });
    while (lines.length < height) lines.push(th.fg("dim", "~"));
    return lines.slice(0, height);
  }
}

abstract class StoreTab extends BaseEditorTab implements EditorTab {
  readonly draft: Record<string, string>;
  readonly keys: string[];
  private selection = 0;
  private scroll = 0;
  private savedSnapshot: { draft: Record<string, string>; keys: string[] };

  protected constructor(
    private readonly theme: Theme,
    private readonly notify: Notify,
    readonly name: string,
    readonly footerHints: string,
  ) {
    super();
    this.draft = { ...this.load() };
    this.keys = Object.keys(this.draft).sort((a, b) => Number(a) - Number(b));
    this.savedSnapshot = { draft: { ...this.draft }, keys: [...this.keys] };
  }

  private snapshot(): { draft: Record<string, string>; keys: string[]; selection: number } {
    return { draft: { ...this.draft }, keys: [...this.keys], selection: this.selection };
  }
  private restore(snap: { draft: Record<string, string>; keys: string[]; selection: number }): void {
    for (const key of Object.keys(this.draft)) delete this.draft[key];
    Object.assign(this.draft, snap.draft);
    this.keys.length = 0;
    this.keys.push(...snap.keys);
    this.selection = Math.min(snap.selection, Math.max(0, this.keys.length - 1));
  }
  private equalsSaved(): boolean {
    return deepEqual(this.draft, this.savedSnapshot.draft);
  }
  private undo(): void {
    const snap = this.popUndo();
    if (snap === undefined) {
      this.setFlash("Nothing to undo");
      return;
    }
    this.restore(snap as { draft: Record<string, string>; keys: string[]; selection: number });
    this.dirty = !this.equalsSaved();
    this.setFlash(this.dirty ? "Undone (press s to save)" : "Undone");
  }
  protected abstract load(): Record<string, string>;
  protected abstract write(store: Record<string, string>): void;
  protected abstract referenced(config: WorkflowConfig): string[];
  protected abstract noun: string;
  protected abstract fileLabel: string;

  handleInput(data: string): boolean {
    if (this.handleInputMode(data)) return true;
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selection = Math.min(this.selection + 1, Math.max(0, this.keys.length - 1));
      return true;
    }
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selection = Math.max(this.selection - 1, 0);
      return true;
    }
    if (matchesKey(data, "e")) {
      this.editSelected();
      return true;
    }
    if (matchesKey(data, "a")) {
      this.addEntry();
      return true;
    }
    if (matchesKey(data, "x")) {
      this.deleteSelected();
      return true;
    }
    if (matchesKey(data, "u")) {
      this.undo();
      return true;
    }
    if (matchesKey(data, "s")) {
      this.save();
      return true;
    }
    return false;
  }

  private nextKey(): string {
    const max = this.keys.reduce((maxKey, key) => {
      const n = Number(key);
      return Number.isNaN(n) ? maxKey : Math.max(maxKey, n);
    }, 0);
    return String(max + 1);
  }

  private editSelected(): void {
    if (this.keys.length === 0) {
      this.setFlash(`No ${this.noun.toLowerCase()}s yet - press a to add one`);
      return;
    }
    const key = this.keys[this.selection]!;
    this.startInput(`content for ${this.noun.toLowerCase()} ${key} (current: ${truncate(this.draft[key]!, 30)}): `, (value) => {
      const content = value.trim();
      if (content.length < 5) return `${this.noun} must be at least 5 characters.`;
      this.pushUndo(this.snapshot());
      this.draft[key] = content;
      this.dirty = true;
      return null;
    });
  }

  private addEntry(): void {
    const key = this.nextKey();
    this.startInput(`content for new ${this.noun.toLowerCase()} ${key}: `, (value) => {
      const content = value.trim();
      if (content.length < 5) return `${this.noun} must be at least 5 characters.`;
      this.pushUndo(this.snapshot());
      this.draft[key] = content;
      this.keys.push(key);
      this.keys.sort((a, b) => Number(a) - Number(b));
      this.selection = this.keys.indexOf(key);
      this.dirty = true;
      return null;
    });
  }

  private deleteSelected(): void {
    if (this.keys.length === 0) return;
    this.pushUndo(this.snapshot());
    const key = this.keys[this.selection]!;
    delete this.draft[key];
    this.keys.splice(this.selection, 1);
    this.selection = Math.min(this.selection, Math.max(0, this.keys.length - 1));
    this.dirty = true;
    this.setFlash("Deleted (press s to save)");
  }

  save(): void {
    const { config } = getWorkflowConfig();
    const removed = this.referenced(config).filter((num) => this.draft[num] === undefined);
    if (removed.length > 0) {
      this.setFlash(`${this.noun}s still used by the workflow: ${removed.join(", ")} - remove and save them in the Workflow tab first`);
      return;
    }
    try {
      this.write({ ...this.draft });
    } catch (err) {
      this.setFlash(`Could not save ${this.fileLabel}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.savedSnapshot = { draft: { ...this.draft }, keys: [...this.keys] };
    this.dirty = false;
    this.setFlash(`${this.fileLabel} saved`);
    this.notify(`${this.fileLabel} saved`, "info");
  }

  render(innerWidth: number, height: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    if (this.keys.length === 0) {
      lines.push(th.fg("dim", ` No ${this.noun.toLowerCase()}s yet - press a to add one`));
    }
    const header = (key: string) => ` ${key}: `;
    const entries: { text: string; selected: boolean }[] = [];
    const keyOffsets: number[] = [0];
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i]!;
      const h = header(key);
      const wrapped = wrapText(this.draft[key]!, Math.max(1, innerWidth - visibleWidth(h)));
      keyOffsets.push(keyOffsets[keyOffsets.length - 1]! + wrapped.length);
      for (let j = 0; j < wrapped.length; j++) {
        entries.push({
          text: (j === 0 ? h : " ".repeat(visibleWidth(h))) + wrapped[j]!,
          selected: i === this.selection,
        });
      }
    }
    const total = keyOffsets[keyOffsets.length - 1]!;
    const selStart = keyOffsets[this.selection] ?? total;
    const selEnd = keyOffsets[this.selection + 1] ?? total;
    if (selStart < this.scroll) this.scroll = selStart;
    if (selEnd > this.scroll + height) this.scroll = selEnd - height;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - height)));
    for (let i = this.scroll; i < Math.min(total, this.scroll + height); i++) {
      const entry = entries[i]!;
      const text = truncate(entry.text, innerWidth);
      lines.push(entry.selected ? th.bg("selectedBg", th.fg("text", text)) : th.fg("text", text));
    }
    while (lines.length < height) lines.push(th.fg("dim", "~"));
    return lines.slice(0, height);
  }
}

export class MessagesTab extends StoreTab {
  constructor(theme: Theme, notify: Notify) {
    super(theme, notify, "Messages", "j/k sel · e edit · a add · x del · u undo · s save");
  }
  protected load(): Record<string, string> {
    return getMessages();
  }
  protected write(store: Record<string, string>): void {
    setMessages(store);
  }
  protected referenced(config: WorkflowConfig): string[] {
    return referencedIndices(config);
  }
  protected noun = "Message";
  protected fileLabel = "messages.json";
}

export class CommandsTab extends StoreTab {
  constructor(theme: Theme, notify: Notify) {
    super(theme, notify, "Commands", "j/k sel · e edit · a add · x del · u undo · s save");
  }
  protected load(): Record<string, string> {
    return getCommands();
  }
  protected write(store: Record<string, string>): void {
    setCommands(store);
  }
  protected referenced(config: WorkflowConfig): string[] {
    return referencedCommands(config);
  }
  protected noun = "Command";
  protected fileLabel = "commands.json";
}

export interface WorkflowEditorOverlayOptions {
  title: string;
  tabs: EditorTab[];
  theme: Theme;
  tui: TUI;
  done: () => void;
}

class ConfirmClosePopup {
  constructor(
    private readonly theme: Theme,
    private readonly text: string,
    private readonly onConfirm: () => void,
    private readonly onDismiss: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      this.onConfirm();
    } else {
      this.onDismiss();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const th = this.theme;
    const innerW = width - 2;
    const pad = (text: string) => text + " ".repeat(Math.max(0, innerW - visibleWidth(text)));
    const row = (content: string) => th.fg("border", "│") + pad(content) + th.fg("border", "│");
    return [
      th.fg("border", `╭${"─".repeat(innerW)}╮`),
      row(` ${th.fg("warning", this.text)}`),
      row(th.fg("dim", " q to close · any other key to keep editing")),
      th.fg("border", `╰${"─".repeat(innerW)}╯`),
    ];
  }
}

export class WorkflowEditorOverlay {
  private activeTab = 0;
  private confirmPopupHandle: OverlayHandle | undefined;
  private confirmPopupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: WorkflowEditorOverlayOptions) {}

  private get active(): EditorTab {
    return this.opts.tabs[this.activeTab]!;
  }

  private hideConfirmPopup(): void {
    if (this.confirmPopupTimer) {
      clearTimeout(this.confirmPopupTimer);
      this.confirmPopupTimer = undefined;
    }
    this.confirmPopupHandle?.hide();
    this.confirmPopupHandle = undefined;
  }

  private showConfirmPopup(): void {
    if (this.confirmPopupHandle) return;
    const text = "Unsaved changes - press q again to close";
    const popup = new ConfirmClosePopup(
      this.opts.theme,
      text,
      () => {
        this.hideConfirmPopup();
        this.opts.done();
      },
      () => {
        this.hideConfirmPopup();
      },
    );
    this.confirmPopupHandle = this.opts.tui.showOverlay(popup, {
      anchor: "center",
      width: Math.min(60, visibleWidth(text) + 10),
    });
    this.confirmPopupTimer = setTimeout(() => {
      this.hideConfirmPopup();
    }, CONFIRM_POPUP_MS);
  }

  handleInput(data: string): void {
    const consumed = this.active.handleInput(data);
    if (consumed) {
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.activeTab = (this.activeTab + 1) % this.opts.tabs.length;
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.activeTab = (this.activeTab - 1 + this.opts.tabs.length) % this.opts.tabs.length;
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "q")) {
      if (this.opts.tabs.some((tab) => tab.dirty)) {
        this.showConfirmPopup();
        return;
      }
      this.opts.done();
      return;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const th = this.opts.theme;
    const innerW = width - 2;
    const hintParts = [this.opts.tabs.length > 1 ? "Tab" : "", this.active.footerHints, "q close"].filter(Boolean);
    const hintLines = wrapHint(` ${hintParts.join(" · ")}`, innerW);
    const aboveLines = this.active.getAboveContentLine(innerW);
    const maxHeight = Math.floor(this.opts.tui.terminal.rows * MAX_OVERLAY_HEIGHT_RATIO);
    const chromeRows = CHROME_ROWS + hintLines.length - 1 + Math.max(0, aboveLines.length - 1);
    const contentHeight = Math.max(1, Math.min(CONTENT_HEIGHT, maxHeight - chromeRows));
    const lines: string[] = [];
    const pad = (text: string) => text + " ".repeat(Math.max(0, innerW - visibleWidth(text)));
    const row = (content: string) => th.fg("border", "│") + pad(content) + th.fg("border", "│");
    const borderTop = th.fg("border", `╭${"─".repeat(innerW)}╮`);
    const borderSep = th.fg("border", `├${"─".repeat(innerW)}┤`);
    const borderBottom = th.fg("border", `╰${"─".repeat(innerW)}╯`);

    lines.push(borderTop);
    lines.push(row(` ${th.fg("accent", th.bold(this.opts.title))}`));

    let tabBar = " ";
    for (let i = 0; i < this.opts.tabs.length; i++) {
      const tab = this.opts.tabs[i]!;
      const marker = tab.dirty ? "*" : "";
      tabBar += i === this.activeTab ? th.fg("accent", th.bold(`[${tab.name}${marker}]`)) : th.fg("dim", `[${tab.name}${marker}]`);
      if (i < this.opts.tabs.length - 1) tabBar += " ";
    }
    lines.push(row(tabBar));

    if (aboveLines.length > 0) {
      for (const aboveLine of aboveLines) lines.push(row(aboveLine));
    } else {
      lines.push(borderSep);
    }

    const contentLines = this.active.render(innerW, contentHeight);
    for (let i = 0; i < contentHeight; i++) {
      lines.push(row(contentLines[i] ?? ""));
    }

    lines.push(borderSep);
    for (const hintLine of hintLines) {
      lines.push(row(th.fg("dim", hintLine)));
    }
    lines.push(borderBottom);
    return lines;
  }
}
