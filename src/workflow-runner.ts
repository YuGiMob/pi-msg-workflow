import type { ExecResult, ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMessages } from "./messages.js";
import { getCommands } from "./commands.js";
import { errorMessage } from "./errors.js";
import { countLeadingPhaseMatches, countUserTextMatches, findAnchorAfterMessage } from "./session-helpers.js";
import { runCommand, commandFailureMessage } from "./command-runner.js";
import type { WorkflowConfig, StartStep } from "./workflow-config.js";

const SEND_START_TIMEOUT_MS = 5000;
const SEND_MAX_ATTEMPTS = 3;
const SEND_POLL_INTERVAL_MS = 25;
const SEND_GRACE_PERIOD_MS = 2000;

let workflowStopRequested = false;
let workflowRunning = false;

export function isWorkflowRunning(): boolean {
  return workflowRunning;
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
    if (workflowStopRequested) return "cancelled";
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
    let graceUsed = false;
    while (Date.now() < deadline) {
      if (countUserTextMatches(ctx.sessionManager.getBranch(), text) > before) {
        await ctx.waitForIdle();
        return "sent";
      }
      if (workflowStopRequested) return "cancelled";
      if (!ctx.isIdle()) {
        await ctx.waitForIdle();
        if (countUserTextMatches(ctx.sessionManager.getBranch(), text) > before) return "sent";
        if (!graceUsed) {
          deadline = Date.now() + SEND_GRACE_PERIOD_MS;
          graceUsed = true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_POLL_INTERVAL_MS));
    }
  }
  return "failed";
}

type TreeNavigationStatus = "ok" | "missing" | "not-found" | "cancelled" | "failed" | "fallback";

export async function navigateToMessageAnchor(ctx: ExtensionCommandContext, index: string, requirePresence = false): Promise<TreeNavigationStatus> {
  const text = getMessages()[index];
  if (!text) return "missing";
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
    ctx.ui.notify(`Message ${index} is not in the session - context reset to the response of the first user message instead`, "warning");
    return true;
  }
  return true;
}

async function checkForChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, round: number, rounds: number): Promise<boolean | null> {
  ctx.ui.setWorkingMessage(`Round ${round}/${rounds}: checking for changes...`);
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
  if (!changed) ctx.ui.notify(`Round ${round}/${rounds}: no changes detected, skipping step`, "info");
  return changed;
}

async function runStoredCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  num: string,
  prefix: string,
): Promise<boolean> {
  const command = getCommands()[num];
  if (!command) {
    notifyMissingEntry(ctx, "Command", num, undefined, "error");
    return false;
  }
  const result = await runCommand(pi, command, `${prefix}${command}...`, ctx.ui);
  if (!result.ok) {
    ctx.ui.notify(commandFailureMessage(num, result), "error");
    return false;
  }
  return true;
}

async function sendStoredMessage(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  num: string,
  workingText: string,
): Promise<boolean> {
  const text = getMessages()[num];
  if (text === undefined) {
    notifyMissingEntry(ctx, "Message", num, undefined, "error");
    return false;
  }
  ctx.ui.setWorkingMessage(workingText);
  const result = await sendAndWaitForTurn(pi, ctx, text);
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

async function runOncePhase(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  steps: StartStep[],
  skipMsgs: number,
): Promise<boolean> {
  let skipped = 0;
  for (const step of steps) {
    if (workflowStopRequested) {
      ctx.ui.notify("Workflow stopped", "info");
      return false;
    }
    if (step.msg !== undefined) {
      if (skipped < skipMsgs) {
        skipped++;
        continue;
      }
      if (!(await sendStoredMessage(pi, ctx, step.msg, `Sending message ${step.msg}...`))) return false;
    } else if (step.cmd !== undefined) {
      if (!(await runStoredCommand(pi, ctx, step.cmd, "Running "))) return false;
    }
  }
  return true;
}

async function runPhases(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: WorkflowConfig,
  rounds: number,
  matched: number,
): Promise<boolean> {
  if (!(await runOncePhase(pi, ctx, config.start, matched))) return false;
  for (let round = 1; round <= rounds; round++) {
    for (const step of config.loop) {
      if (workflowStopRequested) {
        ctx.ui.notify("Workflow stopped", "info");
        return false;
      }
      if (step.tree !== undefined) {
        ctx.ui.setWorkingMessage(`Round ${round}/${rounds}: resetting context to message ${step.tree}...`);
        const status = await navigateToMessageAnchor(ctx, step.tree);
        if (!notifyNavigationStatus(ctx, step.tree, status, "Workflow cancelled", "error")) return false;
        continue;
      }
      if (step.onlyIfChanges) {
        const changed = await checkForChanges(pi, ctx, round, rounds);
        if (changed === null) return false;
        if (!changed) continue;
      }
      if (step.cmd !== undefined) {
        if (!(await runStoredCommand(pi, ctx, step.cmd, `Round ${round}/${rounds}: running `))) return false;
      } else if (step.msg !== undefined) {
        if (!(await sendStoredMessage(pi, ctx, step.msg, `Round ${round}/${rounds}: sending message ${step.msg}...`))) return false;
      }
    }
  }
  if (!(await runOncePhase(pi, ctx, config.finally, 0))) return false;
  return true;
}

export async function runWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  config: WorkflowConfig,
  index: string,
  rounds: number,
  messages: Record<string, string>,
): Promise<void> {
  workflowRunning = true;
  workflowStopRequested = false;
  try {
    ctx.ui.setWorkingMessage("Waiting for queued messages to complete...");
    await ctx.waitForIdle();
    const startMsgs = config.start.flatMap((step) => (step.msg !== undefined ? [messages[step.msg]!] : []));
    const matched = countLeadingPhaseMatches(ctx.sessionManager.getBranch(), startMsgs);
    const ok = await runPhases(pi, ctx, config, rounds, matched);
    if (!ok && config.finallyOnError && !workflowStopRequested) {
      await runOncePhase(pi, ctx, config.finally, 0);
    }
    if (ok) ctx.ui.notify(`Workflow ${index} complete: ${rounds} round${rounds === 1 ? "" : "s"}`, "info");
  } finally {
    workflowRunning = false;
    ctx.ui.setWorkingMessage();
  }
}
