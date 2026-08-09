import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
  existsSync: vi.fn(),
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { createJsonStore } from "../src/json-store.js";

describe("createJsonStore", () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty store when the file is missing", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const store = createJsonStore("messages.json");
    expect(store.get()).toEqual({});
  });

  it("returns an empty store when the file is not valid JSON", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readFileSync).mockReturnValue("not json" as never);
    const store = createJsonStore("messages.json");
    expect(store.get()).toEqual({});
    spy.mockRestore();
  });
  it("returns an empty store when the file is valid JSON but not an object", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify([1, 2, 3]) as never);
    const store = createJsonStore("messages.json");
    expect(store.get()).toEqual({});
  });

  it("reads the store from the package root", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ "1": "hello" }) as never);
    const store = createJsonStore("messages.json");
    expect(store.get()).toEqual({ "1": "hello" });
    expect(readFileSync).toHaveBeenCalledWith(expect.stringContaining("messages.json"), "utf-8");
  });

  it("writes atomically via a tmp file and rename", () => {
    const store = createJsonStore("messages.json");
    store.set({ "1": "hello" });
    expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining("messages.json.tmp"), expect.any(String), "utf-8");
    expect(renameSync).toHaveBeenCalledWith(expect.stringContaining("messages.json.tmp"), expect.stringContaining("messages.json"));
  });

  it("sorts keys numerically on write", () => {
    const store = createJsonStore("messages.json");
    store.set({ "2": "second", "10": "tenth", "1": "first" });
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(Object.keys(written)).toEqual(["1", "2", "10"]);
  });

  it("places non-numeric keys after numeric ones on write", () => {
    const store = createJsonStore("messages.json");
    store.set({ "2": "second", "abc": "other", "1": "first" });
    const written = JSON.parse((writeFileSync as any).mock.calls[0]![1]);
    expect(Object.keys(written)).toEqual(["1", "2", "abc"]);
  });
});
