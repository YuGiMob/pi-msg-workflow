import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getMessages, setMessages } from "./src/messages.js";
import { getCommands, setCommands } from "./src/commands.js";
import { MAX_ROUNDS } from "./src/constants.js";
import { getWorkflowConfig, referencedIndices, referencedCommands } from "./src/workflow-config.js";
import { WorkflowEditorOverlay, WorkflowTab, MessagesTab, CommandsTab, type EditorTab } from "./src/workflow-editor.js";

const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center" as const,
    width: "90%" as const,
    minWidth: 60,
    maxHeight: "90%" as const,
  },
};

const SEND_START_TIMEOUT_MS = 5000;
const SEND_MAX_ATTEMPTS = 3;
const SEND_POLL_INTERVAL_MS = 25;

let workflowStopRequested = false;

function storeCompletions(store: Record<string, string>, noun: string, prefix: string): AutocompleteItem[] {
  const items = Object.keys(store).map((num) => ({
    value: num,
    label: `${noun} ${num}: ${store[num].substring(0, 50)}${store[num].length > 50 ? '...' : ''}`,
  }));
  const filtered = items.filter((i) => i.value.startsWith(prefix));
  return filtered.length > 0 ? filtered : [];
}

function registerSendCommand(pi: ExtensionAPI, name: string): void {
  pi.registerCommand(name, {
    description: "Send a predefined message by number",
    getArgumentCompletions: (prefix) => storeCompletions(getMessages(), "Message", prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(`/${name} requires interactive mode`, "error");
        return;
      }
      const num = args.trim();
      if (!num) {
        ctx.ui.notify(`Usage: /${name} <number>`, "warning");
        return;
      }
      const message = getMessages()[num];
      if (!message) {
        ctx.ui.notify(`Message ${num} does not exist. Use /change-${name} ${num} "content" to create it.`, "warning");
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
      if (!ctx.hasUI) {
        ctx.ui.notify(`/${name} requires interactive mode`, "error");
        return;
      }
      const num = args.trim();
      if (!num) {
        ctx.ui.notify(`Usage: /${name} <number>`, "warning");
        return;
      }
      const command = getCommands()[num];
      if (!command) {
        ctx.ui.notify(`Command ${num} does not exist. Use /change-${name} ${num} "content" to create it.`, "warning");
        return;
      }
      const parts = command.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        ctx.ui.notify(`Command ${num} is empty.`, "warning");
        return;
      }
      const result = await pi.exec(parts[0]!, parts.slice(1));
      if (result.code !== 0) {
        ctx.ui.notify(`Command ${num} failed: ${result.stderr}`, "error");
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
): void {
  pi.registerCommand(`change-${name}`, {
    description: `Change or create a predefined ${noun.toLowerCase()}`,
    getArgumentCompletions: (prefix) => storeCompletions(read(), noun, prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(`/change-${name} requires interactive mode`, "error");
        return;
      }
      if (!args.trim()) {
        ctx.ui.notify(`Usage: /change-${name} <number> <content>`, "warning");
        return;
      }
      const match = args.trim().match(/^(\d+)\s+(?:"([^"]*)"|'([^']*)'|(.+))$/);
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
      write(store);
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
      if (!ctx.hasUI) {
        ctx.ui.notify(`/show-${name} requires interactive mode`, "error");
        return;
      }
      const num = args.trim();
      if (!num) {
        const store = read();
        const keys = Object.keys(store);
        if (keys.length === 0) {
          ctx.ui.notify(`No ${noun.toLowerCase()}s defined.`, "info");
          return;
        }
        const list = keys.map((k) => `  ${k}: ${store[k].substring(0, 200)}${store[k].length > 200 ? "..." : ""}`).join("\n");
        ctx.ui.notify(`${noun}s:\n${list}`, "info");
        return;
      }
      const entry = read()[num];
      if (!entry) {
        ctx.ui.notify(`${noun} ${num} does not exist.`, "warning");
        return;
      }
      ctx.ui.notify(`${noun} ${num}: ${entry}`, "info");
    },
  });
}

function parseRounds(args: string, fallback: number): number {
  const value = Number.parseInt(args.trim(), 10);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(value, MAX_ROUNDS);
}

interface TextBlock {
  type?: string;
  text?: string;
}

function userMessageText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "user") return undefined;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as TextBlock[])
      .filter((block) => block?.type === "text")
      .map((block) => block.text ?? "")
      .join("");
  }
  return undefined;
}

function countLeadingPhaseMatches(entries: SessionEntry[], expected: string[]): number {
  let matched = 0;
  for (const entry of entries) {
    const text = userMessageText(entry);
    if (text !== undefined && matched < expected.length && text === expected[matched]) {
      matched++;
    }
  }
  return matched;
}

function findAnchorAfterMessage(entries: SessionEntry[], messageText: string): SessionEntry | undefined {
  let firstUserIndex = -1;
  let messageIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    const text = userMessageText(entries[i]);
    if (text === undefined) continue;
    if (firstUserIndex === -1) firstUserIndex = i;
    if (messageIndex === -1 && text === messageText) messageIndex = i;
  }
  const anchorIndex = messageIndex !== -1 ? messageIndex : firstUserIndex;
  if (anchorIndex === -1) return undefined;
  for (let i = anchorIndex + 1; i < entries.length; i++) {
    if (userMessageText(entries[i]) !== undefined) {
      return entries[i - 1];
    }
  }
  return undefined;
}

function countUserTextMatches(entries: SessionEntry[], text: string): number {
  return entries.filter((entry) => userMessageText(entry) === text).length;
}

type SendResult = "sent" | "failed" | "cancelled";

async function sendAndWaitForTurn(
  pi: ExtensionAPI,
  ctx: { isIdle(): boolean; waitForIdle(): Promise<void>; sessionManager: { getBranch(): SessionEntry[] } },
  text: string,
): Promise<SendResult> {
  for (let attempt = 0; attempt < SEND_MAX_ATTEMPTS; attempt++) {
    const before = countUserTextMatches(ctx.sessionManager.getBranch(), text);
    pi.sendUserMessage(text, { deliverAs: "followUp" });
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

type TreeNavigationStatus = "ok" | "missing" | "not-found" | "cancelled";

async function navigateToMessageAnchor(ctx: ExtensionCommandContext, index: string): Promise<TreeNavigationStatus> {
  const text = getMessages()[index];
  if (!text) return "missing";
  const anchor = findAnchorAfterMessage(ctx.sessionManager.getBranch(), text);
  if (!anchor) return "not-found";
  const navigation = await ctx.navigateTree(anchor.id, { summarize: false });
  return navigation.cancelled ? "cancelled" : "ok";
}

function notifyNavigationStatus(
  ctx: ExtensionCommandContext,
  index: string,
  status: TreeNavigationStatus,
  cancelledText: string,
  kind: "warning" | "error",
): boolean {
  if (status === "missing") {
    ctx.ui.notify(`Message ${index} does not exist.`, kind);
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
  return true;
}

function notifyConfigErrors(ctx: ExtensionCommandContext, errors: string[]): void {
  if (errors.length > 0) {
    ctx.ui.notify(["[pi-workflow]", ...errors].join("\n"), "warning");
  }
}

export default function (pi: ExtensionAPI) {
  registerSendCommand(pi, "msg");
  registerChangeCommand(pi, "msg", getMessages, setMessages, "Message");
  registerShowCommand(pi, "msg", getMessages, "Message");
  registerPerformCommand(pi, "cmd");
  registerChangeCommand(pi, "cmd", getCommands, setCommands, "Command");
  registerShowCommand(pi, "cmd", getCommands, "Command");

  pi.registerCommand("workflow-edit", {
    description:
      "Open an interactive editor for the workflow definition and the message/command stores (workflow.json / messages.json / commands.json)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflow-edit requires interactive mode", "error");
        return;
      }
      notifyConfigErrors(ctx, getWorkflowConfig().errors);
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
        const tabs: EditorTab[] = [
          new WorkflowTab(theme, (text, kind) => ctx.ui.notify(text, kind)),
          new MessagesTab(theme, (text, kind) => ctx.ui.notify(text, kind)),
          new CommandsTab(theme, (text, kind) => ctx.ui.notify(text, kind)),
        ];
        return new WorkflowEditorOverlay({
          title: "Workflow Editor",
          subtitle: "workflow.json · messages.json · commands.json",
          tabs,
          theme,
          done,
          onNotify: (text, kind) => ctx.ui.notify(text, kind),
        });
      }, OVERLAY_OPTIONS);
    },
  });

  pi.registerCommand("tree-jump", {
    description: "Reset the agent's context to the response of a predefined message (by index)",
    getArgumentCompletions: (prefix) => storeCompletions(getMessages(), "Message", prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/tree-jump requires interactive mode", "error");
        return;
      }
      const index = args.trim();
      if (!index) {
        ctx.ui.notify("Usage: /tree-jump <number>", "warning");
        return;
      }
      const status = await navigateToMessageAnchor(ctx, index);
      if (!notifyNavigationStatus(ctx, index, status, "Navigation cancelled", "warning")) return;
      ctx.ui.notify(`Context reset to the response of message ${index}`, "info");
    },
  });

  pi.registerCommand("workflow-stop", {
    description: "Cancel the running workflow after the current step completes",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflow-stop requires interactive mode", "error");
        return;
      }
      workflowStopRequested = true;
      ctx.ui.notify("Workflow stop requested - it will stop after the current step", "info");
    },
  });

  pi.registerCommand("workflow", {
    description:
      "Run the configured improvement workflow: start messages, then review rounds of tree reset, stored commands and messages (see workflow.json)",
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/workflow requires interactive mode", "error");
        return;
      }
      const messages = getMessages();
      const { config, errors } = getWorkflowConfig();
      notifyConfigErrors(ctx, errors);
      const missing = referencedIndices(config).filter((num) => !messages[num]);
      if (missing.length > 0) {
        ctx.ui.notify(`Missing messages in messages.json: ${missing.join(", ")}`, "error");
        return;
      }
      const commands = getCommands();
      const missingCommands = referencedCommands(config).filter((num) => !commands[num]);
      if (missingCommands.length > 0) {
        ctx.ui.notify(`Missing commands in commands.json: ${missingCommands.join(", ")}`, "error");
        return;
      }
      if (config.loop.length === 0 || config.loop[0]!.tree === undefined) {
        ctx.ui.notify("The first step of the loop must be a tree step (context reset)", "error");
        return;
      }
      const rounds = parseRounds(args, config.rounds);
      workflowStopRequested = false;
      try {
        ctx.ui.setWorkingMessage("Waiting for queued messages to complete...");
        await ctx.waitForIdle();
        const startTexts = config.start.map((num) => messages[num]!);
        const matched = countLeadingPhaseMatches(ctx.sessionManager.getBranch(), startTexts);
        for (const num of config.start.slice(matched)) {
          if (workflowStopRequested) {
            ctx.ui.notify("Workflow stopped", "info");
            return;
          }
          ctx.ui.setWorkingMessage(`Sending message ${num}...`);
          const result = await sendAndWaitForTurn(pi, ctx, messages[num]!);
          if (result === "cancelled") {
            ctx.ui.notify("Workflow stopped", "info");
            return;
          }
          if (result === "failed") {
            ctx.ui.notify(`Failed to send message ${num}`, "error");
            return;
          }
        }
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
            } else if (step.cmd !== undefined) {
              const command = getCommands()[step.cmd];
              if (!command) {
                ctx.ui.notify(`Command ${step.cmd} does not exist.`, "error");
                return;
              }
              ctx.ui.setWorkingMessage(`Round ${round}/${rounds}: running ${command}...`);
              const parts = command.trim().split(/\s+/).filter(Boolean);
              if (parts.length === 0) {
                ctx.ui.notify(`Command ${step.cmd} is empty.`, "error");
                return;
              }
              const result = await pi.exec(parts[0]!, parts.slice(1));
              if (result.code !== 0) {
                ctx.ui.notify(`Command ${step.cmd} failed: ${result.stderr}`, "error");
                return;
              }
            } else if (step.send !== undefined) {
              if (step.onlyIfChanges) {
                ctx.ui.setWorkingMessage(`Round ${round}/${rounds}: checking for changes...`);
                const statusResult = await pi.exec("git", ["status", "--porcelain"]);
                if (statusResult.code !== 0) {
                  ctx.ui.notify(`git status --porcelain failed: ${statusResult.stderr}`, "error");
                  return;
                }
                if (!statusResult.stdout.trim()) {
                  ctx.ui.notify(`Round ${round}/${rounds}: no changes detected, skipping message ${step.send}`, "info");
                  continue;
                }
              }
              ctx.ui.setWorkingMessage(`Round ${round}/${rounds}: sending message ${step.send}...`);
              const result = await sendAndWaitForTurn(pi, ctx, messages[step.send]!);
              if (result === "cancelled") {
                ctx.ui.notify("Workflow stopped", "info");
                return;
              }
              if (result === "failed") {
                ctx.ui.notify(`Failed to send message ${step.send}`, "error");
                return;
              }
            }
          }
        }
        ctx.ui.notify(`Workflow complete: ${rounds} round${rounds === 1 ? "" : "s"}`, "info");
      } finally {
        ctx.ui.setWorkingMessage();
      }
    },
  });
}
