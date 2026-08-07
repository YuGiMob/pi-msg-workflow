import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_ROUNDS } from "./constants.js";

export interface LoopStep {
  tree?: string;
  cmd?: string;
  send?: string;
  onlyIfChanges?: boolean;
}

export interface WorkflowConfig {
  rounds: number;
  start: string[];
  loop: LoopStep[];
}

const WORKFLOW_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "workflow.json");

const DEFAULT_ROUNDS = 2;
const DEFAULT_START = ["1", "2", "3", "4", "5"];
const DEFAULT_LOOP: LoopStep[] = [
  { tree: "1" },
  { cmd: "1" },
  { send: "6" },
  { send: "7" },
  { send: "5", onlyIfChanges: true },
  { cmd: "1" },
];

function isStep(value: unknown): value is LoopStep {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  const actionKeys = Object.keys(step).filter((key) => key !== "onlyIfChanges");
  if (actionKeys.length !== 1) return false;
  const action = actionKeys[0]!;
  if (action !== "send" && "onlyIfChanges" in step) return false;
  if (action === "tree" || action === "send" || action === "cmd") {
    if (typeof step[action] !== "string" || !/^\d+$/.test(step[action])) return false;
    if ("onlyIfChanges" in step && typeof step.onlyIfChanges !== "boolean") return false;
    return true;
  }
  return false;
}

export function getWorkflowConfig(): { config: WorkflowConfig; errors: string[] } {
  const errors: string[] = [];
  let raw: unknown = null;
  try {
    if (existsSync(WORKFLOW_FILE)) {
      raw = JSON.parse(readFileSync(WORKFLOW_FILE, "utf-8"));
    }
  } catch (err) {
    errors.push(`Could not read workflow.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  const input = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  let rounds = DEFAULT_ROUNDS;
  if (input.rounds !== undefined) {
    const parsed = Number(input.rounds);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_ROUNDS) {
      rounds = parsed;
    } else {
      errors.push(`Invalid rounds "${String(input.rounds)}" - defaulting to ${DEFAULT_ROUNDS}.`);
    }
  }

  let start = DEFAULT_START;
  if (input.start !== undefined) {
    if (Array.isArray(input.start) && input.start.every((s) => typeof s === "string" && s.length > 0)) {
      start = input.start as string[];
    } else {
      errors.push("Invalid start - must be an array of message indices - using default.");
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
          errors.push(`Invalid loop step ${JSON.stringify(entry)} - skipped.`);
        }
      }
      if (steps.length > 0) {
        loop = steps;
      } else {
        errors.push("No valid loop steps - using default loop.");
      }
    } else {
      errors.push("Invalid loop - must be an array of steps - using default loop.");
    }
  }

  if (loop[0]?.tree === undefined) {
    errors.push("The first step of the loop must be a tree step (context reset).");
  }
  return { config: { rounds, start, loop }, errors };
}

export function setWorkflowConfig(config: WorkflowConfig): void {
  const tmp = `${WORKFLOW_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  renameSync(tmp, WORKFLOW_FILE);
}

export function referencedIndices(config: WorkflowConfig): string[] {
  const indices = [...config.start];
  for (const step of config.loop) {
    if (step.tree !== undefined) indices.push(step.tree);
    if (step.send !== undefined) indices.push(step.send);
  }
  return [...new Set(indices)];
}

export function referencedCommands(config: WorkflowConfig): string[] {
  const indices = config.loop.flatMap((step) => (step.cmd !== undefined ? [step.cmd] : []));
  return [...new Set(indices)];
}
