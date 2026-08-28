import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, decodeKittyPrintable, matchesKey, visibleWidth, type OverlayHandle, type TUI } from "@earendil-works/pi-tui";
import { getMessages, setMessages } from "./messages.js";
import { getCommands, setCommands } from "./commands.js";
import { MAX_ROUNDS, MAX_LOOP_SECTIONS } from "./constants.js";
import { getWorkflows, getWorkflowConfig, getWorkflowIssues, setWorkflowConfig, deleteWorkflowConfig, referencedIndices, referencedCommands, referencedWorkflows, loopSections, totalLoopSteps, isNumericString, type LoopStep, type WorkflowConfig } from "./workflow-config.js";
import { compareNumericKeys } from "./json-file.js";
import { errorMessage } from "./errors.js";

export interface EditorTab {
  readonly name: string;
  dirty: boolean;
  readonly footerHints: string;
  setPopup(callback: (text: string) => void): void;
  setInputListener(listener: (active: boolean) => void): void;
  getInputLines(width: number): string[] | null;
  handleInput(data: string): boolean;
  getAboveContentLine(innerWidth: number): string[];
  render(innerWidth: number, height: number): string[];
  save(): void;
}

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
const POPUP_MS = 5000;
const MIN_POPUP_WIDTH = 40;
const MAX_POPUP_WIDTH = 80;
const MAX_POPUP_LINES = 6;
const CONSOLE_POPUP_HINT = " console output · any key to dismiss";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  return `${takePrefix(text, width - 1)}…`;
}

function storePreview(store: Record<string, string>, key: string): string {
  return store[key] ? store[key]! : "(missing)";
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

function frameRow(theme: Theme, width: number, content: string): string {
  const padded = content + " ".repeat(Math.max(0, width - visibleWidth(content)));
  return theme.fg("border", "│") + padded + theme.fg("border", "│");
}

function frameLines(theme: Theme, width: number, content: string[]): string[] {
  const innerW = width - 2;
  return [
    theme.fg("border", `╭${"─".repeat(innerW)}╮`),
    ...content.map((line) => frameRow(theme, innerW, line)),
    theme.fg("border", `╰${"─".repeat(innerW)}╯`),
  ];
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, i) => key === bKeys[i] && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

abstract class BaseEditorTab implements EditorTab {
  abstract readonly name: string;
  abstract readonly footerHints: string;
  protected abstract snapshot(): unknown;
  dirty = false;
  protected flash: string | null = null;
  protected input: InputState | null = null;
  private inputListener: ((active: boolean) => void) | null = null;
  private popupCallback: ((text: string) => void) | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private undoStack: unknown[] = [];

  setPopup(callback: (text: string) => void): void {
    this.popupCallback = callback;
  }

  setInputListener(listener: (active: boolean) => void): void {
    this.inputListener = listener;
  }

  protected popup(text: string): void {
    this.popupCallback?.(text);
  }

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

  protected clearUndo(): void {
    this.undoStack = [];
  }

  protected performUndo(restore: (snap: unknown) => void, equalsSaved: () => boolean): void {
    const snap = this.popUndo();
    if (snap === undefined) {
      this.setFlash("Nothing to undo");
      return;
    }
    restore(snap);
    this.dirty = !equalsSaved();
    this.popup(this.dirty ? "Undone (press s to save)" : "Undone");
  }

  protected startInput(prompt: string, commit: (value: string) => string | null): void {
    this.input = { prompt, buffer: "", cursor: 0, commit };
    this.inputListener?.(true);
  }

  private endInput(): void {
    this.input = null;
    this.inputListener?.(false);
  }

  protected mutate(fn: () => void): void {
    this.pushUndo(this.snapshot());
    fn();
    this.dirty = true;
  }

  protected commitInput(prompt: string, validate: (value: string) => string | null, apply: (value: string) => void): void {
    this.startInput(prompt, (value) => {
      const trimmed = value.trim();
      const error = validate(trimmed);
      if (error !== null) return error;
      this.mutate(() => apply(trimmed));
      return null;
    });
  }

  protected handleInputMode(data: string): boolean {
    if (!this.input) return false;
    if (matchesKey(data, Key.escape)) {
      this.endInput();
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const error = this.input.commit(this.input.buffer);
      if (error !== null) {
        this.setFlash(error);
      } else {
        this.endInput();
      }
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
      this.insertAtCursor(data.slice(PASTE_START.length, -PASTE_END.length).replace(/[\r\n]+/g, " "));
      return true;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.insertAtCursor(kittyPrintable);
      return true;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.insertAtCursor(data);
      return true;
    }
    return true;
  }

  private insertAtCursor(text: string): void {
    const input = this.input!;
    input.buffer = input.buffer.slice(0, input.cursor) + text + input.buffer.slice(input.cursor);
    input.cursor += text.length;
  }

  getAboveContentLine(innerWidth: number): string[] {
    const lines: string[] = [];
    if (this.flash) lines.push(truncate(` ${this.flash}`, innerWidth));
    return lines;
  }

  getInputLines(width: number): string[] | null {
    if (!this.input) return null;
    return wrapCells(` ${this.input.prompt}${this.input.buffer.slice(0, this.input.cursor)}▏${this.input.buffer.slice(this.input.cursor)}`, width);
  }

  abstract handleInput(data: string): boolean;
  abstract render(innerWidth: number, height: number): string[];
  abstract save(): void;
}

interface WorkflowDraft {
  rounds: number;
  start: LoopStep[];
  tree: string;
  treeTimeout?: number;
  loop: LoopStep[];
  finally: LoopStep[];
  finallyOnError: boolean;
  extraSections: { tree: string; treeTimeout?: number; loop: LoopStep[] }[];
}

type WorkflowSnapshot = WorkflowDraft & { selection: number };
type StoreSnapshot = { draft: Record<string, string>; keys: string[]; selection: number };

type SelectableKind = "start" | "tree" | "loop" | "finally";

type LoadResult = { ok: true; flash?: string } | { ok: false; flash: string };
export class WorkflowTab extends BaseEditorTab implements EditorTab {
  private index = "1";
  readonly footerHints = "j/k sel · e edit · a add · x del · d del-wf · J/K move · t if-chg · o t-out · [ ] rnds · f fin-err · n new-loop · w switch · u undo · s save";
  readonly draft: WorkflowDraft;
  private selection = 0;
  private savedSnapshot: WorkflowSnapshot;
  private loadFailedIndex: string | null = null;

  get name(): string {
    return `Workflow ${this.index}`;
  }

  constructor(private readonly theme: Theme, index = "1") {
    super();
    this.draft = { rounds: 2, start: [], tree: "1", loop: [], extraSections: [], finally: [], finallyOnError: false };
    const result = this.loadWorkflow(index);
    if (result.flash !== undefined) this.setFlash(result.flash);
    this.savedSnapshot = this.snapshot();
  }

  private loadWorkflow(index: string): LoadResult {
    const { config, errors } = getWorkflowConfig(index);
    const sections = loopSections(config);
    const draftSections: { tree: string; treeTimeout?: number; loop: LoopStep[] }[] = [];
    let flash: string | undefined;
    for (let s = 0; s < sections.length; s++) {
      const section = sections[s]!;
      const first = section[0];
      if (first?.tree !== undefined) {
        draftSections.push({ tree: first.tree, treeTimeout: first.timeout, loop: section.slice(1) });
      } else {
        const treeIndex = section.findIndex((step) => step.tree !== undefined);
        if (treeIndex === -1) {
          this.loadFailedIndex = index;
          return { ok: false, flash: `Workflow ${index} has no tree step in loop section ${s + 1}. Fix workflow.json first` };
        }
        draftSections.push({ tree: section[treeIndex]!.tree!, treeTimeout: section[treeIndex]!.timeout, loop: section.filter((_, i) => i !== treeIndex) });
        flash = `Workflow ${index}: misplaced tree step in loop section ${s + 1} moved to the section start`;
      }
    }
    this.loadFailedIndex = null;
    this.index = index;
    this.draft.rounds = config.rounds;
    this.draft.finallyOnError = config.finallyOnError === true;
    this.draft.start = config.start.map((step) => ({ ...step }));
    this.draft.tree = draftSections[0]!.tree;
    this.draft.treeTimeout = draftSections[0]!.treeTimeout;
    this.draft.loop = draftSections[0]!.loop.map((step) => ({ ...step }));
    this.draft.extraSections = draftSections.slice(1).map((section) => ({ tree: section.tree, treeTimeout: section.treeTimeout, loop: section.loop.map((step) => ({ ...step })) }));
    this.draft.finally = config.finally.map((step) => ({ ...step }));
    this.selection = 0;
    this.savedSnapshot = this.snapshot();
    this.dirty = false;
    this.clearUndo();
    if (errors.length > 0 && flash === undefined) flash = errors[0]!;
    return { ok: true, flash };
  }

  private switchWorkflow(): void {
    if (this.dirty) {
      this.setFlash("Save or undo your changes before switching workflows");
      return;
    }
    this.startInput(`workflow number (current: ${this.index}): `, (value) => {
      const index = value.trim();
      if (!isNumericString(index)) return "Workflow number must be a number.";
      const { exists } = getWorkflowConfig(index);
      const result = this.loadWorkflow(index);
      if (!result.ok) {
        this.setFlash(result.flash);
        return null;
      }
      this.popup(result.flash ?? (exists ? `Editing workflow ${index}` : `Workflow ${index} is new. Press s to create it`));
      return null;
    });
  }

  private deleteWorkflow(): void {
    const { exists } = getWorkflowConfig(this.index);
    if (!exists) {
      this.setFlash(`Workflow ${this.index} does not exist. Nothing to delete`);
      return;
    }
    const { workflows } = getWorkflows();
    const referencedBy = Object.entries(workflows)
      .filter(([num, config]) => num !== this.index && referencedWorkflows(config).includes(this.index))
      .map(([num]) => num);
    if (referencedBy.length > 0) {
      this.setFlash(`Workflow ${this.index} is used by workflow${referencedBy.length === 1 ? "" : "s"} ${referencedBy.join(", ")}. Remove the reference first.`);
      return;
    }
    this.startInput(`delete workflow ${this.index}? type y to confirm: `, (value) => {
      const answer = value.trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return null;
      const deleted = this.index;
      try {
        deleteWorkflowConfig(deleted);
      } catch (err) {
        this.setFlash(`Could not delete workflow ${deleted}: ${errorMessage(err)}`);
        return null;
      }
      this.loadWorkflow("1");
      this.popup(`Workflow ${deleted} deleted`);
      return null;
    });
  }

  protected snapshot(): WorkflowSnapshot {
    return {
      rounds: this.draft.rounds,
      start: this.draft.start.map((step) => ({ ...step })),
      tree: this.draft.tree,
      treeTimeout: this.draft.treeTimeout,
      loop: this.draft.loop.map((step) => ({ ...step })),
      extraSections: this.draft.extraSections.map((section) => ({ tree: section.tree, treeTimeout: section.treeTimeout, loop: section.loop.map((step) => ({ ...step })) })),
      finally: this.draft.finally.map((step) => ({ ...step })),
      finallyOnError: this.draft.finallyOnError,
      selection: this.selection,
    };
  }
  private restore(snap: WorkflowSnapshot): void {
    this.draft.rounds = snap.rounds;
    this.draft.start = snap.start;
    this.draft.tree = snap.tree;
    this.draft.treeTimeout = snap.treeTimeout;
    this.draft.loop = snap.loop;
    this.draft.extraSections = snap.extraSections;
    this.draft.finally = snap.finally;
    this.draft.finallyOnError = snap.finallyOnError;
    this.selection = Math.min(snap.selection, this.rowCount() - 1);
  }
  private equalsSaved(): boolean {
    const current = this.snapshot();
    return current.rounds === this.savedSnapshot.rounds
      && current.tree === this.savedSnapshot.tree
      && current.treeTimeout === this.savedSnapshot.treeTimeout
      && deepEqual(current.start, this.savedSnapshot.start)
      && deepEqual(current.loop, this.savedSnapshot.loop)
      && deepEqual(current.extraSections, this.savedSnapshot.extraSections)
      && deepEqual(current.finally, this.savedSnapshot.finally)
      && current.finallyOnError === this.savedSnapshot.finallyOnError;
  }
  private undo(): void {
    this.performUndo((snap) => this.restore(snap as WorkflowSnapshot), () => this.equalsSaved());
  }

  private sectionCount(): number {
    return 1 + this.draft.extraSections.length;
  }
  private sectionLoop(section: number): LoopStep[] {
    return section === 0 ? this.draft.loop : this.draft.extraSections[section - 1]!.loop;
  }
  private sectionTree(section: number): string {
    return section === 0 ? this.draft.tree : this.draft.extraSections[section - 1]!.tree;
  }
  private sectionTreeTimeout(section: number): number | undefined {
    return section === 0 ? this.draft.treeTimeout : this.draft.extraSections[section - 1]!.treeTimeout;
  }
  private setSectionTree(section: number, value: string): void {
    if (section === 0) this.draft.tree = value;
    else this.draft.extraSections[section - 1]!.tree = value;
  }
  private setSectionTreeTimeout(section: number, value: number | undefined): void {
    if (section === 0) this.draft.treeTimeout = value;
    else this.draft.extraSections[section - 1]!.treeTimeout = value;
  }
  private sectionOffset(section: number): number {
    let offset = this.draft.start.length;
    for (let s = 0; s < section; s++) offset += 1 + this.sectionLoop(s).length;
    return offset;
  }
  private finallyOffset(): number {
    return this.sectionOffset(this.sectionCount());
  }
  private rowCount(): number {
    return this.finallyOffset() + this.draft.finally.length;
  }
  private rowInfo(index: number): { kind: SelectableKind; section: number; position: number } {
    if (index < this.draft.start.length) return { kind: "start", section: 0, position: index };
    for (let s = 0; s < this.sectionCount(); s++) {
      const offset = this.sectionOffset(s);
      if (index === offset) return { kind: "tree", section: s, position: 0 };
      const loop = this.sectionLoop(s);
      if (index < offset + 1 + loop.length) return { kind: "loop", section: s, position: index - offset - 1 };
    }
    return { kind: "finally", section: 0, position: index - this.finallyOffset() };
  }
  private selectLoopRow(section: number, position: number): void {
    this.selection = this.sectionOffset(section) + 1 + position;
  }
  private selectFinallyRow(position: number): void {
    this.selection = this.finallyOffset() + position;
  }
  private addSection(): void {
    if (this.draft.extraSections.length >= MAX_LOOP_SECTIONS - 1) {
      this.setFlash(`At most ${MAX_LOOP_SECTIONS} loop sections are supported`);
      return;
    }
    this.mutate(() => {
      this.draft.extraSections.push({ tree: "1", loop: [] });
    });
    this.selection = this.sectionOffset(this.sectionCount() - 1);
    this.popup("Loop section added. Press s to save.");
  }
  private deleteSection(section: number): void {
    if (section === 0) {
      this.setFlash("The first loop section cannot be deleted");
      return;
    }
    this.mutate(() => {
      this.draft.extraSections.splice(section - 1, 1);
    });
    this.selection = Math.min(this.selection, this.rowCount() - 1);
    this.popup("Loop section deleted. Press s to save.");
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
    const { kind, section, position } = this.rowInfo(this.selection);
    if (matchesKey(data, "e")) {
      this.editRow(kind, section, position);
      return true;
    }
    if (matchesKey(data, "a")) {
      this.addRow(kind, section);
      return true;
    }
    if (matchesKey(data, "x")) {
      this.deleteRow(kind, section, position);
      return true;
    }
    if (matchesKey(data, "shift+j")) {
      this.moveRow(kind, section, position, 1);
      return true;
    }
    if (matchesKey(data, "shift+k")) {
      this.moveRow(kind, section, position, -1);
      return true;
    }
    if (matchesKey(data, "t")) {
      this.toggleIfChanges(kind, section, position);
      return true;
    }
    if (matchesKey(data, "o")) {
      this.editTimeout(kind, section, position);
      return true;
    }
    if (matchesKey(data, "u")) {
      this.undo();
      return true;
    }
    if (matchesKey(data, "w")) {
      this.switchWorkflow();
      return true;
    }
    if (matchesKey(data, "d")) {
      this.deleteWorkflow();
      return true;
    }
    if (matchesKey(data, "[")) {
      if (this.draft.rounds > 1) {
        this.mutate(() => { this.draft.rounds -= 1; });
        this.popup(`Rounds: ${this.draft.rounds}. Press s to save.`);
      }
      return true;
    }
    if (matchesKey(data, "]")) {
      if (this.draft.rounds < MAX_ROUNDS) {
        this.mutate(() => { this.draft.rounds += 1; });
        this.popup(`Rounds: ${this.draft.rounds}. Press s to save.`);
      }
      return true;
    }
    if (matchesKey(data, "f")) {
      this.mutate(() => { this.draft.finallyOnError = !this.draft.finallyOnError; });
      this.popup(`finallyOnError ${this.draft.finallyOnError ? "enabled" : "disabled"}. Press s to save.`);
      return true;
    }
    if (matchesKey(data, "n")) {
      this.addSection();
      return true;
    }
    if (matchesKey(data, "s")) {
      this.save();
      return true;
    }
    return false;
  }

  private commitIndexEdit(prompt: string, current: string, apply: (value: string) => void): void {
    this.commitInput(`${prompt} (current: ${current}): `, (value) => {
      return isNumericString(value) ? null : "Index must be a number.";
    }, apply);
  }

  private editStepIndex(target: LoopStep[], position: number, action: "msg" | "cmd" | "workflow", current: string): void {
    const label = action === "msg" ? "message" : action === "cmd" ? "command" : "workflow";
    this.commitIndexEdit(`${label} index for ${action} step`, current, (value) => {
      const step = target[position]!;
      target[position] = action === "msg" ? { ...step, msg: value } : action === "cmd" ? { ...step, cmd: value } : { ...step, workflow: value };
      this.popup("Step updated. Press s to save.");
    });
  }

  private editRow(kind: SelectableKind, section: number, position: number): void {
    if (kind === "tree") {
      const current = this.sectionTree(section);
      this.commitIndexEdit("tree anchor message index", current, (value) => {
        this.setSectionTree(section, value);
        this.popup("Tree anchor updated. Press s to save.");
      });
      return;
    }
    const target = kind === "start" ? this.draft.start : kind === "loop" ? this.sectionLoop(section) : this.draft.finally;
    const step = target[position]!;
    if (step.msg !== undefined) {
      this.editStepIndex(target, position, "msg", step.msg);
    } else if (step.cmd !== undefined) {
      this.editStepIndex(target, position, "cmd", step.cmd);
    } else if (step.workflow !== undefined) {
      this.editStepIndex(target, position, "workflow", step.workflow);
    } else if (step.commit === true) {
      this.setFlash("Commit steps have no index to edit");
    } else if (step.tree !== undefined) {
      this.commitIndexEdit("tree anchor message index", step.tree, (value) => {
        target[position] = { ...step, tree: value };
        this.popup("Step updated. Press s to save.");
      });
    }
  }

  private addStepPrompt(prompt: string, target: LoopStep[], select: () => void): void {
    this.commitInput(prompt, (value) => {
      return /^(?:msg|cmd|wf)\s+(\d+)$|^commit$/.test(value) ? null : "Expected: msg <number>, cmd <number>, wf <number> or commit.";
    }, (value) => {
      if (value === "commit") {
        target.push({ commit: true });
      } else {
        const match = value.match(/^(msg|cmd|wf)\s+(\d+)$/)!;
        const kind = match[1]!;
        target.push(kind === "msg" ? { msg: match[2]! } : kind === "cmd" ? { cmd: match[2]! } : { workflow: match[2]! });
      }
      select();
      this.popup("Step added. Press s to save.");
    });
  }

  private addRow(kind: SelectableKind, section: number): void {
    if (kind === "start") {
      this.addStepPrompt("add start step (msg <n> | cmd <n> | wf <n>): ", this.draft.start, () => {
        this.selection = this.draft.start.length - 1;
      });
      return;
    }
    if (kind === "loop" || kind === "tree") {
      const target = this.sectionLoop(section);
      this.addStepPrompt("add loop step (msg <n> | cmd <n> | wf <n>): ", target, () => {
        this.selectLoopRow(section, target.length - 1);
      });
      return;
    }
    this.addStepPrompt("add finally step (msg <n> | cmd <n> | wf <n>): ", this.draft.finally, () => {
      this.selectFinallyRow(this.draft.finally.length - 1);
    });
  }

  private deleteRow(kind: SelectableKind, section: number, position: number): void {
    if (kind === "tree") {
      this.deleteSection(section);
      return;
    }
    this.mutate(() => {
      if (kind === "start") {
        this.draft.start.splice(position, 1);
      } else if (kind === "loop") {
        this.sectionLoop(section).splice(position, 1);
      } else {
        this.draft.finally.splice(position, 1);
      }
      this.selection = Math.min(this.selection, this.rowCount() - 1);
    });
    this.popup("Step deleted. Press s to save.");
  }

  private swapRows(target: LoopStep[], position: number, delta: number): boolean {
    const targetIndex = position + delta;
    if (targetIndex < 0 || targetIndex >= target.length) return false;
    [target[position], target[targetIndex]] = [target[targetIndex]!, target[position]!];
    return true;
  }

  private moveRow(kind: SelectableKind, section: number, position: number, delta: number): void {
    if (kind === "tree") {
      this.setFlash("The tree step is fixed as the first step of the loop section");
      return;
    }
    const target = kind === "start" ? this.draft.start : kind === "loop" ? this.sectionLoop(section) : this.draft.finally;
    const snap = this.snapshot();
    if (!this.swapRows(target, position, delta)) return;
    this.pushUndo(snap);
    this.selection += delta;
    this.dirty = true;
    this.popup("Step moved. Press s to save.");
  }

  private toggleIfChanges(kind: SelectableKind, section: number, position: number): void {
    if (kind !== "loop") {
      this.setFlash("if-changes applies to loop msg, cmd and workflow steps");
      return;
    }
    const step = this.sectionLoop(section)[position]!;
    if (step.msg === undefined && step.cmd === undefined && step.workflow === undefined) {
      this.setFlash("if-changes applies to loop msg, cmd and workflow steps");
      return;
    }
    this.mutate(() => {
      if (step.onlyIfChanges) {
        const next = { ...step } as Record<string, unknown>;
        delete next.onlyIfChanges;
        this.sectionLoop(section)[position] = next as LoopStep;
      } else {
        this.sectionLoop(section)[position] = { ...step, onlyIfChanges: true };
      }
    });
    this.popup("if-changes toggled. Press s to save.");
  }
  private editTimeout(kind: SelectableKind, section: number, position: number): void {
    if (kind === "tree") {
      const current = this.sectionTreeTimeout(section);
      const prompt = current === undefined ? "timeout ms (1000-600000, empty to clear): " : `timeout ms (current: ${current}, empty to clear): `;
      this.commitInput(prompt, (value) => {
        if (value === "") return null;
        return /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 600000 ? null : "Timeout must be 1000-600000 or empty to clear.";
      }, (value) => {
        if (value === "") this.setSectionTreeTimeout(section, undefined);
        else this.setSectionTreeTimeout(section, Number(value));
        this.popup("Timeout updated. Press s to save.");
      });
      return;
    }
    const target = kind === "start" ? this.draft.start : kind === "loop" ? this.sectionLoop(section) : this.draft.finally;
    const step = target[position]!;
    const current = step.timeout;
    const prompt = current === undefined ? "timeout ms (1000-600000, empty to clear): " : `timeout ms (current: ${current}, empty to clear): `;
    this.commitInput(prompt, (value) => {
      if (value === "") return null;
      return /^\d+$/.test(value) && Number(value) >= 1000 && Number(value) <= 600000 ? null : "Timeout must be 1000-600000 or empty to clear.";
    }, (value) => {
      if (value === "") {
        const next = { ...step } as Record<string, unknown>;
        delete next.timeout;
        target[position] = next as LoopStep;
      } else {
        target[position] = { ...step, timeout: Number(value) };
      }
      this.popup("Timeout updated. Press s to save.");
    });
  }
  private buildConfig(): WorkflowConfig {
    const config: WorkflowConfig = {
      rounds: this.draft.rounds,
      start: [...this.draft.start],
      loop: [{ tree: this.draft.tree, ...(this.draft.treeTimeout !== undefined ? { timeout: this.draft.treeTimeout } : {}) }, ...this.draft.loop.map((step) => ({ ...step }))],
      finally: this.draft.finally.map((step) => ({ ...step })),
      finallyOnError: this.draft.finallyOnError || undefined,
    };
    for (let i = 0; i < this.draft.extraSections.length; i++) {
      const section = this.draft.extraSections[i]!;
      (config as unknown as Record<string, unknown>)[`loop${i + 2}`] = [{ tree: section.tree, ...(section.treeTimeout !== undefined ? { timeout: section.treeTimeout } : {}) }, ...section.loop.map((step) => ({ ...step }))];
    }
    return config;
  }
  private lintWarningFor(config: WorkflowConfig): string | null {
    const { workflows } = getWorkflows();
    const nextWorkflows = { ...workflows, [this.index]: config };
    const issues = getWorkflowIssues(config, getMessages(), getCommands(), nextWorkflows, this.index);
    if (issues.missingMessages.length > 0) return `Missing messages: ${issues.missingMessages.join(", ")}. Add and save them in the Messages tab first.`;
    if (issues.missingCommands.length > 0) return `Missing commands: ${issues.missingCommands.join(", ")}. Add and save them in the Commands tab first.`;
    if (issues.missingWorkflows.length > 0) return `Missing workflows: ${issues.missingWorkflows.join(", ")}. Create and save them first (press w to switch).`;
    if (issues.cycle !== null) return `Circular workflow reference: ${issues.cycle.join(" → ")}. Break the cycle in the referenced workflow first.`;
    if (issues.hasBadSection) return `The first step of every loop section must be a tree step (context reset)`;
    return null;
  }
  private lintWarning(): string | null {
    if (this.loadFailedIndex !== null) return `Workflow ${this.loadFailedIndex} has no tree step. Fix workflow.json first.`;
    return this.lintWarningFor(this.buildConfig());
  }
  override getAboveContentLine(innerWidth: number): string[] {
    const lines = super.getAboveContentLine(innerWidth);
    const warning = this.lintWarning();
    if (warning !== null && warning !== this.flash) {
      const text = truncate(` ${warning}`, innerWidth);
      lines.push(this.theme.fg("warning", text));
    }
    return lines;
  }
  save(): void {
    if (this.loadFailedIndex !== null) {
      this.setFlash(`Workflow ${this.loadFailedIndex} has no tree step. Fix workflow.json first.`);
      return;
    }
    const config = this.buildConfig();
    const warning = this.lintWarningFor(config);
    if (warning !== null) {
      this.setFlash(warning);
      return;
    }
    try {
      setWorkflowConfig(this.index, config);
    } catch (err) {
      this.setFlash(`Could not save workflow.json: ${errorMessage(err)}`);
      return;
    }
    this.savedSnapshot = this.snapshot();
    this.dirty = false;
    this.popup(`workflow.json saved (workflow ${this.index})`);
  }

  render(innerWidth: number, height: number): string[] {
    const th = this.theme;
    const messages = getMessages();
    const commands = getCommands();
    const { workflows } = getWorkflows();
    const lines: string[] = [];
    const row = (text: string, selected: boolean) => {
      const trimmed = truncate(` ${text}`, innerWidth);
      lines.push(selected ? th.bg("selectedBg", th.fg("text", trimmed)) : th.fg("text", trimmed));
    };
    const treePreview = (index: string) => (index === "0" ? "new session" : storePreview(messages, index));
    const workflowPreview = (index: string) => {
      const config = workflows[index];
      if (config === undefined) return "(missing)";
      return `${config.rounds} round${config.rounds === 1 ? "" : "s"} (${config.start.length} start, ${totalLoopSteps(config)} loop, ${config.finally.length} finally)`;
    };
    const renderSteps = (steps: LoopStep[], selected: (i: number) => boolean) => {
      steps.forEach((step, i) => {
        const suffix = `${step.onlyIfChanges ? " [if-changes]" : ""}${step.timeout !== undefined ? ` [timeout ${step.timeout}ms]` : ""}`;
        if (step.msg !== undefined) {
          row(`msg ${step.msg}${suffix}: ${storePreview(messages, step.msg)}`, selected(i));
        } else if (step.cmd !== undefined) {
          row(`cmd ${step.cmd}${suffix}: ${storePreview(commands, step.cmd)}`, selected(i));
        } else if (step.workflow !== undefined) {
          row(`wf ${step.workflow}${suffix}: ${workflowPreview(step.workflow)}`, selected(i));
        } else if (step.commit === true) {
          row(`commit: stage and commit all changes${suffix}`, selected(i));
        } else if (step.tree !== undefined) {
          row(`tree → ${step.tree}${suffix}: ${treePreview(step.tree)}`, selected(i));
        }
      });
    };
    lines.push(th.fg("dim", truncate(` Workflow ${this.index} · Rounds: ${this.draft.rounds} · fin-err: ${this.draft.finallyOnError ? "on" : "off"}   ([ ] change · f toggle · w switch)`, innerWidth)));
    lines.push(th.fg("dim", " start"));
    renderSteps(this.draft.start, (i) => this.selection === i);
    for (let s = 0; s < this.sectionCount(); s++) {
      lines.push(th.fg("dim", s === 0 ? " loop" : ` loop ${s + 1}`));
      const offset = this.sectionOffset(s);
      row(`tree → ${this.sectionTree(s)}${this.sectionTreeTimeout(s) !== undefined ? ` [timeout ${this.sectionTreeTimeout(s)}ms]` : ""}: ${treePreview(this.sectionTree(s))}  (fixed first)`, this.selection === offset);
      renderSteps(this.sectionLoop(s), (i) => this.selection === offset + 1 + i);
    }
    lines.push(th.fg("dim", " finally"));
    renderSteps(this.draft.finally, (i) => this.selection === this.finallyOffset() + i);
    while (lines.length < height) lines.push(th.fg("dim", "~"));
    return lines.slice(0, height);
  }
}

abstract class StoreTab extends BaseEditorTab implements EditorTab {
  readonly draft: Record<string, string>;
  readonly keys: string[];
  private selection = 0;
  private scroll = 0;
  private savedSnapshot: StoreSnapshot;

  protected constructor(
    private readonly theme: Theme,
    readonly name: string,
    readonly footerHints: string,
  ) {
    super();
    this.draft = { ...this.load() };
    this.keys = Object.keys(this.draft).sort(compareNumericKeys);
    this.savedSnapshot = this.snapshot();
  }

  protected snapshot(): StoreSnapshot {
    return { draft: { ...this.draft }, keys: [...this.keys], selection: this.selection };
  }
  private restore(snap: StoreSnapshot): void {
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
    this.performUndo((snap) => this.restore(snap as StoreSnapshot), () => this.equalsSaved());
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
      this.setFlash(`No ${this.noun.toLowerCase()}s yet. Press a to add one.`);
      return;
    }
    const key = this.keys[this.selection]!;
    this.commitInput(`content for ${this.noun.toLowerCase()} ${key} (current: ${truncate(this.draft[key]!, 30)}): `, (value) => {
      return value.length >= 5 ? null : `${this.noun} must be at least 5 characters.`;
    }, (value) => {
      this.draft[key] = value;
      this.popup(`${this.noun} ${key} updated. Press s to save.`);
    });
  }

  private addEntry(): void {
    const key = this.nextKey();
    this.commitInput(`content for new ${this.noun.toLowerCase()} ${key}: `, (value) => {
      return value.length >= 5 ? null : `${this.noun} must be at least 5 characters.`;
    }, (value) => {
      this.draft[key] = value;
      this.keys.push(key);
      this.keys.sort(compareNumericKeys);
      this.selection = this.keys.indexOf(key);
      this.popup(`${this.noun} ${key} added. Press s to save.`);
    });
  }

  private deleteSelected(): void {
    if (this.keys.length === 0) return;
    const key = this.keys[this.selection]!;
    this.mutate(() => {
      delete this.draft[key];
      this.keys.splice(this.selection, 1);
      this.selection = Math.min(this.selection, Math.max(0, this.keys.length - 1));
    });
    this.popup(`${this.noun} ${key} deleted. Press s to save.`);
  }

  save(): void {
    const { workflows } = getWorkflows();
    const referenced = Object.values(workflows).flatMap((config) => this.referenced(config));
    const removed = [...new Set(referenced.filter((num) => this.savedSnapshot.draft[num] !== undefined && this.draft[num] === undefined))];
    if (removed.length > 0) {
      this.setFlash(`${this.noun}s still used by the workflow: ${removed.join(", ")}. Remove and save them in the Workflow tab first.`);
      return;
    }
    try {
      this.write({ ...this.draft });
    } catch (err) {
      this.setFlash(`Could not save ${this.fileLabel}: ${errorMessage(err)}`);
      return;
    }
    this.savedSnapshot = this.snapshot();
    this.dirty = false;
    this.popup(`${this.fileLabel} saved`);
  }

  render(innerWidth: number, height: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    if (this.keys.length === 0) {
      lines.push(th.fg("dim", ` No ${this.noun.toLowerCase()}s yet. Press a to add one.`));
    }
    const { workflows } = getWorkflows();
    const referencedBy = new Map<string, string[]>();
    for (const [wfIndex, config] of Object.entries(workflows)) {
      for (const num of this.referenced(config)) {
        const list = referencedBy.get(num);
        if (list) list.push(wfIndex);
        else referencedBy.set(num, [wfIndex]);
      }
    }
    const contentHeight = Math.max(0, height - (referencedBy.size > 0 ? 1 : 0));
    const header = (key: string) => ` ${key}${referencedBy.has(key) ? `*${referencedBy.get(key)!.join(",")}` : ""}: `;
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
    if (selEnd > this.scroll + contentHeight) this.scroll = selEnd - contentHeight;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, total - contentHeight)));
    for (let i = this.scroll; i < Math.min(total, this.scroll + contentHeight); i++) {
      const entry = entries[i]!;
      const text = truncate(entry.text, innerWidth);
      lines.push(entry.selected ? th.bg("selectedBg", th.fg("text", text)) : th.fg("text", text));
    }
    if (referencedBy.size > 0) lines.push(th.fg("dim", truncate(" *N = referenced by workflow N", innerWidth)));
    while (lines.length < height) lines.push(th.fg("dim", "~"));
    return lines.slice(0, height);
  }
}

export class MessagesTab extends StoreTab {
  constructor(theme: Theme) {
    super(theme, "Messages", "j/k sel · e edit · a add · x del · u undo · s save");
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
  constructor(theme: Theme) {
    super(theme, "Commands", "j/k sel · e edit · a add · x del · u undo · s save");
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

class Popup {
  constructor(
    private readonly theme: Theme,
    private readonly lines: string[],
    private readonly hint: string,
    private readonly onDismiss: () => void,
    private readonly onConfirm?: () => void,
  ) {}

  handleInput(data: string): void {
    if (this.onConfirm && matchesKey(data, "q")) {
      this.onConfirm();
    } else {
      this.onDismiss();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const content = [...this.lines];
    if (this.hint !== "") content.push(this.theme.fg("dim", this.hint));
    return frameLines(this.theme, width, content);
  }
}

class InputPopup {
  constructor(
    private readonly theme: Theme,
    private readonly getLines: (width: number) => string[],
  ) {}

  handleInput(_data: string): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const content = this.getLines(width - 4).map((line) => this.theme.fg("text", line));
    content.push(this.theme.fg("dim", " Enter to confirm · Esc to cancel"));
    return frameLines(this.theme, width, content);
  }
}

export class WorkflowEditorOverlay {
  private activeTab = 0;
  private confirmPopupHandle: OverlayHandle | undefined;
  private confirmPopupTimer: ReturnType<typeof setTimeout> | undefined;
  private popupQueue: string[] = [];
  private popupText: string | null = null;
  private popupHandle: OverlayHandle | undefined;
  private popupTimer: ReturnType<typeof setTimeout> | undefined;
  private inputPopupHandle: OverlayHandle | undefined;

  constructor(private readonly opts: WorkflowEditorOverlayOptions) {
    for (const tab of opts.tabs) {
      tab.setPopup((text) => this.showPopup(text));
      tab.setInputListener((active) => {
        if (active) this.showInputPopup();
        else this.hideInputPopup();
      });
    }
  }

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

  private close(): void {
    this.hideConfirmPopup();
    this.hideInputPopup();
    this.popupQueue.length = 0;
    this.hidePopup();
    this.opts.done();
  }

  private showInputPopup(): void {
    if (this.inputPopupHandle) return;
    const popup = new InputPopup(this.opts.theme, (width) => this.active.getInputLines(width) ?? []);
    this.inputPopupHandle = this.opts.tui.showOverlay(popup, {
      anchor: "center",
      width: "70%",
      minWidth: 50,
      nonCapturing: true,
    });
  }

  private hideInputPopup(): void {
    this.inputPopupHandle?.hide();
    this.inputPopupHandle = undefined;
  }

  showConsolePopup(text: string): void {
    if (text === "" || text === this.popupText || this.popupQueue.includes(text)) return;
    if (this.popupHandle !== undefined) {
      this.popupQueue.push(text);
      return;
    }
    this.showPopupNow(text, CONSOLE_POPUP_HINT, true);
  }

  showPopup(text: string, hint = "", capturing = false): void {
    this.dismissPopup();
    this.showPopupNow(text, hint, capturing);
  }

  bringConsolePopupToFront(): void {
    this.popupHandle?.focus();
  }

  private showPopupNow(text: string, hint: string, capturing: boolean): void {
    this.popupText = text;
    const width = Math.min(MAX_POPUP_WIDTH, Math.max(MIN_POPUP_WIDTH, visibleWidth(text) + 10));
    const wrapped = wrapText(text, Math.max(1, width - 3)).map((line) => ` ${line}`);
    const content = wrapped.length > MAX_POPUP_LINES ? [...wrapped.slice(0, MAX_POPUP_LINES), " …"] : wrapped;
    const popup = new Popup(
      this.opts.theme,
      content.map((line) => this.opts.theme.fg("warning", line)),
      hint,
      () => this.hidePopup(),
    );
    this.popupHandle = this.opts.tui.showOverlay(popup, {
      anchor: "center",
      width,
      nonCapturing: !capturing,
    });
    this.popupTimer = setTimeout(() => this.hidePopup(), POPUP_MS);
  }

  private dismissPopup(): void {
    if (this.popupTimer) {
      clearTimeout(this.popupTimer);
      this.popupTimer = undefined;
    }
    this.popupHandle?.hide();
    this.popupHandle = undefined;
    this.popupText = null;
  }

  private hidePopup(): void {
    this.dismissPopup();
    const next = this.popupQueue.shift();
    if (next !== undefined) this.showPopupNow(next, CONSOLE_POPUP_HINT, true);
  }

  private showConfirmPopup(): void {
    if (this.confirmPopupHandle) return;
    const text = "Unsaved changes. Press q again to close";
    const popup = new Popup(
      this.opts.theme,
      [this.opts.theme.fg("warning", ` ${text}`)],
      " q to close · any other key to keep editing",
      () => this.hideConfirmPopup(),
      () => this.close(),
    );
    this.confirmPopupHandle = this.opts.tui.showOverlay(popup, {
      anchor: "center",
      width: Math.min(60, visibleWidth(text) + 10),
    });
    this.confirmPopupTimer = setTimeout(() => {
      this.hideConfirmPopup();
    }, POPUP_MS);
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
      this.close();
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
    const borderTop = th.fg("border", `╭${"─".repeat(innerW)}╮`);
    const borderSep = th.fg("border", `├${"─".repeat(innerW)}┤`);
    const borderBottom = th.fg("border", `╰${"─".repeat(innerW)}╯`);

    lines.push(borderTop);
    lines.push(frameRow(th, innerW, ` ${th.fg("accent", th.bold(this.opts.title))}`));

    let tabBar = " ";
    for (let i = 0; i < this.opts.tabs.length; i++) {
      const tab = this.opts.tabs[i]!;
      const marker = tab.dirty ? "*" : "";
      tabBar += i === this.activeTab ? th.fg("accent", th.bold(`[${tab.name}${marker}]`)) : th.fg("dim", `[${tab.name}${marker}]`);
      if (i < this.opts.tabs.length - 1) tabBar += " ";
    }
    lines.push(frameRow(th, innerW, tabBar));

    if (aboveLines.length > 0) {
      for (const aboveLine of aboveLines) lines.push(frameRow(th, innerW, aboveLine));
    } else {
      lines.push(borderSep);
    }

    const contentLines = this.active.render(innerW, contentHeight);
    for (let i = 0; i < contentHeight; i++) {
      lines.push(frameRow(th, innerW, contentLines[i] ?? ""));
    }

    lines.push(borderSep);
    for (const hintLine of hintLines) {
      lines.push(frameRow(th, innerW, th.fg("dim", hintLine)));
    }
    lines.push(borderBottom);
    return lines;
  }
}
