import { errorMessage } from "./errors.js";
import { compareNumericKeys, readJsonFile, readJsonObject, writeJsonAtomic } from "./json-file.js";
import { MAX_ROUNDS, WORKFLOW_FILE } from "./constants.js";
import { ensureUserData, ensureUserDataDir, userDataPath } from "./user-data.js";

export interface LoopStep {
  tree?: string;
  cmd?: string;
  msg?: string;
  onlyIfChanges?: boolean;
}

export interface StartStep {
  msg?: string;
  cmd?: string;
}

export interface WorkflowConfig {
  rounds: number;
  start: StartStep[];
  loop: LoopStep[];
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

function defaultConfig(): WorkflowConfig {
  return {
    rounds: DEFAULT_ROUNDS,
    start: DEFAULT_START.map((step) => ({ ...step })),
    loop: DEFAULT_LOOP.map((step) => ({ ...step })),
    finally: DEFAULT_FINALLY.map((step) => ({ ...step })),
  };
}

function stepAction(value: unknown): { action: string; content: unknown; step: Record<string, unknown> } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const step = value as Record<string, unknown>;
  const keys = Object.keys(step).filter((key) => key !== "onlyIfChanges");
  if (keys.length !== 1) return null;
  const action = keys[0]!;
  return { action, content: step[action], step };
}

export function isNumericString(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function isStep(value: unknown): value is LoopStep {
  const entry = stepAction(value);
  if (entry === null) return false;
  if (entry.action !== "tree" && entry.action !== "msg" && entry.action !== "cmd") return false;
  if (!isNumericString(entry.content)) return false;
  if (entry.action === "tree" && "onlyIfChanges" in entry.step) return false;
  return !("onlyIfChanges" in entry.step) || typeof entry.step.onlyIfChanges === "boolean";
}

function isStartStep(value: unknown): value is StartStep {
  const entry = stepAction(value);
  if (entry === null) return false;
  if (entry.action !== "msg" && entry.action !== "cmd") return false;
  return !("onlyIfChanges" in entry.step) && isNumericString(entry.content);
}

function parseStartSteps(
  input: Record<string, unknown>,
  errors: string[],
  tag: string,
  field: "start" | "finally",
  fallback: StartStep[],
): StartStep[] {
  const value = input[field];
  if (value === undefined) return fallback;
  if (Array.isArray(value) && value.every((step) => isStartStep(step))) return value as StartStep[];
  errors.push(`${tag}Invalid ${field}: must be an array of msg/cmd steps. Using the default.`);
  return fallback;
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

  let loop = DEFAULT_LOOP;
  if (input.loop !== undefined) {
    if (Array.isArray(input.loop)) {
      const steps: LoopStep[] = [];
      for (const entry of input.loop) {
        if (isStep(entry)) {
          steps.push(entry);
        } else {
          errors.push(`${tag}Invalid loop step ${JSON.stringify(entry)}. Skipped.`);
        }
      }
      if (steps.length > 0) {
        loop = steps;
      } else {
        errors.push(`${tag}No valid loop steps. Using the default loop.`);
      }
    } else {
      errors.push(`${tag}Invalid loop: must be an array of steps. Using the default loop.`);
    }
  }

  if (loop[0]?.tree === undefined) {
    errors.push(`${tag}The first step of the loop must be a tree step (context reset).`);
  }
  return { rounds, start, loop, finally: finallySteps, finallyOnError };
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

export function getWorkflowConfig(index = "1"): { config: WorkflowConfig; errors: string[]; exists: boolean; fallback: boolean } {
  const { workflows, errors, fallback } = getWorkflows();
  const config = workflows[index];
  if (config !== undefined) return { config, errors, exists: true, fallback };
  return { config: defaultConfig(), errors, exists: fallback && index === "1", fallback };
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

function collectStepRefs(config: WorkflowConfig, fields: ("msg" | "cmd" | "tree")[]): string[] {
  const steps: LoopStep[] = [...config.start, ...config.finally, ...config.loop];
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
  return collectStepRefs(config, ["tree", "msg"]);
}

export function referencedCommands(config: WorkflowConfig): string[] {
  return collectStepRefs(config, ["cmd"]);
}

export function missingReferences(
  config: WorkflowConfig,
  messages: Record<string, string>,
  commands: Record<string, string>,
): { messages: string[]; commands: string[] } {
  return {
    messages: referencedIndices(config).filter((num) => !messages[num]),
    commands: referencedCommands(config).filter((num) => !commands[num]),
  };
}
