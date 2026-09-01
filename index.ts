import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getMessages, setMessages } from "./src/messages.js";
import { getCommands, setCommands } from "./src/commands.js";
import { MAX_ROUNDS, WORKFLOW_FILE, MESSAGES_FILE, COMMANDS_FILE } from "./src/constants.js";
import { compareNumericKeys } from "./src/json-file.js";
import { runCommand, commandFailureMessage } from "./src/command-runner.js";
import { getWorkflows, getWorkflowConfig, getWorkflowRunError, loopSections, totalLoopSteps, isNumericString, type StartStep, type LoopStep, type WorkflowConfig } from "./src/workflow-config.js";
import { resetUserData } from "./src/user-data.js";
import { WorkflowEditorOverlay, WorkflowTab, MessagesTab, CommandsTab, MAX_OVERLAY_HEIGHT_RATIO, type EditorTab } from "./src/workflow-editor.js";
import { errorMessage } from "./src/errors.js";
import { captureConsoleMessages } from "./src/console-capture.js";
import { requestWorkflowStop, isWorkflowRunning, runWorkflow, notifyMissingEntry, navigateToMessageAnchor, notifyNavigationStatus, extractWorkflowVars, interpolateText } from "./src/workflow-runner.js";

const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center" as const,
    width: "90%" as const,
    minWidth: 60,
    maxHeight: `${MAX_OVERLAY_HEIGHT_RATIO * 100}%` as const,
  },
};

function clip(text: string | undefined, max: number): string {
  if (text === undefined) return "(missing)";
  return text.length > max ? `${text.substring(0, max)}...` : text;
}

function describeStep(step: LoopStep, messages: Record<string, string>, commands: Record<string, string>, workflows: Record<string, WorkflowConfig>, vars: Record<string, string> = {}): string {
  const suffix = `${step.onlyIfChanges ? " (if-changes)" : ""}${step.timeout !== undefined ? ` (timeout ${step.timeout}ms)` : ""}${step.retries !== undefined ? ` (retries ${step.retries})` : ""}`;
  if (step.msg !== undefined) {
    const raw = messages[step.msg];
    return `msg ${step.msg}${suffix}: ${clip(raw === undefined ? undefined : interpolateText(raw, vars), 50)}`;
  }
  if (step.cmd !== undefined) {
    const raw = commands[step.cmd];
    return `cmd ${step.cmd}${suffix}: ${clip(raw === undefined ? undefined : interpolateText(raw, vars), 50)}`;
  }
  if (step.workflow !== undefined) {
    const config = workflows[step.workflow];
    return `wf ${step.workflow}${suffix}: ${config === undefined ? "(missing)" : `${config.rounds} round${config.rounds === 1 ? "" : "s"} (${config.start.length} start, ${totalLoopSteps(config)} loop, ${config.finally.length} finally)`}`;
  }
  if (step.commit === true) return `commit: stage and commit all changes${suffix}`;
  if (step.tree === "0") return `tree 0: new session${suffix}`;
  return `tree ${step.tree!}${suffix}`;
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

function registerStoreCommand(pi: ExtensionAPI, name: string, noun: string, getStore: () => Record<string, string>, execute: (value: string, num: string, ctx: ExtensionCommandContext) => Promise<boolean>): void {
  const isMessage = noun === "Message";
  pi.registerCommand(name, {
    description: isMessage ? "Send a predefined message by number" : "Perform a predefined command by number",
    getArgumentCompletions: (prefix) => storeCompletions(getStore(), noun, prefix),
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, name)) return;
      const num = requireArg(ctx, args, `/${name} <number>`);
      if (num === null) return;
      const value = getStore()[num];
      if (!value) {
        notifyMissingEntry(ctx, noun, num, `Use /change-${name} ${num} "content" to create it.`);
        return;
      }
      const ok = await execute(value, num, ctx);
      if (!ok) return;
      ctx.ui.notify(`${noun} ${num} ${isMessage ? "sent" : "executed"}`, "info");
    },
  });
}

function registerSendCommand(pi: ExtensionAPI, name: string): void {
  registerStoreCommand(pi, name, "Message", getMessages, async (message) => {
    pi.sendUserMessage(message, { deliverAs: "followUp" });
    return true;
  });
}
function registerPerformCommand(pi: ExtensionAPI, name: string): void {
  registerStoreCommand(pi, name, "Command", getCommands, async (command, num, ctx) => {
    const result = await runCommand(pi, command, `Running ${command}...`, ctx.ui);
    if (!result.ok) {
      ctx.ui.notify(commandFailureMessage(num, result), result.reason === "failed" ? "error" : "warning");
      return false;
    }
    return true;
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
      const content = (match[2] ?? match[3] ?? match[4]).trim();
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
  if (!isNumericString(trimmed)) return fallback;
  const value = Number.parseInt(trimmed, 10);
  if (value < 1) return fallback;
  return Math.min(value, MAX_ROUNDS);
}

function notifyConfigErrors(ctx: ExtensionCommandContext, errors: string[]): void {
  if (errors.length > 0) {
    ctx.ui.notify(["[pi-msg-workflow]", ...errors].join("\n"), "warning");
  }
}

export default function (pi: ExtensionAPI) {
  registerSendCommand(pi, "msg");
  registerChangeCommand(pi, "msg", getMessages, setMessages, "Message", MESSAGES_FILE);
  registerShowCommand(pi, "msg", getMessages, "Message");
  registerPerformCommand(pi, "cmd");
  registerChangeCommand(pi, "cmd", getCommands, setCommands, "Command", COMMANDS_FILE);
  registerShowCommand(pi, "cmd", getCommands, "Command");
  if (typeof (pi as unknown as Record<string, unknown>)["registerShortcut"] === "function") {
    (pi as unknown as { registerShortcut: (a: string, b: unknown) => void }).registerShortcut("escape", {
      description: "Stop running workflow",
      handler: async (ctx) => {
        if (isWorkflowRunning()) {
          requestWorkflowStop();
          ctx.ui.notify("Workflow stop requested. It will stop after the current step", "info");
          if (!ctx.isIdle()) (ctx as unknown as { abort?: () => void }).abort?.();
        } else if (!ctx.isIdle()) {
          (ctx as unknown as { abort?: () => void }).abort?.();
        }
      },
    });
  }

  pi.registerCommand("workflow-edit", {
    description:
      "Open an interactive editor for the workflows and the message/command stores (workflow.json / messages.json / commands.json)",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "workflow-edit")) return;
      notifyConfigErrors(ctx, getWorkflowConfig().errors);
      const sink: { overlay: WorkflowEditorOverlay | null } = { overlay: null };
      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const buffered: string[] = [];
        const stopCapturing = captureConsoleMessages((text) => {
          if (sink.overlay !== null) sink.overlay.showConsolePopup(text);
          else buffered.push(text);
        });
        const handleDone = () => {
          try { stopCapturing(); } catch {}
          done();
        };
        try {
          const tabs: EditorTab[] = [
            new WorkflowTab(theme),
            new MessagesTab(theme),
            new CommandsTab(theme),
          ];
          const overlay = new WorkflowEditorOverlay({
            title: "Workflow Editor",
            tabs,
            theme,
            tui,
            done: handleDone,
          });
          sink.overlay = overlay;
          for (const text of buffered) overlay.showConsolePopup(text);
          return overlay;
        } catch (err) {
          try { stopCapturing(); } catch {}
          throw err;
        }
      }, {
        ...OVERLAY_OPTIONS,
        onHandle: () => sink.overlay?.bringConsolePopupToFront(),
      });
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


  pi.registerCommand("workflow-reset", {
    description: "Reset workflow.json, messages.json and commands.json to the packaged defaults",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "workflow-reset")) return;
      const failed = [WORKFLOW_FILE, MESSAGES_FILE, COMMANDS_FILE].filter((file) => !resetUserData(file));
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
    getArgumentCompletions: (prefix) => {
      const { workflows } = getWorkflows();
      const items = Object.keys(workflows)
        .filter((num) => num.startsWith(prefix))
        .map((num) => {
          const config = workflows[num]!;
          return { value: num, label: `Workflow ${num}: ${config.rounds} rounds (${config.start.length} start, ${totalLoopSteps(config)} loop, ${config.finally.length} finally)` };
        });
      for (const flag of ["dry", "list"]) {
        if (flag.startsWith(prefix)) items.push({ value: flag, label: flag });
      }
      return items;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      if (!requireInteractive(ctx, "workflow")) return;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens.some((token) => token === "list")) {
        const { workflows, errors } = getWorkflows();
        notifyConfigErrors(ctx, errors);
        const keys = Object.keys(workflows).sort(compareNumericKeys);
        if (keys.length === 0) {
          ctx.ui.notify("No workflows defined. Use /workflow-edit and press w to create one.", "info");
          return;
        }
        const lines = keys.map((num) => {
          const config = workflows[num]!;
          return `  ${num}: ${config.rounds} round${config.rounds === 1 ? "" : "s"} (${config.start.length} start, ${totalLoopSteps(config)} loop, ${config.finally.length} finally)`;
        });
        ctx.ui.notify(`Workflows:\n${lines.join("\n")}`, "info");
        return;
      }
      const dryRun = tokens.some((token) => token === "dry" || token === "--dry-run");
      const argsWithoutFlags = args.replace(/\b(?:dry|--dry-run)\b/g, " ").replace(/\s+/g, " ").trim();
      const extracted = extractWorkflowVars(argsWithoutFlags);
      const vars = extracted.vars;
      if (extracted.warning !== undefined) ctx.ui.notify(extracted.warning, "warning");
      if (!dryRun && isWorkflowRunning()) {
        ctx.ui.notify("A workflow is already running. Press Esc to cancel it", "warning");
        return;
      }
      const numeric = tokens.filter(isNumericString);
      const index = numeric[0] ?? "3";
      const { config, errors, exists, fallback, workflows } = getWorkflowConfig(index);
      if (!exists) {
        if (fallback && errors.length > 0) {
          notifyConfigErrors(ctx, errors);
        } else {
          ctx.ui.notify(`Workflow ${index} does not exist. Use /workflow-edit and press w to create it.`, "error");
        }
        return;
      }
      notifyConfigErrors(ctx, errors);
      const messages = getMessages();
      const commands = getCommands();
      const runError = getWorkflowRunError(config, messages, commands, workflows, index);
      if (runError !== null) {
        ctx.ui.notify(runError, "error");
        return;
      }
      const rounds = numeric[1] === undefined ? config.rounds : parseRounds(numeric[1], config.rounds);
      if (dryRun) {
        const describeSteps = (steps: StartStep[] | LoopStep[]) =>
          steps.length > 0 ? steps.map((step) => describeStep(step, messages, commands, workflows, vars)).join(", ") : "(none)";
        const loopLines = loopSections(config).map((section, i) => `loop${i === 0 ? "" : ` ${i + 1}`}: ${describeSteps(section)}`).join("\n");
        const varsLine = Object.keys(vars).length > 0 ? `\nvars: ${JSON.stringify(vars)}` : "";
        const earlyLine = config.stopAfterEmpty !== undefined ? `, early-exit after ${config.stopAfterEmpty} empty` : "";
        ctx.ui.notify(`[pi-msg-workflow] Dry run: Workflow ${index}, ${rounds} round${rounds === 1 ? "" : "s"}${earlyLine}${varsLine}\nstart: ${describeSteps(config.start)}\n${loopLines}\nfinally: ${describeSteps(config.finally)}`, "info");
        return;
      }
      await runWorkflow(pi, ctx, config, index, rounds, messages, vars);
    },
  });
}
