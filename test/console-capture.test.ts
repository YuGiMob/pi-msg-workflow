import { describe, expect, it, vi, afterEach } from "vitest";
import { captureConsoleMessages } from "../src/console-capture.js";

describe("captureConsoleMessages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards error and warn output to the original console", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = captureConsoleMessages(() => {});
    console.error("boom", new Error("x"));
    console.warn("careful");
    expect(errorSpy).toHaveBeenCalledWith("boom", expect.any(Error));
    expect(warnSpy).toHaveBeenCalledWith("careful");
    stop();
  });

  it("reports console.error messages to the listener", () => {
    const messages: string[] = [];
    const stop = captureConsoleMessages((text) => messages.push(text));
    console.error("Failed to read messages.json:", new Error("disk full"));
    expect(messages).toEqual(["Failed to read messages.json: Error: disk full"]);
    stop();
  });

  it("reports console.warn messages to the listener", () => {
    const messages: string[] = [];
    const stop = captureConsoleMessages((text) => messages.push(text));
    console.warn("warning text");
    expect(messages).toEqual(["warning text"]);
    stop();
  });

  it("leaves console.log untouched", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const messages: string[] = [];
    const stop = captureConsoleMessages((text) => messages.push(text));
    console.log("not captured");
    expect(messages).toEqual([]);
    expect(logSpy).toHaveBeenCalledWith("not captured");
    stop();
  });

  it("serializes non-string arguments", () => {
    const messages: string[] = [];
    const stop = captureConsoleMessages((text) => messages.push(text));
    console.error({ code: 1 });
    console.error(42);
    expect(messages).toEqual(['{"code":1}', "42"]);
    stop();
  });

  it("does not report empty output", () => {
    const messages: string[] = [];
    const stop = captureConsoleMessages((text) => messages.push(text));
    console.error("");
    console.warn();
    expect(messages).toEqual([]);
    stop();
  });

  it("restores the original console methods when stopped", () => {
    const originalError = console.error;
    const originalWarn = console.warn;
    const stop = captureConsoleMessages(() => {});
    expect(console.error).not.toBe(originalError);
    expect(console.warn).not.toBe(originalWarn);
    stop();
    expect(console.error).toBe(originalError);
    expect(console.warn).toBe(originalWarn);
  });
});
