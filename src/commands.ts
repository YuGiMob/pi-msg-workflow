import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMANDS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "commands.json");

export function getCommands(): Record<string, string> {
  if (!existsSync(COMMANDS_FILE)) return {};
  try {
    const content = readFileSync(COMMANDS_FILE, "utf-8").trim();
    return JSON.parse(content);
  } catch (err) {
    console.error("Failed to read commands:", err);
    return {};
  }
}

export function setCommands(commands: Record<string, string>): void {
  writeFileSync(COMMANDS_FILE, JSON.stringify(commands, null, 2), "utf-8");
}
