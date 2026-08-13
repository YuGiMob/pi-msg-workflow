import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getMessages, setMessages } from "./src/messages.js";
import { getCommands, setCommands } from "./src/commands.js";
import { MAX_ROUNDS } from "./src/constants.js";
import { runCommand, commandFailureMessage } from "./src/command-runner.js";
import { getWorkflowConfig, missingReferences, type StartStep, type LoopStep } from "./src/workflow-config.js";
import { resetUserData } from "./src/user-data.js";
import { countLeadingPhaseMatches, findAnchorAfterMessage, countUserTextMatches } from "./src/session-helpers.js";
import { WorkflowEditorOverlay, WorkflowTab, MessagesTab, CommandsTab, MAX_OVERLAY_HEIGHT_RATIO, type EditorTab } from "./src/workflow-editor.js";
import { errorMessage } from "./src/errors.js";

const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center" as const,
    width: "90%" as const,
    minWidth: 60,
    maxHeight: `${MAX_OVERLAY_HEIGHT_RATIO * 100}%` as const,
  },
};

const SEND_START_TIMEOUT_MS = 5000;
const SEND_MAX_ATTEMPTS = 3;
const SEND_POLL_INTERVAL_MS = 25;

let workflowStopRequested = false;
let workflowRunning = false;

function clip(text: string | undefined, max: number): string {
  if (text === undefined) return "(missing)";
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

function describeStep(step: LoopStep, messages: Record<string, string>, commands: Record<string, string>): string {
  const suffix = step.onlyIfChanges ? " (if-changes)" : "";
  if (step.msg !== undefined) return `msg ${step.msg}${suffix}: ${clip(messages[step.msg], 50)}`;
  if (step.cmd !== undefined) return `cmd ${step.cmd}${suffix}: ${clip(commands[step.cmd], 50)}`;
  return `tree ${step.tree!}`;
}
function storeCompletions(store: Record<string, string>, noun: string, prefix: string): AutocompleteItem[] {
  return Object.keys(store)
    .filter((num) => num.startsWith(prefix))
    .map((num) => ({ value: num, label: `${noun} ${num}: ${clip(store[num], 50)}` }));
}

function requireInteractive(ctx: ExtensionCommandContext, name: string): boolean {
  if (ctx.hasUI) return true;
  ctx.ui.notify(`/${name} requires interactive mode`, "error");
  return false;
}

function requireArg(ctx: ExtensionCommandContext, args: string, usage: string): string | null {
  const trimmed = args.trim();
  if (trimmed !== "") return trimmed;
  ctx.ui.notify(`Usage: ${usage}`, "warning");
  return null;
}

function notifyMissingEntry(
  ctx: ExtensionCommandContext,
  noun: string,
  num: string,
  hint?: string,
  kind: "warning" | "error" = "warning",
): void {
  ctx.ui.notify(`${noun} ${num} does not exist.${hint !== undefined ? ` ${hint}` : ""}`, kind);
}

function registerSendCommand(pi: ExtensionAPI, name: string): void {
  pi.registerCommand(name, {
    description: "Send a predefined message by number",
    getArgumentCompletions: (prefix) => storeCompletions(getMessages(), "Message", prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, name)) return;
      const num = requireArg(ctx, args, `/${name} <number>`);
      if (num === null) return;
      const message = getMessages()[num];
      if (!message) {
        notifyMissingEntry(ctx, "Message", num, `Use /change-${name} ${num} "content" to create it.`);
        return;
      }
      pi.sendUserMessage(message, { deliverAs: "followUp" });
      ctx.ui.notify(`Message ${num} sent`, "info");
    },
  });
}

function registerPerformCommand(pi: ExtensionAPI, name: string): void {
  pi.registerCommand(name, {
    description: "Perform a predefined command by number",
    getArgumentCompletions: (prefix) => storeCompletions(getCommands(), "Command", prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, name)) return;
      const num = requireArg(ctx, args, `/${name} <number>`);
      if (num === null) return;
      const command = getCommands()[num];
      if (!command) {
        notifyMissingEntry(ctx, "Command", num, `Use /change-${name} ${num} "content" to create it.`);
        return;
      }
      const result = await runCommand(pi, command, `Running ${command}...`, ctx.ui);
      if (!result.ok) {
        ctx.ui.notify(commandFailureMessage(num, result), result.reason === "failed" ? "error" : "warning");
        return;
      }
      ctx.ui.notify(`Command ${num} executed`, "info");
    },
  });
}

function registerChangeCommand(
  pi: ExtensionAPI,
  name: string,
  read: () => Record<string, string>,
  write: (store: Record<string, string>) => void,
  noun: string,
  fileLabel: string,
): void {
  pi.registerCommand(`change-${name}`, {
    description: `Change or create a predefined ${noun.toLowerCase()}`,
    getArgumentCompletions: (prefix) => storeCompletions(read(), noun, prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, `change-${name}`)) return;
      const trimmed = requireArg(ctx, args, `/change-${name} <number> <content>`);
      if (trimmed === null) return;
      const match = trimmed.match(/^(\d+)\s+(?:"([^"]*)"|'([^']*)'|([^"'].*))$/);
      if (!match) {
        ctx.ui.notify(`Usage: /change-${name} <number> "<content>"`, "warning");
        return;
      }
      const num = match[1];
      const content = match[2] ?? match[3] ?? match[4];
      if (content.length < 5) {
        ctx.ui.notify(`${noun} must be at least 5 characters`, "warning");
        return;
      }
      const store = read();
      store[num] = content;
      try {
        write(store);
      } catch (err) {
        ctx.ui.notify(`Could not save ${fileLabel}: ${errorMessage(err)}`, "error");
        return;
      }
      ctx.ui.notify(`${noun} ${num} updated`, "info");
    },
  });
}

function registerShowCommand(
  pi: ExtensionAPI,
  name: string,
  read: () => Record<string, string>,
  noun: string,
): void {
  pi.registerCommand(`show-${name}`, {
    description: `Display the contents of a predefined ${noun.toLowerCase()}`,
    getArgumentCompletions: (prefix) => storeCompletions(read(), noun, prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, `show-${name}`)) return;
      const num = args.trim();
      if (!num) {
        const store = read();
        const keys = Object.keys(store);
        if (keys.length === 0) {
          ctx.ui.notify(`No ${noun.toLowerCase()}s defined.`, "info");
          return;
        }
        const list = keys.map((k) => `  ${k}: ${clip(store[k], 200)}`).join("\n");
        ctx.ui.notify(`${noun}s:\n${list}`, "info");
        return;
      }
      const entry = read()[num];
      if (!entry) {
        notifyMissingEntry(ctx, noun, num);
        return;
      }
      ctx.ui.notify(`${noun} ${num}: ${entry}`, "info");
    },
  });
}

function parseRounds(args: string, fallback: number): number {
  const trimmed = args.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (value < 1) return fallback;
  return Math.min(value, MAX_ROUNDS);
}
async function checkForChanges(pi: ExtensionAPI, ctx: ExtensionCommandContext, round: number, rounds: number): Promise<boolean | null> {
  ctx.ui.setWorkingMessage(`Round ${round}/${rounds}: checking for changes...`);
  const statusResult = await pi.exec("git", ["status", "--porcelain"]);
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


type SendResult = "sent" | "failed" | "cancelled";

async function sendAndWaitForTurn(
  pi: ExtensionAPI,
  ctx: { isIdle(): boolean; waitForIdle(): Promise<void>; sessionManager: { getBranch(): SessionEntry[] } },
  text: string,
): Promise<SendResult> {
  for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
    if (workflowStopRequested) return "cancelled";
    const before = countUserTextMatches(ctx.sessionManager.getBranch(), text);
    try {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    } catch {
      return "failed";
    }
    const deadline = Date.now() + SEND_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (countUserTextMatches(ctx.sessionManager.getBranch(), text) > before) {
        await ctx.waitForIdle();
        return "sent";
      }
      if (workflowStopRequested) return "cancelled";
      if (!ctx.isIdle()) {
        await ctx.waitForIdle();
        if (countUserTextMatches(ctx.sessionManager.getBranch(), text) > before) return "sent";
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_POLL_INTERVAL_MS));
    }
  }
  return "failed";
}

type TreeNavigationStatus = "ok" | "missing" | "not-found" | "cancelled" | "fallback";

async function navigateToMessageAnchor(ctx: ExtensionCommandContext, index: string, requirePresence = false): Promise<TreeNavigationStatus> {
  const text = getMessages()[index];
  if (!text) return "missing";
  const present = countUserTextMatches(ctx.sessionManager.getBranch(), text) > 0;
  if (requirePresence && !present) return "not-found";
  const anchor = findAnchorAfterMessage(ctx.sessionManager.getBranch(), text);
  if (!anchor) return "not-found";
  const navigation = await ctx.navigateTree(anchor.id, { summarize: false });
  if (navigation.cancelled) return "cancelled";
  return present ? "ok" : "fallback";
}

function notifyNavigationStatus(
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
  if (status === "fallback") {
    ctx.ui.notify(`Message ${index} is not in the session - context reset to the response of the first user message instead`, "warning");
    return true;
  }
  return true;
}

function notifyConfigErrors(ctx: ExtensionCommandContext, errors: string[]): void {
  if (errors.length > 0) {
    ctx.ui.notify(["[pi-msg-workflow]", ...errors].join("\n"), "warning");
  }
}

export default function (pi: ExtensionAPI) {
  registerSendCommand(pi, "msg");
  registerChangeCommand(pi, "msg", getMessages, setMessages, "Message", "messages.json");
  registerShowCommand(pi, "msg", getMessages, "Message");
  registerPerformCommand(pi, "cmd");
  registerChangeCommand(pi, "cmd", getCommands, setCommands, "Command", "commands.json");
  registerShowCommand(pi, "cmd", getCommands, "Command");

  pi.registerCommand("workflow-edit", {
    description:
      "Open an interactive editor for the workflows and the message/command stores (workflow.json / messages.json / commands.json)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "workflow-edit")) return;
      notifyConfigErrors(ctx, getWorkflowConfig().errors);
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const tabs: EditorTab[] = [
          new WorkflowTab(theme, (text, kind) => ctx.ui.notify(text, kind)),
          new MessagesTab(theme, (text, kind) => ctx.ui.notify(text, kind)),
          new CommandsTab(theme, (text, kind) => ctx.ui.notify(text, kind)),
        ];
        return new WorkflowEditorOverlay({
          title: "Workflow Editor",
          tabs,
          theme,
          tui,
          done,
        });
      }, OVERLAY_OPTIONS);
    },
  });

  pi.registerCommand("tree-jump", {
    description: "Reset the agent's context to the response of a predefined message (by index)",
    getArgumentCompletions: (prefix) => storeCompletions(getMessages(), "Message", prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "tree-jump")) return;
      const index = requireArg(ctx, args, "/tree-jump <number>");
      if (index === null) return;
      const status = await navigateToMessageAnchor(ctx, index, true);
      if (!notifyNavigationStatus(ctx, index, status, "Navigation cancelled", "warning")) return;
      ctx.ui.notify(`Context reset to the response of message ${index}`, "info");
    },
  });

  pi.registerCommand("workflow-stop", {
    description: "Cancel the running workflow after the current step completes",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "workflow-stop")) return;
      if (!workflowRunning) {
        ctx.ui.notify("No workflow is currently running", "info");
        return;
      }
      workflowStopRequested = true;
      ctx.ui.notify("Workflow stop requested - it will stop after the current step", "info");
    },
  });

  pi.registerCommand("workflow-reset", {
    description: "Reset workflow.json, messages.json and commands.json to the packaged defaults",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "workflow-reset")) return;
      const failed = ["workflow.json", "messages.json", "commands.json"].filter((file) => !resetUserData(file));
      if (failed.length === 0) {
        ctx.ui.notify("Configuration reset to the packaged defaults (workflow.json, messages.json, commands.json)", "info");
      } else {
        ctx.ui.notify(`Could not reset: ${failed.join(", ")}`, "error");
      }
    },
  });

  pi.registerCommand("workflow", {
    description:
      "Run a numbered workflow (default 1): start messages, then review rounds of tree reset, stored commands and messages (see workflow.json)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "workflow")) return;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const dryRun = tokens.some((token) => token === "dry" || token === "--dry-run");
      if (!dryRun && workflowRunning) {
        ctx.ui.notify("A workflow is already running - use /workflow-stop to cancel it", "warning");
        return;
      }
      const numeric = tokens.filter((token) => /^\d+$/.test(token));
      const index = numeric[0] ?? "1";
      const { config, errors, exists } = getWorkflowConfig(index);
      if (!exists) {
        ctx.ui.notify(`Workflow ${index} does not exist. Use /workflow-edit and press w to create it.`, "error");
        return;
      }
      notifyConfigErrors(ctx, errors);
      const messages = getMessages();
      const commands = getCommands();
      const { messages: missing, commands: missingCommands } = missingReferences(config, messages, commands);
      if (missing.length > 0) {
        ctx.ui.notify(`Missing messages in messages.json: ${missing.join(", ")} - run /workflow-reset to restore the default stores or add them with /change-msg.`, "error");
        return;
      }
      if (missingCommands.length > 0) {
        ctx.ui.notify(`Missing commands in commands.json: ${missingCommands.join(", ")} - run /workflow-reset to restore the default stores or add them with /change-cmd.`, "error");
        return;
      }
      if (config.loop.length === 0 || config.loop[0]!.tree === undefined) {
        ctx.ui.notify("The first step of the loop must be a tree step (context reset)", "error");
        return;
      }
      const rounds = numeric[1] === undefined ? config.rounds : parseRounds(numeric[1], config.rounds);
      if (dryRun) {
        const describeSteps = (steps: StartStep[] | LoopStep[]) =>
          steps.length > 0 ? steps.map((step) => describeStep(step, messages, commands)).join(", ") : "(none)";
        ctx.ui.notify(`[pi-msg-workflow] Dry run: Workflow ${index}, ${rounds} round${rounds === 1 ? "" : "s"}\nstart: ${describeSteps(config.start)}\nloop: ${describeSteps(config.loop)}\nfinally: ${describeSteps(config.finally)}`, "info");
        return;
      }
      workflowRunning = true;
      workflowStopRequested = false;
      try {
        ctx.ui.setWorkingMessage("Waiting for queued messages to complete...");
        await ctx.waitForIdle();
        const startMsgs = config.start.flatMap((step) => (step.msg !== undefined ? [messages[step.msg]!] : []));
        const matched = countLeadingPhaseMatches(ctx.sessionManager.getBranch(), startMsgs);
        if (!(await runOncePhase(pi, ctx, config.start, matched))) return;
        for (let round = 1; round <= rounds; round++) {
          for (const step of config.loop) {
            if (workflowStopRequested) {
              ctx.ui.notify("Workflow stopped", "info");
              return;
            }
            if (step.tree !== undefined) {
              ctx.ui.setWorkingMessage(`Round ${round}/${rounds}: resetting context to message ${step.tree}...`);
              const status = await navigateToMessageAnchor(ctx, step.tree);
              if (!notifyNavigationStatus(ctx, step.tree, status, "Workflow cancelled", "error")) return;
              continue;
            }
            if (step.onlyIfChanges) {
              const changed = await checkForChanges(pi, ctx, round, rounds);
              if (changed === null) return;
              if (!changed) continue;
            }
            if (step.cmd !== undefined) {
              if (!(await runStoredCommand(pi, ctx, step.cmd, `Round ${round}/${rounds}: running `))) return;
            } else if (step.msg !== undefined) {
              if (!(await sendStoredMessage(pi, ctx, step.msg, `Round ${round}/${rounds}: sending message ${step.msg}...`))) return;
            }
          }
        }
        if (!(await runOncePhase(pi, ctx, config.finally, 0))) return;
        ctx.ui.notify(`Workflow ${index} complete: ${rounds} round${rounds === 1 ? "" : "s"}`, "info");
      } finally {
        workflowRunning = false;
        ctx.ui.setWorkingMessage();
      }
    },
  });
}
