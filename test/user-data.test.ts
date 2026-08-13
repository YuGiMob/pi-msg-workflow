import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { ensureUserData, resetUserData, userDataDir, userDataPath } from "../src/user-data.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("user-data", () => {
  const files = new Map<string, string>();

  function addUserFile(fileName: string, content: string): void {
    files.set(userDataPath(fileName), content);
  }

  function addPackageFile(fileName: string, content: string): void {
    files.set(join(PACKAGE_ROOT, fileName), content);
  }

  function addDefaults(entries: Record<string, string>): void {
    files.set(userDataPath("defaults.json"), JSON.stringify(entries));
  }

  beforeEach(() => {
    files.clear();
    vi.mocked(existsSync).mockImplementation((path: unknown) => files.has(String(path)));
    vi.mocked(readFileSync).mockImplementation((path: unknown) => files.get(String(path)) ?? "");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves user files under the config directory", () => {
    expect(userDataDir()).toContain("pi-msg-workflow");
    expect(userDataPath("workflow.json")).toContain("pi-msg-workflow");
    expect(userDataPath("workflow.json")).toContain("workflow.json");
  });

  it("copies the packaged default and records its checksum when the user file is missing", () => {
    addPackageFile("workflow.json", "default");
    ensureUserData("workflow.json");
    expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining("pi-msg-workflow"), { recursive: true });
    expect(copyFileSync).toHaveBeenCalledWith(join(PACKAGE_ROOT, "workflow.json"), userDataPath("workflow.json"));
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("defaults.json.tmp"),
      expect.stringContaining(sha256("default")),
      "utf-8",
    );
  });

  it("records the checksum when the user file matches the packaged default", () => {
    addPackageFile("workflow.json", "default");
    addUserFile("workflow.json", "default");
    ensureUserData("workflow.json");
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("defaults.json.tmp"),
      expect.stringContaining(sha256("default")),
      "utf-8",
    );
  });

  it("leaves a customized user file alone without recording", () => {
    addPackageFile("workflow.json", "default");
    addUserFile("workflow.json", "customized");
    ensureUserData("workflow.json");
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("replaces an unmodified user file when the packaged default changes", () => {
    addPackageFile("workflow.json", "new default");
    addUserFile("workflow.json", "old default");
    addDefaults({ "workflow.json": sha256("old default") });
    ensureUserData("workflow.json");
    expect(copyFileSync).toHaveBeenCalledWith(join(PACKAGE_ROOT, "workflow.json"), userDataPath("workflow.json"));
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("defaults.json.tmp"),
      expect.stringContaining(sha256("new default")),
      "utf-8",
    );
  });

  it("keeps an unmodified user file when the packaged default is unchanged", () => {
    addPackageFile("workflow.json", "default");
    addUserFile("workflow.json", "default");
    addDefaults({ "workflow.json": sha256("default") });
    ensureUserData("workflow.json");
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("keeps a customized user file when the packaged default changes", () => {
    addPackageFile("workflow.json", "new default");
    addUserFile("workflow.json", "my custom workflow");
    addDefaults({ "workflow.json": sha256("old default") });
    ensureUserData("workflow.json");
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does nothing when the packaged default is missing", () => {
    addUserFile("workflow.json", "customized");
    ensureUserData("workflow.json");
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("resetUserData copies the packaged default and records its checksum", () => {
    addPackageFile("workflow.json", "default");
    addUserFile("workflow.json", "customized");
    expect(resetUserData("workflow.json")).toBe(true);
    expect(copyFileSync).toHaveBeenCalledWith(join(PACKAGE_ROOT, "workflow.json"), userDataPath("workflow.json"));
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("defaults.json.tmp"),
      expect.stringContaining(sha256("default")),
      "utf-8",
    );
  });

  it("resetUserData reports failure when the packaged default is missing", () => {
    addUserFile("workflow.json", "customized");
    expect(resetUserData("workflow.json")).toBe(false);
    expect(copyFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });
});
