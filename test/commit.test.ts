import { describe, expect, it, vi } from "vitest";
import { runCommit, commitFailureMessage } from "../src/commit.js";

function createPi(execImpl?: (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>) {
  return { exec: vi.fn(execImpl ?? (async () => ({ code: 0, stdout: "", stderr: "" }))) };
}

describe("runCommit", () => {
  it("reports when there is nothing to commit", async () => {
    const pi = createPi();
    const ui = { setWorkingMessage: vi.fn() };
    const result = await runCommit(pi as any, ui);
    expect(result).toEqual({ ok: true, committed: false });
    expect(pi.exec).toHaveBeenCalledWith("git", ["status", "--porcelain"]);
    expect(pi.exec).not.toHaveBeenCalledWith("git", ["add", "-A"]);
  });

  it("stages all changes and commits with a message derived from the changed files", async () => {
    const pi = createPi(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M src/a.ts\n", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 0, stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const ui = { setWorkingMessage: vi.fn() };
    const result = await runCommit(pi as any, ui);
    expect(result).toEqual({ ok: true, committed: true });
    expect(pi.exec).toHaveBeenCalledWith("git", ["add", "-A"]);
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "Update src/a.ts, src/b.ts"]);
  });

  it("summarizes many files in the commit message", async () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`).join("\n") + "\n";
    const pi = createPi(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 0, stdout: files, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const ui = { setWorkingMessage: vi.fn() };
    await runCommit(pi as any, ui);
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "Update src/file0.ts, src/file1.ts, src/file2.ts, src/file3.ts, src/file4.ts and 5 more"]);
  });

  it("uses the provided message for the commit", async () => {
    const pi = createPi(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 0, stdout: "x\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await runCommit(pi as any, { setWorkingMessage: vi.fn() }, "NEW: add the thing");
    expect(result).toEqual({ ok: true, committed: true });
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "NEW: add the thing"]);
  });

  it("trims the provided message", async () => {
    const pi = createPi(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 0, stdout: "x\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    await runCommit(pi as any, { setWorkingMessage: vi.fn() }, "  FIX: the bug  ");
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "FIX: the bug"]);
  });

  it("falls back to the generated message when the provided message is empty", async () => {
    const pi = createPi(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 0, stdout: "x\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    await runCommit(pi as any, { setWorkingMessage: vi.fn() }, "   ");
    expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "Update x"]);
  });

  it("reports a failed git status", async () => {
    const pi = createPi(async () => ({ code: 1, stdout: "", stderr: "boom" }));
    const result = await runCommit(pi as any, { setWorkingMessage: vi.fn() });
    expect(result).toEqual({ ok: false, reason: "failed", stderr: "boom", stdout: "" });
  });

  it("reports a failed git add", async () => {
    const pi = createPi(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "boom" };
    });
    const result = await runCommit(pi as any, { setWorkingMessage: vi.fn() });
    expect(result).toEqual({ ok: false, reason: "failed", stderr: "boom", stdout: "" });
  });

  it("reports a failed commit", async () => {
    const pi = createPi(async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "status") return { code: 0, stdout: " M x\n", stderr: "" };
      if (cmd === "git" && args[0] === "add") return { code: 0, stdout: "", stderr: "" };
      if (cmd === "git" && args[0] === "diff") return { code: 0, stdout: "x\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "boom" };
    });
    const result = await runCommit(pi as any, { setWorkingMessage: vi.fn() });
    expect(result).toEqual({ ok: false, reason: "failed", stderr: "boom", stdout: "" });
  });

  it("reports when git throws", async () => {
    const pi = createPi(async () => {
      throw new Error("boom");
    });
    const result = await runCommit(pi as any, { setWorkingMessage: vi.fn() });
    expect(result).toEqual({ ok: false, reason: "failed", stderr: "boom", stdout: "" });
  });

  it("clears the working message", async () => {
    const pi = createPi();
    const ui = { setWorkingMessage: vi.fn() };
    await runCommit(pi as any, ui);
    expect(ui.setWorkingMessage).toHaveBeenLastCalledWith();
  });
});

describe("commitFailureMessage", () => {
  it("reports failures with stderr", () => {
    expect(commitFailureMessage({ ok: false, reason: "failed", stderr: "boom", stdout: "" })).toBe("Commit failed: boom");
  });

  it("falls back to stdout when stderr is empty", () => {
    expect(commitFailureMessage({ ok: false, reason: "failed", stderr: "", stdout: "boom" })).toBe("Commit failed: boom");
  });

  it("reports when there is no error output", () => {
    expect(commitFailureMessage({ ok: false, reason: "failed", stderr: "", stdout: "" })).toBe("Commit failed with no error output");
  });
});
