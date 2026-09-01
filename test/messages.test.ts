import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const MESSAGES = {
  "1": "Test message one",
  "2": "Test message two with longer content",
};
const COMMANDS = { "1": "git add ." };

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  Type: {},
}));

vi.mock("@earendil-works/pi-tui", () => ({}));

describe("messages extension", () => {
  let extension: any;
  let pi: any;
  let capturedCommands: any[];

  beforeEach(async () => {
    capturedCommands = [];
    pi = {
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, cmd: any) => {
        capturedCommands.push({ name, cmd });
      }),
      sendUserMessage: vi.fn(),
      exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
    };

    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((path: unknown) => {
      if (String(path).includes("defaults.json")) return JSON.stringify({ "messages.json": "recorded", "commands.json": "recorded" });
      if (String(path).includes("commands.json")) return JSON.stringify(COMMANDS);
      return JSON.stringify(MESSAGES);
    });
    const mod = await import("../index.js");
    extension = mod.default;
    extension(pi);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("command registrations", () => {
    it("registers /msg command", () => {
      const cmd = capturedCommands.find((c: any) => c.name === "msg");
      expect(cmd).toBeDefined();
    });

    it("registers /show-msg command", () => {
      const cmd = capturedCommands.find((c: any) => c.name === "show-msg");
      expect(cmd).toBeDefined();
    });
  });

  describe("/msg command", () => {
    it("sends a predefined message by number", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "msg");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("1", ctx);

      expect(pi.sendUserMessage).toHaveBeenCalledWith("Test message one", { deliverAs: "followUp" });
      expect(ctx.ui.notify).toHaveBeenCalledWith("Message 1 sent", "info");
    });

    it("shows warning for non-existent message", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "msg");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("99", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Message 99 does not exist. Use /workflow-edit to create it in the Messages tab.",
        "warning",
      );
    });

    it("shows warning when no number provided", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "msg");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /msg <number>", "warning");
    });

    it("requires interactive mode", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "msg");
      const ctx = { hasUI: false, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("1", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("/msg requires interactive mode", "error");
    });
  });

  describe("/show-msg command", () => {
    it("displays a specific message", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "show-msg");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("1", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Message 1: Test message one", "info");
    });

    it("shows warning for non-existent message", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "show-msg");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("99", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Message 99 does not exist.", "warning");
    });

    it("lists all messages when no number given", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "show-msg");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Messages:"),
        "info",
      );
    });

    it("shows info when no messages defined", async () => {
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({}));
      const cmd = capturedCommands.find((c: any) => c.name === "show-msg");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("No messages defined.", "info");
    });
  });

  describe("autocomplete", () => {
    it("provides completions for message numbers", () => {
      const cmd = capturedCommands.find((c: any) => c.name === "msg");
      const completions = cmd.cmd.getArgumentCompletions("1");

      expect(completions).toHaveLength(1);
      expect(completions[0]!.value).toBe("1");
    });

    it("returns empty array for non-matching prefix", () => {
      const cmd = capturedCommands.find((c: any) => c.name === "msg");
      const completions = cmd.cmd.getArgumentCompletions("9");

      expect(completions).toEqual([]);
    });
  });
  describe("cmd command family", () => {
    it("registers /cmd and /show-cmd", () => {
      expect(capturedCommands.some((c: any) => c.name === "cmd")).toBe(true);
      expect(capturedCommands.some((c: any) => c.name === "show-cmd")).toBe(true);
    });

    it("performs a predefined command by number", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };

      await cmd.cmd.handler("1", ctx);

      expect(pi.exec).toHaveBeenCalledWith("git", ["add", "."]);
      expect(pi.sendUserMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 executed", "info");
    });

    it("reports a failed command", async () => {
      pi.exec = vi.fn(async () => ({ code: 1, stdout: "", stderr: "boom" }));
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };

      await cmd.cmd.handler("1", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 failed: boom", "error");
    });

    it("reports a command that throws during execution", async () => {
      pi.exec = vi.fn(async () => {
        throw new Error("boom");
      });
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };
      await cmd.cmd.handler("1", ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 failed: boom", "error");
    });

    it("splits quoted arguments correctly", async () => {
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git commit -m \"my message\"" });
        return JSON.stringify(MESSAGES);
      });
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };
      await cmd.cmd.handler("1", ctx);
      expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", "my message"]);
    });

    it("preserves empty quoted arguments", async () => {
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git commit -m \"\"" });
        return JSON.stringify(MESSAGES);
      });
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };
      await cmd.cmd.handler("1", ctx);
      expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", ""]);
    });

    it("supports escaped quotes inside double-quoted arguments", async () => {
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git commit -m \"say \\\"hi\\\"\"" });
        return JSON.stringify(MESSAGES);
      });
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };
      await cmd.cmd.handler("1", ctx);
      expect(pi.exec).toHaveBeenCalledWith("git", ["commit", "-m", 'say "hi"']);
    });

    it("rejects a command with an unterminated quote", async () => {
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).includes("commands.json")) return JSON.stringify({ "1": "git commit -m \"my message" });
        return JSON.stringify(MESSAGES);
      });
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };
      await cmd.cmd.handler("1", ctx);
      expect(pi.exec).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 has an unterminated quote.", "warning");
    });

    it("does not set a working message for an empty command", async () => {
      vi.mocked(readFileSync).mockImplementation((path: unknown) => {
        if (String(path).includes("commands.json")) return JSON.stringify({ "1": "   " });
        return JSON.stringify(MESSAGES);
      });
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };
      await cmd.cmd.handler("1", ctx);
      expect(ctx.ui.setWorkingMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1 is empty.", "warning");
    });

    it("sets a working message while executing", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn(), setWorkingMessage: vi.fn() } };
      await cmd.cmd.handler("1", ctx);
      expect(ctx.ui.setWorkingMessage).toHaveBeenCalledWith(expect.stringContaining("git add ."));
      expect(ctx.ui.setWorkingMessage).toHaveBeenLastCalledWith();
    });

    it("points to the editor when the command does not exist", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("99", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        "Command 99 does not exist. Use /workflow-edit to create it in the Commands tab.",
        "warning",
      );
    });

    it("shows usage with the command name", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /cmd <number>", "warning");
    });

    it("requires interactive mode", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const ctx = { hasUI: false, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("1", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("/cmd requires interactive mode", "error");
    });

    it("displays a specific command via /show-cmd", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "show-cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("1", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith("Command 1: git add .", "info");
    });

    it("lists all commands when no number given", async () => {
      const cmd = capturedCommands.find((c: any) => c.name === "show-cmd");
      const ctx = { hasUI: true, ui: { notify: vi.fn() } };

      await cmd.cmd.handler("", ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Commands:"), "info");
    });

    it("provides completions for /cmd", () => {
      const cmd = capturedCommands.find((c: any) => c.name === "cmd");
      const completions = cmd.cmd.getArgumentCompletions("1");

      expect(completions).toHaveLength(1);
      expect(completions[0]!.value).toBe("1");
    });
  });
});
