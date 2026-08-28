import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage, execFailureMessage } from "./errors.js";

export type CommandResult =
  | { ok: true }
  | { ok: false; reason: "empty"; stderr: string }
  | { ok: false; reason: "unterminated"; stderr: string }
  | { ok: false; reason: "failed"; stderr: string; stdout: string };

export function splitCommand(command: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  const text = command.trim();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\" && quote === '"') {
        const next = text[i + 1];
        if (next === '"' || next === "\\") {
          current += next;
          started = true;
          i++;
        } else {
          current += ch;
          started = true;
        }
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
        started = true;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        parts.push(current);
        current = "";
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) parts.push(current);
  return parts;
}
export function commandFailureMessage(num: string, result: Extract<CommandResult, { ok: false }>): string {
  if (result.reason === "empty") return `Command ${num} is empty.`;
  if (result.reason === "unterminated") return `Command ${num} has an unterminated quote.`;
  return execFailureMessage(`Command ${num} failed`, result.stderr, result.stdout);
}

export async function runCommand(
  pi: ExtensionAPI,
  command: string,
  workingText: string,
  ui: { setWorkingMessage(message?: string): void },
): Promise<CommandResult> {
  const parts = splitCommand(command);
  if (parts === null) return { ok: false, reason: "unterminated", stderr: "" };
  if (parts.length === 0 || parts[0] === "") return { ok: false, reason: "empty", stderr: "" };
  ui.setWorkingMessage(workingText);
  try {
    const result = await pi.exec(parts[0]!, parts.slice(1));
    if (result.code !== 0) return { ok: false, reason: "failed", stderr: result.stderr, stdout: result.stdout };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "failed", stderr: errorMessage(err), stdout: "" };
  } finally {
    ui.setWorkingMessage();
  }
}
