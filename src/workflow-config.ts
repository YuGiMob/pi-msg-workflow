import { errorMessage } from "./errors.js";
import { compareNumericKeys, readJsonFile, readJsonObject, writeJsonAtomic } from "./json-file.js";
import { MAX_ROUNDS, WORKFLOW_FILE } from "./constants.js";
import { ensureUserData, ensureUserDataDir, userDataPath } from "./user-data.js";

export interface LoopStep {
  tree?: string;
  cmd?: string;
  msg?: string;
  workflow?: string;
  commit?: boolean;
  onlyIfChanges?: boolean;
  timeout?: number;
}

export interface StartStep {
  msg?: string;
  cmd?: string;
  workflow?: string;
  commit?: boolean;
  timeout?: number;
}

export interface WorkflowConfig {
  rounds: number;
  start: StartStep[];
  loop: LoopStep[];
  loop2?: LoopStep[];
  loop3?: LoopStep[];
  loop4?: LoopStep[];
  loop5?: LoopStep[];
  finally: StartStep[];
  finallyOnError?: boolean;
}

const WORKFLOW_PATH = userDataPath(WORKFLOW_FILE);

const DEFAULT_ROUNDS = 2;
const DEFAULT_START: StartStep[] = [
  { msg: "1" },
  { msg: "2" },
  { msg: "3" },
  { msg: "4" },
  { msg: "5" },
];
const DEFAULT_LOOP: LoopStep[] = [
  { tree: "1" },
  { cmd: "1" },
  { msg: "6" },
  { msg: "7" },
  { msg: "5", onlyIfChanges: true },
  { cmd: "1", onlyIfChanges: true },
];
const DEFAULT_FINALLY: StartStep[] = [{ msg: "8" }];

function cloneSteps<T>(steps: T[]): T[] {
  return steps.map((step) => ({ ...(step as unknown as Record<string, unknown>) } as T));
}

function defaultConfig(): WorkflowConfig {
  return {
    rounds: DEFAULT_ROUNDS,
    start: cloneSteps(DEFAULT_START),
    loop: cloneSteps(DEFAULT_LOOP),
    finally: cloneSteps(DEFAULT_FINALLY),
  };
}

function stepAction(value: unknown): { action: string; content: unknown; step: Record<string, unknown> } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const step = value as Record<string, unknown>;
  const keys = Object.keys(step).filter((key) => key !== "onlyIfChanges" && key !== "timeout");
  if (keys.length !== 1) return null;
  const action = keys[0]!;
  return { action, content: step[action], step };
}

export function isNumericString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isValidTimeout(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 600000;
}

function isStepForAllowedActions(value: unknown, allowed: string[], checkOnlyIfChanges: boolean): boolean {
  const entry = stepAction(value);
  if (entry === null) return false;
  if ("timeout" in entry.step && !isValidTimeout(entry.step.timeout)) return false;
  if (entry.action === "commit") return entry.content === true && (!checkOnlyIfChanges || !("onlyIfChanges" in entry.step));
  if (!allowed.includes(entry.action)) return false;
  if (!isNumericString(entry.content)) return false;
  if (checkOnlyIfChanges) {
    if (entry.action === "tree" && "onlyIfChanges" in entry.step) return false;
    return !("onlyIfChanges" in entry.step) || typeof entry.step.onlyIfChanges === "boolean";
  }
  return !("onlyIfChanges" in entry.step);
}

function isStep(value: unknown): value is LoopStep {
  return isStepForAllowedActions(value, ["tree", "msg", "cmd", "workflow"], true);
}

function isStartStep(value: unknown): value is StartStep {
  return isStepForAllowedActions(value, ["msg", "cmd", "workflow"], false);
}

function parseStepsField<T>(input: Record<string, unknown>, errors: string[], tag: string, field: string, fallback: T[], validator: (v: unknown) => boolean, allowPartial: boolean): T[] {
  const value = input[field];
  if (value === undefined) return cloneSteps(fallback);
  if (!Array.isArray(value)) {
    if (allowPartial) errors.push(`${tag}Invalid ${field}: must be an array of steps. Using the default.`);
    else errors.push(`${tag}Invalid ${field}: must be an array of msg/cmd/workflow/commit steps. Using the default.`);
    return cloneSteps(fallback);
  }
  if (allowPartial) {
    const steps: T[] = [];
    for (const entry of value) {
      if (validator(entry)) steps.push(entry as T);
      else errors.push(`${tag}Invalid ${field} step ${JSON.stringify(entry)}. Skipped.`);
    }
    if (steps.length > 0) return steps;
    errors.push(`${tag}No valid ${field} steps. Using the default.`);
    return cloneSteps(fallback);
  }
  if (value.every(validator)) return value as T[];
  errors.push(`${tag}Invalid ${field}: must be an array of msg/cmd/workflow/commit steps. Using the default.`);
  return cloneSteps(fallback);
}

function parseStartSteps(
  input: Record<string, unknown>,
  errors: string[],
  tag: string,
  field: "start" | "finally",
  fallback: StartStep[],
): StartStep[] {
  return parseStepsField(input, errors, tag, field, fallback, isStartStep, false);
}

function parseConfig(input: Record<string, unknown>, errors: string[], label: string): WorkflowConfig {
  const tag = `Workflow ${label}: `;

  let rounds = DEFAULT_ROUNDS;
  if (input.rounds !== undefined) {
    if (typeof input.rounds === "number" && Number.isInteger(input.rounds) && input.rounds >= 1 && input.rounds <= MAX_ROUNDS) {
      rounds = input.rounds;
    } else {
      errors.push(`${tag}Invalid rounds "${String(input.rounds)}". Defaulting to ${DEFAULT_ROUNDS}.`);
    }
  }

  let finallyOnError = false;
  if (input.finallyOnError !== undefined) {
    if (typeof input.finallyOnError === "boolean") {
      finallyOnError = input.finallyOnError;
    } else {
      errors.push(`${tag}Invalid finallyOnError "${String(input.finallyOnError)}". Defaulting to false.`);
    }
  }

  const start = parseStartSteps(input, errors, tag, "start", DEFAULT_START);
  const finallySteps = parseStartSteps(input, errors, tag, "finally", DEFAULT_FINALLY);

  const loop = parseLoopSection(input, errors, tag, "loop", DEFAULT_LOOP);
  const loop2 = parseLoopSection(input, errors, tag, "loop2", []);
  const loop3 = parseLoopSection(input, errors, tag, "loop3", []);
  const loop4 = parseLoopSection(input, errors, tag, "loop4", []);
  const loop5 = parseLoopSection(input, errors, tag, "loop5", []);

  for (const [key, section] of [["loop", loop], ["loop2", loop2], ["loop3", loop3], ["loop4", loop4], ["loop5", loop5]] as const) {
    if (section.length > 0 && section[0]!.tree === undefined) {
      errors.push(`${tag}The first step of ${key === "loop" ? "the loop" : key} must be a tree step (context reset).`);
    }
  }

  const config: WorkflowConfig = { rounds, start, loop, finally: finallySteps, finallyOnError };
  if (loop2.length > 0) config.loop2 = loop2;
  if (loop3.length > 0) config.loop3 = loop3;
  if (loop4.length > 0) config.loop4 = loop4;
  if (loop5.length > 0) config.loop5 = loop5;
  return config;
}

function parseLoopSection(input: Record<string, unknown>, errors: string[], tag: string, key: string, fallback: LoopStep[]): LoopStep[] {
  return parseStepsField(input, errors, tag, key, fallback, isStep, true);
}

function isSingleConfig(value: Record<string, unknown>): boolean {
  return "rounds" in value || "start" in value || "loop" in value || "finally" in value;
}

function parseWorkflows(raw: unknown, errors: string[]): Record<string, WorkflowConfig> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("workflow.json must be an object of numbered workflows.");
    return {};
  }
  const input = raw as Record<string, unknown>;
  if (isSingleConfig(input)) {
    errors.push("workflow.json uses the legacy single-workflow format. Treating it as workflow 1.");
    return { "1": parseConfig(input, errors, "1") };
  }
  const workflows: Record<string, WorkflowConfig> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isNumericString(key)) {
      errors.push(`Invalid workflow key "${key}". Skipped.`);
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`Invalid workflow ${key}: must be an object. Skipped.`);
      continue;
    }
    workflows[key] = parseConfig(value as Record<string, unknown>, errors, key);
  }
  return workflows;
}

export function getWorkflows(): { workflows: Record<string, WorkflowConfig>; errors: string[]; fallback: boolean } {
  const errors: string[] = [];
  let raw: unknown = null;
  try {
    ensureUserData(WORKFLOW_FILE);
    raw = readJsonFile(WORKFLOW_PATH);
  } catch (err) {
    errors.push(`Could not read workflow.json: ${errorMessage(err)}`);
    return { workflows: {}, errors, fallback: true };
  }
  if (raw === null) return { workflows: {}, errors, fallback: true };
  return { workflows: parseWorkflows(raw, errors), errors, fallback: false };
}

export function getWorkflowConfig(index = "1"): { config: WorkflowConfig; errors: string[]; exists: boolean; fallback: boolean; workflows: Record<string, WorkflowConfig> } {
  const { workflows, errors, fallback } = getWorkflows();
  const config = workflows[index];
  if (config !== undefined) return { config, errors, exists: true, fallback, workflows };
  return { config: defaultConfig(), errors, exists: fallback && index === "1", fallback, workflows };
}

function readWorkflowEntries(): Record<string, unknown> {
  const workflows: Record<string, unknown> = {};
  const raw = readJsonObject(WORKFLOW_PATH);
  if (raw === null) return workflows;
  if (isSingleConfig(raw)) {
    workflows["1"] = raw;
    return workflows;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (isNumericString(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
      workflows[key] = value;
    }
  }
  return workflows;
}

function writeWorkflowEntries(workflows: Record<string, unknown>): void {
  const sorted = Object.fromEntries(Object.entries(workflows).sort(([a], [b]) => compareNumericKeys(a, b)));
  writeJsonAtomic(WORKFLOW_PATH, sorted);
}

export function setWorkflowConfig(index: string, config: WorkflowConfig): void {
  ensureUserDataDir();
  const workflows = readWorkflowEntries();
  workflows[index] = config;
  writeWorkflowEntries(workflows);
}

export function deleteWorkflowConfig(index: string): void {
  ensureUserDataDir();
  const workflows = readWorkflowEntries();
  delete workflows[index];
  writeWorkflowEntries(workflows);
}

function collectStepRefs(config: WorkflowConfig, fields: ("msg" | "cmd" | "tree" | "workflow")[]): string[] {
  const steps: LoopStep[] = [...config.start, ...config.finally, ...loopSections(config).flat()];
  const indices: string[] = [];
  for (const step of steps) {
    for (const field of fields) {
      const value = step[field];
      if (value !== undefined) indices.push(value);
    }
  }
  return [...new Set(indices)];
}

export function referencedIndices(config: WorkflowConfig): string[] {
  return collectStepRefs(config, ["tree", "msg"]).filter((num) => num !== "0");
}

export function referencedCommands(config: WorkflowConfig): string[] {
  return collectStepRefs(config, ["cmd"]);
}

export function referencedWorkflows(config: WorkflowConfig): string[] {
  return collectStepRefs(config, ["workflow"]);
}

export function loopSections(config: WorkflowConfig): LoopStep[][] {
  const sections = [config.loop];
  for (const key of ["loop2", "loop3", "loop4", "loop5"] as const) {
    const section = config[key];
    if (section !== undefined) sections.push(section);
  }
  return sections;
}

export function totalLoopSteps(config: WorkflowConfig): number {
  return loopSections(config).reduce((sum, section) => sum + section.length, 0);
}

export function findWorkflowCycle(workflows: Record<string, WorkflowConfig>, start: string): string[] | null {
  const path: string[] = [];
  const visited = new Set<string>();
  const dfs = (node: string): string[] | null => {
    const at = path.indexOf(node);
    if (at !== -1) return [...path.slice(at), node];
    if (visited.has(node)) return null;
    const config = workflows[node];
    if (config === undefined) return null;
    visited.add(node);
    path.push(node);
    for (const ref of referencedWorkflows(config)) {
      const cycle = dfs(ref);
      if (cycle !== null) return cycle;
    }
    path.pop();
    return null;
  };
  return dfs(start);
}

export function missingReferences(
  config: WorkflowConfig,
  messages: Record<string, string>,
  commands: Record<string, string>,
  workflows: Record<string, WorkflowConfig>,
): { messages: string[]; commands: string[]; workflows: string[] } {
  return {
    messages: referencedIndices(config).filter((num) => !messages[num]),
    commands: referencedCommands(config).filter((num) => !commands[num]),
    workflows: referencedWorkflows(config).filter((num) => !workflows[num]),
  };
}

export function getWorkflowIssues(
  config: WorkflowConfig,
  messages: Record<string, string>,
  commands: Record<string, string>,
  workflows: Record<string, WorkflowConfig>,
  index: string,
): { missingMessages: string[]; missingCommands: string[]; missingWorkflows: string[]; cycle: string[] | null; hasBadSection: boolean } {
  const { messages: missingMessages, commands: missingCommands, workflows: missingWorkflows } = missingReferences(config, messages, commands, workflows);
  return {
    missingMessages,
    missingCommands,
    missingWorkflows,
    cycle: findWorkflowCycle(workflows, index),
    hasBadSection: loopSections(config).some((section) => section.length === 0 || section[0]!.tree === undefined),
  };
}

export function getWorkflowRunError(
  config: WorkflowConfig,
  messages: Record<string, string>,
  commands: Record<string, string>,
  workflows: Record<string, WorkflowConfig>,
  index: string,
): string | null {
  const issues = getWorkflowIssues(config, messages, commands, workflows, index);
  if (issues.missingMessages.length > 0) return `Missing messages in messages.json: ${issues.missingMessages.join(", ")}. Restore the default stores with /workflow-reset or add them with /change-msg.`;
  if (issues.missingCommands.length > 0) return `Missing commands in commands.json: ${issues.missingCommands.join(", ")}. Restore the default stores with /workflow-reset or add them with /change-cmd.`;
  if (issues.missingWorkflows.length > 0) return `Missing workflows in workflow.json: ${issues.missingWorkflows.join(", ")}. Create them with /workflow-edit (press w).`;
  if (issues.cycle !== null) return `Circular workflow reference: ${issues.cycle.join(" → ")}. Fix workflow.json first.`;
  if (issues.hasBadSection) return `The first step of every loop section must be a tree step (context reset)`;
  return null;
}
