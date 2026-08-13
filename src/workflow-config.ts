import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { MAX_ROUNDS } from "./constants.js";
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
}

const WORKFLOW_FILE = userDataPath("workflow.json");

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

function isStep(value: unknown): value is LoopStep {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  const actionKeys = Object.keys(step).filter((key) => key !== "onlyIfChanges");
  if (actionKeys.length !== 1) return false;
  const action = actionKeys[0]!;
  if (action === "tree" && "onlyIfChanges" in step) return false;
  if (action === "tree" || action === "msg" || action === "cmd") {
    if (typeof step[action] !== "string" || !/^\d+$/.test(step[action])) return false;
    if ("onlyIfChanges" in step && typeof step.onlyIfChanges !== "boolean") return false;
    return true;
  }
  return false;
}

function isStartStep(value: unknown): value is StartStep {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  const keys = Object.keys(step);
  if (keys.length !== 1) return false;
  const action = keys[0]!;
  if (action !== "msg" && action !== "cmd") return false;
  return typeof step[action] === "string" && /^\d+$/.test(step[action]);
}

function parseConfig(input: Record<string, unknown>, errors: string[], label: string): WorkflowConfig {
  const tag = `Workflow ${label}: `;

  let rounds = DEFAULT_ROUNDS;
  if (input.rounds !== undefined) {
    if (typeof input.rounds === "number" && Number.isInteger(input.rounds) && input.rounds >= 1 && input.rounds <= MAX_ROUNDS) {
      rounds = input.rounds;
    } else {
      errors.push(`${tag}Invalid rounds "${String(input.rounds)}" - defaulting to ${DEFAULT_ROUNDS}.`);
    }
  }

  let start = DEFAULT_START;
  if (input.start !== undefined) {
    if (Array.isArray(input.start) && input.start.every((s) => isStartStep(s))) {
      start = input.start as StartStep[];
    } else {
      errors.push(`${tag}Invalid start - must be an array of msg/cmd steps - using default.`);
    }
  }

  let finallySteps = DEFAULT_FINALLY;
  if (input.finally !== undefined) {
    if (Array.isArray(input.finally) && input.finally.every((s) => isStartStep(s))) {
      finallySteps = input.finally as StartStep[];
    } else {
      errors.push(`${tag}Invalid finally - must be an array of msg/cmd steps - using default.`);
    }
  }

  let loop = DEFAULT_LOOP;
  if (input.loop !== undefined) {
    if (Array.isArray(input.loop)) {
      const steps: LoopStep[] = [];
      for (const entry of input.loop) {
        if (isStep(entry)) {
          steps.push(entry);
        } else {
          errors.push(`${tag}Invalid loop step ${JSON.stringify(entry)} - skipped.`);
        }
      }
      if (steps.length > 0) {
        loop = steps;
      } else {
        errors.push(`${tag}No valid loop steps - using default loop.`);
      }
    } else {
      errors.push(`${tag}Invalid loop - must be an array of steps - using default loop.`);
    }
  }

  if (loop[0]?.tree === undefined) {
    errors.push(`${tag}The first step of the loop must be a tree step (context reset).`);
  }
  return { rounds, start, loop, finally: finallySteps };
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
    errors.push("workflow.json uses the legacy single-workflow format - treated as workflow 1.");
    return { "1": parseConfig(input, errors, "1") };
  }
  const workflows: Record<string, WorkflowConfig> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^\d+$/.test(key)) {
      errors.push(`Invalid workflow key "${key}" - skipped.`);
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`Invalid workflow ${key} - must be an object - skipped.`);
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
    ensureUserData("workflow.json");
    if (existsSync(WORKFLOW_FILE)) {
      raw = JSON.parse(readFileSync(WORKFLOW_FILE, "utf-8"));
    }
  } catch (err) {
    errors.push(`Could not read workflow.json: ${err instanceof Error ? err.message : String(err)}`);
    return { workflows: {}, errors, fallback: true };
  }
  if (raw === null) return { workflows: {}, errors, fallback: true };
  return { workflows: parseWorkflows(raw, errors), errors, fallback: false };
}

export function getWorkflowConfig(index = "1"): { config: WorkflowConfig; errors: string[]; exists: boolean } {
  const { workflows, errors, fallback } = getWorkflows();
  const config = workflows[index];
  if (config !== undefined) return { config, errors, exists: true };
  return { config: defaultConfig(), errors, exists: fallback };
}

export function setWorkflowConfig(index: string, config: WorkflowConfig): void {
  ensureUserDataDir();
  const workflows: Record<string, unknown> = {};
  let raw: unknown = null;
  try {
    if (existsSync(WORKFLOW_FILE)) raw = JSON.parse(readFileSync(WORKFLOW_FILE, "utf-8"));
  } catch {
    raw = null;
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const input = raw as Record<string, unknown>;
    if (isSingleConfig(input)) {
      workflows["1"] = input;
    } else {
      for (const [key, value] of Object.entries(input)) {
        if (/^\d+$/.test(key) && value !== null && typeof value === "object" && !Array.isArray(value)) {
          workflows[key] = value;
        }
      }
    }
  }
  workflows[index] = config;
  const sorted = Object.fromEntries(Object.entries(workflows).sort(([a], [b]) => Number(a) - Number(b)));
  const tmp = `${WORKFLOW_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(sorted, null, 2), "utf8");
  renameSync(tmp, WORKFLOW_FILE);
}

export function referencedIndices(config: WorkflowConfig): string[] {
  const indices = config.start.flatMap((step) => (step.msg !== undefined ? [step.msg] : []));
  indices.push(...config.finally.flatMap((step) => (step.msg !== undefined ? [step.msg] : [])));
  for (const step of config.loop) {
    if (step.tree !== undefined) indices.push(step.tree);
    if (step.msg !== undefined) indices.push(step.msg);
  }
  return [...new Set(indices)];
}

export function referencedCommands(config: WorkflowConfig): string[] {
  const indices = config.start.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : []));
  indices.push(...config.finally.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : [])));
  indices.push(...config.loop.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : [])));
  return [...new Set(indices)];
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
