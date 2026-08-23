import { describe, expect, it, vi } from "vitest";
import { splitCommand, commandFailureMessage, runCommand } from "../src/command-runner.js";

describe("splitCommand", () => {
  it("splits on whitespace", () => {
    expect(splitCommand("git add .")).toEqual(["git", "add", "."]);
  });

  it("trims surrounding whitespace", () => {
    expect(splitCommand("  git  add  .  ")).toEqual(["git", "add", "."]);
  });

  it("keeps double-quoted arguments together", () => {
    expect(splitCommand('git commit -m "my message"')).toEqual(["git", "commit", "-m", "my message"]);
  });

  it("keeps single-quoted arguments together", () => {
    expect(splitCommand("git commit -m 'my message'")).toEqual(["git", "commit", "-m", "my message"]);
  });

  it("preserves empty quoted arguments", () => {
    expect(splitCommand('git commit -m ""')).toEqual(["git", "commit", "-m", ""]);
  });

  it("supports escaped quotes inside double quotes", () => {
    expect(splitCommand('git commit -m "say \\"hi\\""')).toEqual(["git", "commit", "-m", 'say "hi"']);
  });

  it("supports escaped backslashes inside double quotes", () => {
    expect(splitCommand('git commit -m "a\\\\b"')).toEqual(["git", "commit", "-m", "a\\b"]);
  });

  it("treats a backslash outside quotes literally", () => {
    expect(splitCommand("git add \\.")).toEqual(["git", "add", "\\."]);
  });

  it("returns null for an unterminated double quote", () => {
    expect(splitCommand('git commit -m "my message')).toBeNull();
  });

  it("returns null for an unterminated single quote", () => {
    expect(splitCommand("git commit -m 'my message")).toBeNull();
  });

  it("returns an empty array for empty input", () => {
    expect(splitCommand("")).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(splitCommand("   ")).toEqual([]);
  });
});

describe("commandFailureMessage", () => {
  it("reports empty commands", () => {
    expect(commandFailureMessage("1", { ok: false, reason: "empty", stderr: "" })).toBe("Command 1 is empty.");
  });

  it("reports unterminated quotes", () => {
    expect(commandFailureMessage("1", { ok: false, reason: "unterminated", stderr: "" })).toBe("Command 1 has an unterminated quote.");
  });

  it("reports failures with stderr", () => {
    expect(commandFailureMessage("1", { ok: false, reason: "failed", stderr: "boom", stdout: "" })).toBe("Command 1 failed: boom");
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(commandFailureMessage("1", { ok: false, reason: "failed", stderr: "", stdout: "boom" })).toBe("Command 1 failed: boom");
  });

  it("reports when there is no error output", () => {
    expect(commandFailureMessage("1", { ok: false, reason: "failed", stderr: "", stdout: "" })).toBe("Command 1 failed with no error output");
  });
});

describe("runCommand", () => {
  function createPi() {
    return { exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })) };
  }

  it("rejects a quotes-only command as empty", async () => {
    const pi = createPi();
    const ui = { setWorkingMessage: vi.fn() };
    const result = await runCommand(pi as any, '""', "running...", ui);
    expect(result).toEqual({ ok: false, reason: "empty", stderr: "" });
    expect(pi.exec).not.toHaveBeenCalled();
    expect(ui.setWorkingMessage).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only command as empty", async () => {
    const pi = createPi();
    const ui = { setWorkingMessage: vi.fn() };
    const result = await runCommand(pi as any, "   ", "running...", ui);
    expect(result).toEqual({ ok: false, reason: "empty", stderr: "" });
    expect(pi.exec).not.toHaveBeenCalled();
  });

  it("executes a parsed command and reports success", async () => {
    const pi = createPi();
    const ui = { setWorkingMessage: vi.fn() };
    const result = await runCommand(pi as any, "git add .", "running...", ui);
    expect(result).toEqual({ ok: true });
    expect(pi.exec).toHaveBeenCalledWith("git", ["add", "."]);
    expect(ui.setWorkingMessage).toHaveBeenLastCalledWith();
  });
});
