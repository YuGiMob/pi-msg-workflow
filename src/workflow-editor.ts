import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { getMessages, setMessages } from "./messages.js";
import { getCommands, setCommands } from "./commands.js";
import { MAX_ROUNDS } from "./constants.js";
import { getWorkflowConfig, setWorkflowConfig, referencedIndices, referencedCommands, type LoopStep, type WorkflowConfig } from "./workflow-config.js";

export interface EditorTab {
  readonly name: string;
  dirty: boolean;
  readonly footerHints: string;
  handleInput(data: string): boolean;
  getAboveContentLine(innerWidth: number): string | null;
  render(innerWidth: number, height: number): string[];
  save(): void;
}

export type Notify = (text: string, kind: "info" | "warning" | "error") => void;

interface InputState {
  prompt: string;
  buffer: string;
  commit(value: string): string | null;
}

const CONTENT_HEIGHT = 24;
const MAX_MESSAGE_PREVIEW = 40;
const FLASH_MS = 2500;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  let result = "";
  let used = 0;
  for (const ch of text) {
    const w = visibleWidth(ch);
    if (used + w > width - 1) break;
    result += ch;
    used += w;
  }
  return `${result}…`;
}

abstract class BaseEditorTab implements EditorTab {
  abstract readonly name: string;
  abstract readonly footerHints: string;
  dirty = false;
  protected flash: string | null = null;
  protected input: InputState | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;

  protected setFlash(text: string): void {
    this.flash = text;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = null;
    }, FLASH_MS);
  }

  protected startInput(prompt: string, commit: (value: string) => string | null): void {
    this.input = { prompt, buffer: "", commit };
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
      this.input.buffer = this.input.buffer.slice(0, -1);
      return true;
    }
    if (data.startsWith(PASTE_START) && data.endsWith(PASTE_END)) {
      this.input.buffer += data.slice(PASTE_START.length, -PASTE_END.length).replace(/[\r\n]+/g, " ");
      return true;
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.input.buffer += data;
      return true;
    }
    return true;
  }

  getAboveContentLine(_innerWidth: number): string | null {
    if (this.input) return ` ${this.input.prompt}${this.input.buffer}▏`;
    if (this.flash) return ` ${this.flash}`;
    return null;
  }

  abstract handleInput(data: string): boolean;
  abstract render(innerWidth: number, height: number): string[];
  abstract save(): void;
}

interface WorkflowDraft {
  rounds: number;
  start: string[];
  tree: string;
  loop: LoopStep[];
}

type SelectableKind = "start" | "tree" | "loop";

export class WorkflowTab extends BaseEditorTab implements EditorTab {
  readonly name = "Workflow";
  readonly footerHints = "j/k select · e edit · a add · x delete · J/K move · t if-changes · [ ] rounds · s save";
  readonly draft: WorkflowDraft;
  private selection = 0;

  constructor(private readonly theme: Theme, private readonly notify: Notify) {
    super();
    const { config } = getWorkflowConfig();
    this.draft = {
      rounds: config.rounds,
      start: [...config.start],
      tree: config.loop[0]?.tree ?? "1",
      loop: config.loop.slice(1).map((step) => ({ ...step })),
    };
  }

  private rowCount(): number {
    return this.draft.start.length + 1 + this.draft.loop.length;
  }

  private rowInfo(index: number): { kind: SelectableKind; position: number } {
    if (index < this.draft.start.length) return { kind: "start", position: index };
    if (index === this.draft.start.length) return { kind: "tree", position: 0 };
    return { kind: "loop", position: index - this.draft.start.length - 1 };
  }

  private selectLoopRow(position: number): void {
    this.selection = this.draft.start.length + 1 + position;
  }

  handleInput(data: string): boolean {
    if (this.handleInputMode(data)) return true;
    if (matchesKey(data, Key.down) || data === "j") {
      this.selection = Math.min(this.selection + 1, this.rowCount() - 1);
      return true;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.selection = Math.max(this.selection - 1, 0);
      return true;
    }
    const { kind, position } = this.rowInfo(this.selection);
    if (data === "e") {
      this.editRow(kind, position);
      return true;
    }
    if (data === "a") {
      this.addRow(kind);
      return true;
    }
    if (data === "x") {
      this.deleteRow(kind, position);
      return true;
    }
    if (data === "J") {
      this.moveRow(kind, position, 1);
      return true;
    }
    if (data === "K") {
      this.moveRow(kind, position, -1);
      return true;
    }
    if (data === "t") {
      this.toggleIfChanges(kind, position);
      return true;
    }
    if (data === "[") {
      this.draft.rounds = Math.max(1, this.draft.rounds - 1);
      this.dirty = true;
      return true;
    }
    if (data === "]") {
      this.draft.rounds = Math.min(MAX_ROUNDS, this.draft.rounds + 1);
      this.dirty = true;
      return true;
    }
    if (data === "s") {
      this.save();
      return true;
    }
    return false;
  }

  private editRow(kind: SelectableKind, position: number): void {
    if (kind === "start") {
      const current = this.draft.start[position]!;
      this.startInput(`message index for start step (current: ${current}): `, (value) => {
        const index = value.trim();
        if (!/^\d+$/.test(index)) return "Index must be a number.";
        this.draft.start[position] = index;
        this.dirty = true;
        return null;
      });
      return;
    }
    if (kind === "tree") {
      const current = this.draft.tree;
      this.startInput(`tree anchor message index (current: ${current}): `, (value) => {
        const index = value.trim();
        if (!/^\d+$/.test(index)) return "Index must be a number.";
        this.draft.tree = index;
        this.dirty = true;
        return null;
      });
      return;
    }
    const step = this.draft.loop[position]!;
    if (step.send !== undefined) {
      this.startInput(`message index for send step (current: ${step.send}): `, (value) => {
        const index = value.trim();
        if (!/^\d+$/.test(index)) return "Index must be a number.";
        this.draft.loop[position] = { ...step, send: index };
        this.dirty = true;
        return null;
      });
      return;
    }
    if (step.cmd !== undefined) {
      this.startInput(`command index for cmd step (current: ${step.cmd}): `, (value) => {
        const index = value.trim();
        if (!/^\d+$/.test(index)) return "Index must be a number.";
        this.draft.loop[position] = { ...step, cmd: index };
        this.dirty = true;
        return null;
      });
      return;
    }
  }

  private addRow(kind: SelectableKind): void {
    if (kind === "tree") {
      this.setFlash("The tree step is fixed as the first loop step; edit its index with e");
      return;
    }
    if (kind === "start") {
      this.startInput("message index to add to start: ", (value) => {
        const index = value.trim();
        if (!/^\d+$/.test(index)) return "Index must be a number.";
        this.draft.start.push(index);
        this.selection = this.draft.start.length - 1;
        this.dirty = true;
        return null;
      });
      return;
    }
    this.startInput("add loop step (send <n> | cmd <n>): ", (value) => {
      const text = value.trim();
      const sendMatch = text.match(/^send\s+(\d+)$/);
      if (sendMatch) {
        this.draft.loop.push({ send: sendMatch[1]! });
        this.selectLoopRow(this.draft.loop.length - 1);
        this.dirty = true;
        return null;
      }
      const cmdMatch = text.match(/^cmd\s+(\d+)$/);
      if (cmdMatch) {
        this.draft.loop.push({ cmd: cmdMatch[1]! });
        this.selectLoopRow(this.draft.loop.length - 1);
        this.dirty = true;
        return null;
      }
      return "Expected: send <number> or cmd <number>.";
    });
  }

  private deleteRow(kind: SelectableKind, position: number): void {
    if (kind === "tree") {
      this.setFlash("The tree step is fixed as the first loop step");
      return;
    }
    if (kind === "start") {
      this.draft.start.splice(position, 1);
    } else {
      this.draft.loop.splice(position, 1);
    }
    this.selection = Math.min(this.selection, this.rowCount() - 1);
    this.dirty = true;
    this.setFlash("Deleted (press s to save)");
  }

  private moveRow(kind: SelectableKind, position: number, delta: number): void {
    if (kind === "tree") {
      this.setFlash("The tree step is fixed as the first loop step");
      return;
    }
    if (kind === "start") {
      const target = position + delta;
      if (target < 0 || target >= this.draft.start.length) return;
      [this.draft.start[position], this.draft.start[target]] = [this.draft.start[target]!, this.draft.start[position]!];
    } else {
      const target = position + delta;
      if (target < 0 || target >= this.draft.loop.length) return;
      [this.draft.loop[position], this.draft.loop[target]] = [this.draft.loop[target]!, this.draft.loop[position]!];
    }
    this.selection += delta;
    this.dirty = true;
  }

  private toggleIfChanges(kind: SelectableKind, position: number): void {
    if (kind !== "loop") {
      this.setFlash("if-changes applies to send steps");
      return;
    }
    const step = this.draft.loop[position]!;
    if (step.send === undefined) {
      this.setFlash("if-changes applies to send steps");
      return;
    }
    this.draft.loop[position] = step.onlyIfChanges ? { send: step.send } : { ...step, onlyIfChanges: true };
    this.dirty = true;
  }

  save(): void {
    const messages = getMessages();
    const indices = [
      ...this.draft.start,
      this.draft.tree,
      ...this.draft.loop.flatMap((step) => (step.send !== undefined ? [step.send] : [])),
    ];
    const missing = [...new Set(indices)].filter((num) => !messages[num]);
    if (missing.length > 0) {
      this.setFlash(`Missing messages: ${missing.join(", ")} - add them in the Messages tab first`);
      return;
    }
    const commands = getCommands();
    const cmdIndices = this.draft.loop.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : []));
    const missingCommands = [...new Set(cmdIndices)].filter((num) => !commands[num]);
    if (missingCommands.length > 0) {
      this.setFlash(`Missing commands: ${missingCommands.join(", ")} - add them in the Commands tab first`);
      return;
    }
    const config: WorkflowConfig = {
      rounds: this.draft.rounds,
      start: [...this.draft.start],
      loop: [{ tree: this.draft.tree }, ...this.draft.loop.map((step) => ({ ...step }))],
    };
    try {
      setWorkflowConfig(config);
    } catch (err) {
      this.setFlash(`Could not save workflow.json: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
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
    this.draft.start.forEach((num, i) => {
      const preview = messages[num] ? truncate(messages[num]!, MAX_MESSAGE_PREVIEW) : "(missing)";
      row(`msg ${num}: ${preview}`, this.selection === i);
    });
    lines.push(th.fg("dim", " loop"));
    row(`tree → ${this.draft.tree}  (fixed first)`, this.selection === this.draft.start.length);
    this.draft.loop.forEach((step, i) => {
      const selected = this.selection === this.draft.start.length + 1 + i;
      if (step.send !== undefined) {
        row(`send ${step.send}${step.onlyIfChanges ? " [if-changes]" : ""}`, selected);
      } else if (step.cmd !== undefined) {
        const preview = commands[step.cmd] ? truncate(commands[step.cmd]!, MAX_MESSAGE_PREVIEW) : "(missing)";
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

  protected constructor(
    private readonly theme: Theme,
    private readonly notify: Notify,
    readonly name: string,
    readonly footerHints: string,
  ) {
    super();
    this.draft = { ...this.load() };
    this.keys = Object.keys(this.draft).sort((a, b) => Number(a) - Number(b));
  }

  protected abstract load(): Record<string, string>;
  protected abstract write(store: Record<string, string>): void;
  protected abstract referenced(config: WorkflowConfig): string[];
  protected abstract noun: string;
  protected abstract fileLabel: string;

  handleInput(data: string): boolean {
    if (this.handleInputMode(data)) return true;
    if (matchesKey(data, Key.down) || data === "j") {
      this.selection = Math.min(this.selection + 1, Math.max(0, this.keys.length - 1));
      return true;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.selection = Math.max(this.selection - 1, 0);
      return true;
    }
    if (data === "e") {
      this.editSelected();
      return true;
    }
    if (data === "a") {
      this.addEntry();
      return true;
    }
    if (data === "x") {
      this.deleteSelected();
      return true;
    }
    if (data === "s") {
      this.save();
      return true;
    }
    return false;
  }

  private nextKey(): string {
    const max = this.keys.reduce((maxKey, key) => Math.max(maxKey, Number(key)), 0);
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
      this.setFlash(`${this.noun}s still used by the workflow: ${removed.join(", ")} - remove them in the Workflow tab first`);
      return;
    }
    try {
      this.write({ ...this.draft });
    } catch (err) {
      this.setFlash(`Could not save ${this.fileLabel}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
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
    for (let i = 0; i < this.keys.length; i++) {
      const key = this.keys[i]!;
      const label = ` ${key}: ${truncate(this.draft[key]!, MAX_MESSAGE_PREVIEW)}`;
      lines.push(
        i === this.selection
          ? th.bg("selectedBg", th.fg("text", truncate(label, innerWidth)))
          : th.fg("text", truncate(label, innerWidth)),
      );
    }
    while (lines.length < height) lines.push(th.fg("dim", "~"));
    return lines.slice(0, height);
  }
}

export class MessagesTab extends StoreTab {
  constructor(theme: Theme, notify: Notify) {
    super(theme, notify, "Messages", "j/k select · e edit · a add · x delete · s save");
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
    super(theme, notify, "Commands", "j/k select · e edit · a add · x delete · s save");
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
  subtitle: string;
  tabs: EditorTab[];
  theme: Theme;
  done: () => void;
  onNotify: Notify;
}

export class WorkflowEditorOverlay {
  private activeTab = 0;
  private confirmingClose = false;

  constructor(private readonly opts: WorkflowEditorOverlayOptions) {}

  private get active(): EditorTab {
    return this.opts.tabs[this.activeTab]!;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab)) {
      this.activeTab = (this.activeTab + 1) % this.opts.tabs.length;
      this.confirmingClose = false;
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      this.activeTab = (this.activeTab - 1 + this.opts.tabs.length) % this.opts.tabs.length;
      this.confirmingClose = false;
      return;
    }
    const consumed = this.active.handleInput(data);
    if (consumed) {
      this.confirmingClose = false;
      return;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      if (this.confirmingClose) {
        this.opts.done();
        return;
      }
      if (this.opts.tabs.some((tab) => tab.dirty)) {
        this.confirmingClose = true;
        this.opts.onNotify("Unsaved changes - press q again to close", "warning");
        return;
      }
      this.opts.done();
      return;
    }
    this.confirmingClose = false;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const th = this.opts.theme;
    const innerW = width - 2;
    const lines: string[] = [];
    const pad = (text: string) => text + " ".repeat(Math.max(0, innerW - visibleWidth(text)));
    const row = (content: string) => th.fg("border", "│") + pad(content) + th.fg("border", "│");
    const borderTop = th.fg("border", `╭${"─".repeat(innerW)}╮`);
    const borderSep = th.fg("border", `├${"─".repeat(innerW)}┤`);
    const borderBottom = th.fg("border", `╰${"─".repeat(innerW)}╯`);

    lines.push(borderTop);
    lines.push(row(` ${th.fg("accent", th.bold(this.opts.title))}  ${th.fg("dim", `(${this.opts.subtitle})`)}`));

    let tabBar = " ";
    for (let i = 0; i < this.opts.tabs.length; i++) {
      const tab = this.opts.tabs[i]!;
      const marker = tab.dirty ? "*" : "";
      tabBar += i === this.activeTab ? th.fg("accent", th.bold(`[${tab.name}${marker}]`)) : th.fg("dim", `[${tab.name}${marker}]`);
      if (i < this.opts.tabs.length - 1) tabBar += " ";
    }
    lines.push(row(tabBar));

    const aboveLine = this.active.getAboveContentLine(innerW);
    lines.push(aboveLine !== null ? row(truncate(` ${aboveLine}`, innerW)) : borderSep);

    const contentLines = this.active.render(innerW, CONTENT_HEIGHT);
    for (let i = 0; i < CONTENT_HEIGHT; i++) {
      lines.push(row(contentLines[i] ?? ""));
    }

    lines.push(borderSep);
    const hintParts = [this.opts.tabs.length > 1 ? "Tab switch" : "", this.active.footerHints, "q close"].filter(Boolean);
    lines.push(row(th.fg("dim", ` ${hintParts.join(" · ")}`)));
    lines.push(borderBottom);
    return lines;
  }
}
