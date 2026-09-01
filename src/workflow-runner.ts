import type { ExecResult, ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMessages } from "./messages.js";
import { getCommands } from "./commands.js";
import { errorMessage } from "./errors.js";
import { countPhaseMatches, countUserTextMatches, findAnchorAfterMessage, lastAssistantMessageText, lastAssistantStopReason } from "./session-helpers.js";
import { runCommand, commandFailureMessage, type CommandResult } from "./command-runner.js";
import { runCommit, commitFailureMessage, type CommitResult } from "./commit.js";
import { getWorkflowConfig, getWorkflowRunError, loopSections, type WorkflowConfig, type LoopStep, type StartStep } from "./workflow-config.js";

const SEND_START_TIMEOUT_MS = 5000;
const SEND_MAX_ATTEMPTS = 3;
const SEND_POLL_INTERVAL_MS = 25;
const RETRY_DELAY_MS = 400;
const RETRY_MAX_DELAY_MS = 5000;

function retryDelay(attempt: number): number {
  return Math.min(RETRY_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS);
}
let workflowStopRequested = false;
function isStopRequested(ctx?: any): boolean {
  return workflowStopRequested || !!ctx?.signal?.aborted;
}
let workflowRunning = false;
const workflowStack: string[] = [];
const workflowLabels: string[] = [];

export type WorkflowVars = Record<string, string>;

const INTERPOLATION_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function interpolateText(text: string, vars: Record<string, string>): string {
  if (Object.keys(vars).length === 0) return text;
  return text.replace(INTERPOLATION_PATTERN, (match, key) => vars[key] !== undefined ? vars[key] : match);
}

function resolveStoreText(store: Record<string, string>, noun: string, num: string, vars: Record<string, string>, ctx: ExtensionCommandContext): string | null {
  const raw = store[num];
  if (!raw) {
    notifyMissingEntry(ctx, noun, num, undefined, "error");
    return null;
  }
  return interpolateText(raw, vars);
}

function resolveMessageText(num: string, vars: Record<string, string>, ctx: ExtensionCommandContext): string | null {
  return resolveStoreText(getMessages(), "Message", num, vars, ctx);
}

function resolveCommandText(num: string, vars: Record<string, string>, ctx: ExtensionCommandContext): string | null {
  return resolveStoreText(getCommands(), "Command", num, vars, ctx);
}
function hasVarsBoundary(trimmed: string, start: number): boolean {
  const before = trimmed.slice(0, start);
  return before.length === 0 || /\s/.test(before[before.length - 1]!);
}
export function extractWorkflowVars(raw: string): { vars: Record<string, string>; warning?: string } {
  const trimmed = raw.trimEnd();
  if (!trimmed.endsWith("}")) return { vars: {} };
  for (let start = trimmed.lastIndexOf("{"); start !== -1; start = trimmed.lastIndexOf("{", start - 1)) {
    if (!hasVarsBoundary(trimmed, start)) continue;
    const jsonText = trimmed.slice(start).trim();
    if (!jsonText.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(jsonText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { vars: {}, warning: `Invalid workflow vars JSON: ${jsonText.slice(0, 80)}` };
      }
      const vars: Record<string, string> = {};
      const ignored: string[] = [];
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") vars[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") vars[k] = String(v);
        else ignored.push(k);
      }
      if (ignored.length > 0) {
        return { vars, warning: `Workflow vars ignored: non-string values for ${ignored.join(", ")} in ${jsonText.slice(0, 80)}` };
      }
      return { vars };
    } catch {
      continue;
    }
  }
  const candidateStart = trimmed.lastIndexOf("{");
  if (candidateStart !== -1) {
    if (hasVarsBoundary(trimmed, candidateStart)) {
      const candidate = trimmed.slice(candidateStart).trim();
      if (candidate.endsWith("}")) {
        return { vars: {}, warning: `Invalid workflow vars JSON: ${candidate.slice(0, 80)}` };
      }
    }
  }
  return { vars: {} };
}
export function parseWorkflowArgs(raw: string): Record<string, string> {
  return extractWorkflowVars(raw).vars;
}


function retriesFor(step: { retries?: number }): number {
  return step.retries ?? 1;
}

async function delayWithStopCheck(ms: number, ctx?: { signal?: AbortSignal | null }): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (isStopRequested(ctx)) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, ms - (Date.now() - start)))));
  }
  return true;
}
async function notifyRetry(ctx: ExtensionCommandContext, scope: string, message: string, attempt: number): Promise<boolean> {
  ctx.ui.notify(withWorkflowChain(`${scope}${message}`), "warning");
  return delayWithStopCheck(retryDelay(attempt), ctx);
}
async function retryWithBackoff<T>(ctx: ExtensionCommandContext, scope: string, retries: number, task: () => Promise<T>, isSuccess: (result: T) => boolean, isRetryable: (result: T | null) => boolean, retryMessage: (result: T | null, attempt: number, retries: number) => string): Promise<T | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    let result: T;
    try {
      result = await task();
    } catch (err) {
      ctx.ui.notify(withWorkflowChain(`${scope}${errorMessage(err)}`), "error");
      if (isRetryable(null) && attempt < retries && !isStopRequested(ctx)) {
        if (!(await notifyRetry(ctx, scope, retryMessage(null, attempt, retries), attempt))) return null;
        continue;
      }
      return null;
    }
    if (isSuccess(result)) return result;
    if (isRetryable(result) && attempt < retries && !isStopRequested(ctx)) {
      if (!(await notifyRetry(ctx, scope, retryMessage(result, attempt, retries), attempt))) return null;
      continue;
    }
    return result;
  }
  return null;
}


function workflowChain(): string {
  return workflowLabels.join(" → ");
}

function withWorkflowChain(text: string): string {
  return workflowLabels.length > 1 ? `${workflowChain()}: ${text}` : text;
}

function loopLabel(index: string, sectionCount: number, section: number, round: number, rounds: number): string {
  const sectionPart = sectionCount > 1 ? `, section ${section + 1}` : "";
  return `Workflow ${index}${sectionPart}, round ${round}/${rounds}`;
}

export function isWorkflowRunning(): boolean {
  return workflowRunning;
}

export function tryStartWorkflow(): boolean {
  if (workflowRunning) return false;
  workflowRunning = true;
  return true;
}

export function requestWorkflowStop(): void {
  workflowStopRequested = true;
}
export function notifyMissingEntry(
  ctx: ExtensionCommandContext,
  noun: string,
  num: string,
  hint?: string,
  kind: "warning" | "error" = "warning",
): void {
  ctx.ui.notify(`${noun} ${num} does not exist.${hint !== undefined ? ` ${hint}` : ""}`, kind);
}

type SendResult = "sent" | "failed" | "cancelled";

async function sendAndWaitForTurn(
  pi: ExtensionAPI,
  ctx: { isIdle(): boolean; waitForIdle(): Promise<void>; sessionManager: { getBranch(): SessionEntry[] } },
  text: string,
): Promise<SendResult> {
  let previousCount = -1;
  for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
    if (isStopRequested(ctx)) return "cancelled";
    const before = countUserTextMatches(ctx.sessionManager.getBranch(), text);
    if (previousCount !== -1 && before > previousCount) {
      await ctx.waitForIdle();
      return "sent";
    }
    previousCount = before;
    try {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch {
      return "failed";
    }
    let deadline = Date.now() + SEND_START_TIMEOUT_MS;
    while (true) {
      if (countUserTextMatches(ctx.sessionManager.getBranch(), text) > before) {
        await ctx.waitForIdle();
        return "sent";
      }
      if (isStopRequested(ctx)) return "cancelled";
      if (!ctx.isIdle()) {
        await ctx.waitForIdle();
        if (countUserTextMatches(ctx.sessionManager.getBranch(), text) > before) return "sent";
        deadline = Date.now() + SEND_START_TIMEOUT_MS;
      } else if (Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_POLL_INTERVAL_MS));
    }
  }
  return "failed";
}

type TreeNavigationStatus = "ok" | "missing" | "not-found" | "cancelled" | "failed" | "fallback";

export async function navigateToMessageAnchor(ctx: ExtensionCommandContext, index: string, requirePresence = false, vars: Record<string, string> = {}): Promise<TreeNavigationStatus> {
  const raw = getMessages()[index];
  if (!raw) return "missing";
  const text = interpolateText(raw, vars);
  const present = countUserTextMatches(ctx.sessionManager.getBranch(), text) > 0;
  if (requirePresence && !present) return "not-found";
  const anchor = findAnchorAfterMessage(ctx.sessionManager.getBranch(), text);
  if (!anchor) return "not-found";
  let navigation: { cancelled: boolean };
  try {
    navigation = await ctx.navigateTree(anchor.id, { summarize: false });
  } catch (err) {
    ctx.ui.notify(`Could not navigate: ${errorMessage(err)}`, "error");
    return "failed";
  }
  if (navigation.cancelled) return "cancelled";
  return present ? "ok" : "fallback";
}

export function notifyNavigationStatus(
  ctx: ExtensionCommandContext,
  index: string,
  status: TreeNavigationStatus,
  cancelledText: string,
  kind: "warning" | "error",
): boolean {
  if (status === "missing") {
    notifyMissingEntry(ctx, "Message", index, undefined, kind);
    return false;
  }
  if (status === "not-found") {
    ctx.ui.notify(`Could not find message ${index} in the session.`, kind);
    return false;
  }
  if (status === "cancelled") {
    ctx.ui.notify(cancelledText, "warning");
    return false;
  }
  if (status === "failed") {
    return false;
  }
  if (status === "fallback") {
    ctx.ui.notify(`Message ${index} is not in the session. The context resets to the response of the first user message instead`, "warning");
    return true;
  }
  return true;
}

async function runTreeStep(ctx: ExtensionCommandContext, scope: string, tree: string, retries: number, vars: Record<string, string>): Promise<boolean> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (tree === "0") {
      ctx.ui.setWorkingMessage(withWorkflowChain(`${scope}starting a new session...`));
      const roots = ctx.sessionManager.getTree();
      const root = roots[0];
      if (root !== undefined) {
        let result: { cancelled: boolean };
        try {
          result = await ctx.navigateTree(root.entry.id, { summarize: false });
        } catch (err) {
          ctx.ui.setWorkingMessage();
          ctx.ui.notify(`Could not navigate: ${errorMessage(err)}`, "error");
          if (attempt < retries && !isStopRequested(ctx)) {
            if (!(await notifyRetry(ctx, scope, `retrying new session after error (${attempt}/${retries})`, attempt))) return false;
            continue;
          }
          return false;
        }
        if (result.cancelled) {
          ctx.ui.notify("Workflow cancelled", "warning");
          return false;
        }
      }
      ctx.ui.notify("New session started", "info");
      ctx.ui.setWorkingMessage();
      return true;
    }
    ctx.ui.setWorkingMessage(withWorkflowChain(`${scope}resetting context to message ${tree}...`));
    const status = await navigateToMessageAnchor(ctx, tree, false, vars);
    const navigated = notifyNavigationStatus(ctx, tree, status, "Workflow cancelled", "error");
    ctx.ui.setWorkingMessage();
    if (!navigated) {
      if (attempt < retries && !isStopRequested(ctx) && status === "failed") {
        if (!(await notifyRetry(ctx, scope, `retrying context reset to ${tree} (${attempt}/${retries})`, attempt))) return false;
        continue;
      }
      return false;
    }
    return true;
  }
  return false;
}

async function checkForChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: string): Promise<boolean | null> {
  ctx.ui.setWorkingMessage(withWorkflowChain(`${scope}checking for changes...`));
  let statusResult: ExecResult;
  try {
    statusResult = await pi.exec("git", ["status", "--porcelain"]);
  } catch (err) {
    ctx.ui.notify(`git status --porcelain failed: ${errorMessage(err)}`, "error");
    return null;
  }
  if (statusResult.code !== 0) {
    ctx.ui.notify(`git status --porcelain failed: ${statusResult.stderr}`, "error");
    return null;
  }
  const changed = statusResult.stdout.trim().length > 0;
  if (!changed) ctx.ui.notify(withWorkflowChain(`${scope}no changes detected, skipping step`), "info");
  return changed;
}
async function handleLengthContinuation(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope: string): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (isStopRequested(ctx)) return false;
    const reason = lastAssistantStopReason(ctx.sessionManager.getBranch());
    if (reason !== "length") return true;
    ctx.ui.setWorkingMessage(withWorkflowChain(`${scope}sending continuation for truncated output...`));
    const result = await sendAndWaitForTurn(pi, ctx, "ok");
    ctx.ui.setWorkingMessage();
    if (result === "cancelled") {
      ctx.ui.notify("Workflow stopped", "info");
      return false;
    }
    if (result === "failed") {
      ctx.ui.notify("Failed to send continuation for truncated output", "error");
      return false;
    }
  }
  ctx.ui.notify(withWorkflowChain(`${scope}output still truncated after continuations, proceeding`), "warning");
  return true;
}

async function runStoredCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  num: string,
  prefix: string,
  vars: Record<string, string> = {},
  scope: string = "",
  retries = 1,
): Promise<boolean> {
  const command = resolveCommandText(num, vars, ctx);
  if (command === null) return false;
  const result = await retryWithBackoff(
    ctx,
    scope,
    retries,
    () => runCommand(pi, command, `${prefix}${command}...`, ctx.ui),
    (r) => r.ok,
    (r) => r === null || (!r.ok && r.reason !== "empty" && r.reason !== "unterminated"),
    (r, attempt) => r === null ? `retrying command ${num} after error (${attempt}/${retries})` : `retrying command ${num} (${attempt}/${retries}): ${commandFailureMessage(num, r as Extract<CommandResult, { ok: false }>) }`,
  ) as CommandResult | null;
  if (result === null) return false;
  if (!result.ok) {
    ctx.ui.notify(commandFailureMessage(num, result), "error");
    return false;
  }
  return true;
}

async function runCommitStep(pi: ExtensionAPI, ctx: ExtensionCommandContext, scope = "", retries = 1): Promise<boolean> {
  const result = await retryWithBackoff(
    ctx,
    scope,
    retries,
    () => runCommit(pi, ctx.ui, lastAssistantMessageText(ctx.sessionManager.getBranch()), withWorkflowChain(`${scope}Committing changes...`)),
    (r) => r.ok,
    () => true,
    (r, attempt) => r === null ? `retrying commit after error (${attempt}/${retries})` : `retrying commit (${attempt}/${retries}): ${commitFailureMessage(r as Extract<CommitResult, { ok: false }>) }`,
  ) as CommitResult | null;
  if (result === null) return false;
  if (!result.ok) {
    ctx.ui.notify(commitFailureMessage(result), "error");
    return false;
  }
  if (!result.committed) ctx.ui.notify("Nothing to commit", "info");
  return true;
}

async function sendStoredMessage(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  num: string,
  workingText: string,
  vars: Record<string, string> = {},
  scope: string = "",
  retries = 1,
): Promise<boolean> {
  const text = resolveMessageText(num, vars, ctx);
  if (text === null) return false;
  const result = await retryWithBackoff(
    ctx,
    scope,
    retries,
    async () => {
      ctx.ui.setWorkingMessage(workingText);
      const r = await sendAndWaitForTurn(pi, ctx, text);
      return r;
    },
    (r) => r === "sent",
    (r) => r === null || r === "failed",
    (r, attempt) => {
      if (r === null) ctx.ui.setWorkingMessage();
      return r === null ? `retrying message ${num} after error (${attempt}/${retries})` : `retrying message ${num} (${attempt}/${retries})`;
    },
  ) as SendResult | null;
  if (result === null) {
    ctx.ui.setWorkingMessage();
    return false;
  }
  if (result === "cancelled") {
    ctx.ui.notify("Workflow stopped", "info");
    return false;
  }
  if (result === "failed") {
    ctx.ui.notify(`Failed to send message ${num}`, "error");
    return false;
  }
  return true;
}
async function dispatchStep(pi: ExtensionAPI, ctx: ExtensionCommandContext, step: StartStep | LoopStep, vars: Record<string, string>, scope: string): Promise<boolean> {
  const retries = retriesFor(step);
  if (step.msg !== undefined) {
    return sendStoredMessage(pi, ctx, step.msg, withWorkflowChain(`${scope}sending message ${step.msg}...`), vars, scope, retries);
  }
  if (step.cmd !== undefined) {
    return runStoredCommand(pi, ctx, step.cmd, withWorkflowChain(`${scope}running `), vars, scope, retries);
  }
  if (step.workflow !== undefined) {
    return runSubWorkflow(pi, ctx, step.workflow, vars, scope);
  }
  if (step.commit === true) return runCommitStep(pi, ctx, scope, retries);
  return true;
}

async function runOncePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  steps: StartStep[],
  skipMsgs: number,
  vars: Record<string, string> = {},
): Promise<boolean> {
  let skipped = 0;
  for (const step of steps) {
    if (isStopRequested(ctx)) {
      ctx.ui.notify("Workflow stopped", "info");
      return false;
    }
    if (step.msg !== undefined && skipped < skipMsgs) {
      skipped++;
      continue;
    }
    if (step.msg !== undefined) {
      const working = withWorkflowChain(`Sending message ${step.msg}...`);
      if (!(await sendStoredMessage(pi, ctx, step.msg, working, vars, "", retriesFor(step)))) return false;
    } else if (!(await dispatchStep(pi, ctx, step, vars, ""))) return false;
      if (!(await handleLengthContinuation(pi, ctx, ""))) return false;
  }
  return true;
}

async function runPhases(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: WorkflowConfig,
  index: string,
  rounds: number,
  matched: number,
  vars: Record<string, string> = {},
): Promise<boolean> {
  if (!(await runOncePhase(pi, ctx, config.start, matched, vars))) return false;
  const sections = loopSections(config);
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const sectionLabel = sections.length > 1 ? `Section ${s + 1}, ` : "";
    let consecutiveEmpty = 0;
    for (let round = 1; round <= rounds; round++) {
      workflowLabels[workflowLabels.length - 1] = loopLabel(index, sections.length, s, round, rounds);
      const scope = workflowLabels.length > 1 ? "" : `${sectionLabel}Round ${round}/${rounds}: `;
      let roundHasConditional = false;
      let roundExecutedConditional = false;
      for (const step of section) {
        if (isStopRequested(ctx)) {
          ctx.ui.notify("Workflow stopped", "info");
          return false;
        }
        if (step.tree !== undefined) {
          if (!(await runTreeStep(ctx, scope, step.tree, retriesFor(step), vars))) return false;
          continue;
        }
        if (step.onlyIfChanges) {
          roundHasConditional = true;
          const changed = await checkForChanges(pi, ctx, scope);
          if (changed === null) return false;
          if (!changed) continue;
          roundExecutedConditional = true;
        }
        if (!(await dispatchStep(pi, ctx, step, vars, scope))) return false;
        if (!(await handleLengthContinuation(pi, ctx, scope))) return false;
      }
      if (roundHasConditional) {
        if (!roundExecutedConditional) {
          consecutiveEmpty++;
          if (config.stopAfterEmpty !== undefined && consecutiveEmpty >= config.stopAfterEmpty) {
            ctx.ui.notify(withWorkflowChain(`${scope}no changes for ${consecutiveEmpty} consecutive rounds, exiting early`), "info");
            break;
          }
        } else {
          consecutiveEmpty = 0;
        }
      }
    }
  }
  workflowLabels[workflowLabels.length - 1] = `Workflow ${index}`;
  if (!(await runOncePhase(pi, ctx, config.finally, 0, vars))) return false;
  return true;
}

async function runWorkflowPhases(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: WorkflowConfig,
  index: string,
  rounds: number,
  messages: Record<string, string>,
  leading: boolean,
  vars: Record<string, string> = {},
): Promise<boolean> {
  const startMsgs = config.start.flatMap((step) => {
    if (step.msg !== undefined && messages[step.msg] !== undefined) {
      const raw = messages[step.msg]!;
      return [interpolateText(raw, vars)];
    }
    return [];
  });
  const matched = countPhaseMatches(ctx.sessionManager.getBranch(), startMsgs, leading);
  const ok = await runPhases(pi, ctx, config, index, rounds, matched, vars);
  if (!ok && config.finallyOnError && !isStopRequested(ctx)) {
    await runOncePhase(pi, ctx, config.finally, 0, vars);
  }
  return ok;
}

async function runSubWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, index: string, vars: Record<string, string> = {}, scope: string = ""): Promise<boolean> {
  if (workflowStack.includes(index)) {
    ctx.ui.notify(`Circular workflow reference: ${[...workflowStack, index].join(" → ")}`, "error");
    return false;
  }
  const { config, exists, workflows } = getWorkflowConfig(index);
  if (!exists) {
    notifyMissingEntry(ctx, "Workflow", index, "Use /workflow-edit and press w to create it.", "error");
    return false;
  }
  const runError = getWorkflowRunError(config, getMessages(), getCommands(), workflows, index);
  if (runError !== null) {
    ctx.ui.notify(runError, "error");
    return false;
  }
  workflowStack.push(index);
  workflowLabels.push(`Workflow ${index}`);
  try {
    return await runWorkflowPhases(pi, ctx, config, index, config.rounds, getMessages(), false, vars);
  } catch (err) {
    ctx.ui.notify(withWorkflowChain(`${scope}${errorMessage(err)}`), "error");
    return false;
  } finally {
    workflowStack.pop();
    workflowLabels.pop();
  }
}

export async function runWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: WorkflowConfig,
  index: string,
  rounds: number,
  messages: Record<string, string>,
  vars: Record<string, string> = {},
): Promise<void> {
  if (!tryStartWorkflow()) {
    ctx.ui.notify("A workflow is already running. Press Esc to cancel it", "warning");
    return;
  }
  workflowStopRequested = false;
  workflowStack.length = 0;
  workflowStack.push(index);
  workflowLabels.length = 0;
  workflowLabels.push(`Workflow ${index}`);
  try {
    ctx.ui.setWorkingMessage("Waiting for queued messages to complete...");
    await ctx.waitForIdle();
    const ok = await runWorkflowPhases(pi, ctx, config, index, rounds, messages, true, vars);
    if (ok) ctx.ui.notify(`Workflow ${index} complete: ${rounds} round${rounds === 1 ? "" : "s"}`, "info");
  } finally {
    workflowRunning = false;
    ctx.ui.setWorkingMessage();
  }
}
