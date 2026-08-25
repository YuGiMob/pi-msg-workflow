import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { errorMessage } from "./errors.js";

export type CommitResult =
  | { ok: true; committed: boolean }
  | { ok: false; reason: "failed"; stderr: string; stdout: string };

export function commitFailureMessage(result: Extract<CommitResult, { ok: false }>): string {
  if (result.stderr.trim() !== "") return `Commit failed: ${result.stderr}`;
  if (result.stdout.trim() !== "") return `Commit failed: ${result.stdout}`;
  return "Commit failed with no error output";
}

function commitMessage(nameOnlyOutput: string): string {
  const files = nameOnlyOutput.trim().split(/\s+/).filter(Boolean);
  if (files.length === 0) return "Update";
  const shown = files.slice(0, 5);
  const suffix = files.length > 5 ? ` and ${files.length - 5} more` : "";
  return `Update ${shown.join(", ")}${suffix}`;
}

export async function runCommit(pi: ExtensionAPI, ui: { setWorkingMessage(message?: string): void }, message?: string): Promise<CommitResult> {
  ui.setWorkingMessage("Committing changes...");
  try {
    const status = await pi.exec("git", ["status", "--porcelain"]);
    if (status.code !== 0) return { ok: false, reason: "failed", stderr: status.stderr, stdout: status.stdout };
    if (status.stdout.trim() === "") return { ok: true, committed: false };
    const add = await pi.exec("git", ["add", "-A"]);
    if (add.code !== 0) return { ok: false, reason: "failed", stderr: add.stderr, stdout: add.stdout };
    const names = await pi.exec("git", ["diff", "--cached", "--name-only"]);
    if (names.code !== 0) return { ok: false, reason: "failed", stderr: names.stderr, stdout: names.stdout };
    const text = message !== undefined && message.trim() !== "" ? message.trim() : commitMessage(names.stdout);
    const commit = await pi.exec("git", ["commit", "-m", text]);
    if (commit.code !== 0) return { ok: false, reason: "failed", stderr: commit.stderr, stdout: commit.stdout };
    return { ok: true, committed: true };
  } catch (err) {
    return { ok: false, reason: "failed", stderr: errorMessage(err), stdout: "" };
  } finally {
    ui.setWorkingMessage();
  }
}
