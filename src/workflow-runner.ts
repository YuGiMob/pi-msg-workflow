import type { ExecResult, ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getMessages } from "./messages.js";
import { getCommands } from "./commands.js";
import { errorMessage } from "./errors.js";
import { countLeadingPhaseMatches, countPhaseMatches, countUserTextMatches, findAnchorAfterMessage, lastAssistantMessageText } from "./session-helpers.js";
import { runCommand, commandFailureMessage } from "./command-runner.js";
import { runCommit, commitFailureMessage } from "./commit.js";
import { findWorkflowCycle, getWorkflowConfig, loopSections, missingReferences, type WorkflowConfig, type StartStep } from "./workflow-config.js";

const SEND_START_TIMEOUT_MS = 5000;
const SEND_MAX_ATTEMPTS = 3;
const SEND_POLL_INTERVAL_MS = 25;

let workflowStopRequested = false;
let workflowRunning = false;
const workflowStack: string[] = [];
const workflowLabels: string[] = [];

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
    while (true) {
      if (countUserTextMatches(ctx.sessionManager.getBranch(), text) > before) {
        await ctx.waitForIdle();
        return "sent";
      }
      if (workflowStopRequested) return "cancelled";
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
    ctx.ui.notify(`Message ${index} is not in the session. The context resets to the response of the first user message instead`, "warning");
    return true;
  }
  return true;
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

async function runCommitStep(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
  const result = await runCommit(pi, ctx.ui, lastAssistantMessageText(ctx.sessionManager.getBranch()), withWorkflowChain("Committing changes..."));
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
      if (!(await sendStoredMessage(pi, ctx, step.msg, withWorkflowChain(`Sending message ${step.msg}...`)))) return false;
    } else if (step.cmd !== undefined) {
      if (!(await runStoredCommand(pi, ctx, step.cmd, withWorkflowChain("Running ")))) return false;
    } else if (step.workflow !== undefined) {
      if (!(await runSubWorkflow(pi, ctx, step.workflow))) return false;
    } else if (step.commit === true) {
      if (!(await runCommitStep(pi, ctx))) return false;
    }
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
): Promise<boolean> {
  if (!(await runOncePhase(pi, ctx, config.start, matched))) return false;
  const sections = loopSections(config);
  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    const sectionLabel = sections.length > 1 ? `Section ${s + 1}, ` : "";
    for (let round = 1; round <= rounds; round++) {
      workflowLabels[workflowLabels.length - 1] = loopLabel(index, sections.length, s, round, rounds);
      const scope = workflowLabels.length > 1 ? "" : `${sectionLabel}Round ${round}/${rounds}: `;
      for (const step of section) {
        if (workflowStopRequested) {
          ctx.ui.notify("Workflow stopped", "info");
          return false;
        }
        if (step.tree !== undefined) {
          if (step.tree === "0") {
            ctx.ui.setWorkingMessage(withWorkflowChain(`${scope}starting a new session...`));
            const roots = ctx.sessionManager.getTree();
            const root = roots[0];
            if (root !== undefined) {
              const result = await ctx.navigateTree(root.entry.id, { summarize: false });
              if (result.cancelled) {
                ctx.ui.notify("Workflow cancelled", "warning");
                return false;
              }
            }
            ctx.ui.notify("New session started", "info");
            continue;
          }
          ctx.ui.setWorkingMessage(withWorkflowChain(`${scope}resetting context to message ${step.tree}...`));
          const status = await navigateToMessageAnchor(ctx, step.tree);
          if (!notifyNavigationStatus(ctx, step.tree, status, "Workflow cancelled", "error")) return false;
          continue;
        }
        if (step.onlyIfChanges) {
          const changed = await checkForChanges(pi, ctx, scope);
          if (changed === null) return false;
          if (!changed) continue;
        }
        if (step.workflow !== undefined) {
          if (!(await runSubWorkflow(pi, ctx, step.workflow))) return false;
        } else if (step.cmd !== undefined) {
          if (!(await runStoredCommand(pi, ctx, step.cmd, withWorkflowChain(`${scope}running `)))) return false;
        } else if (step.msg !== undefined) {
          if (!(await sendStoredMessage(pi, ctx, step.msg, withWorkflowChain(`${scope}sending message ${step.msg}...`)))) return false;
        } else if (step.commit === true) {
          if (!(await runCommitStep(pi, ctx))) return false;
        }
      }
    }
  }
  workflowLabels[workflowLabels.length - 1] = `Workflow ${index}`;
  if (!(await runOncePhase(pi, ctx, config.finally, 0))) return false;
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
): Promise<boolean> {
  const startMsgs = config.start.flatMap((step) => (step.msg !== undefined && messages[step.msg] !== undefined ? [messages[step.msg]!] : []));
  const matched = leading
    ? countLeadingPhaseMatches(ctx.sessionManager.getBranch(), startMsgs)
    : countPhaseMatches(ctx.sessionManager.getBranch(), startMsgs);
  const ok = await runPhases(pi, ctx, config, index, rounds, matched);
  if (!ok && config.finallyOnError && !workflowStopRequested) {
    await runOncePhase(pi, ctx, config.finally, 0);
  }
  return ok;
}

async function runSubWorkflow(pi: ExtensionAPI, ctx: ExtensionCommandContext, index: string): Promise<boolean> {
  if (workflowStack.includes(index)) {
    ctx.ui.notify(`Circular workflow reference: ${[...workflowStack, index].join(" → ")}`, "error");
    return false;
  }
  const { config, exists, workflows } = getWorkflowConfig(index);
  if (!exists) {
    notifyMissingEntry(ctx, "Workflow", index, "Use /workflow-edit and press w to create it.", "error");
    return false;
  }
  const messages = getMessages();
  const commands = getCommands();
  const { messages: missing, commands: missingCommands, workflows: missingWorkflows } = missingReferences(config, messages, commands, workflows);
  if (missing.length > 0) {
    ctx.ui.notify(`Missing messages in messages.json: ${missing.join(", ")}. Restore the default stores with /workflow-reset or add them with /change-msg.`, "error");
    return false;
  }
  if (missingCommands.length > 0) {
    ctx.ui.notify(`Missing commands in commands.json: ${missingCommands.join(", ")}. Restore the default stores with /workflow-reset or add them with /change-cmd.`, "error");
    return false;
  }
  if (missingWorkflows.length > 0) {
    ctx.ui.notify(`Missing workflows in workflow.json: ${missingWorkflows.join(", ")}. Create them with /workflow-edit (press w).`, "error");
    return false;
  }
  const cycle = findWorkflowCycle(workflows, index);
  if (cycle !== null) {
    ctx.ui.notify(`Circular workflow reference: ${cycle.join(" → ")}. Fix workflow.json first.`, "error");
    return false;
  }
  if (loopSections(config).some((section) => section.length === 0 || section[0]!.tree === undefined)) {
    ctx.ui.notify("The first step of every loop section must be a tree step (context reset)", "error");
    return false;
  }
  workflowStack.push(index);
  workflowLabels.push(`Workflow ${index}`);
  try {
    return await runWorkflowPhases(pi, ctx, config, index, config.rounds, getMessages(), false);
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
): Promise<void> {
  workflowRunning = true;
  workflowStopRequested = false;
  workflowStack.length = 0;
  workflowStack.push(index);
  workflowLabels.length = 0;
  workflowLabels.push(`Workflow ${index}`);
  try {
    ctx.ui.setWorkingMessage("Waiting for queued messages to complete...");
    await ctx.waitForIdle();
    const ok = await runWorkflowPhases(pi, ctx, config, index, rounds, messages, true);
    if (ok) ctx.ui.notify(`Workflow ${index} complete: ${rounds} round${rounds === 1 ? "" : "s"}`, "info");
  } finally {
    workflowRunning = false;
    ctx.ui.setWorkingMessage();
  }
}
