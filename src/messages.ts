import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MESSAGES_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "messages.json");

export function getMessages(): Record<string, string> {
  if (!existsSync(MESSAGES_FILE)) return {};
  try {
    const content = readFileSync(MESSAGES_FILE, "utf-8").trim();
    return JSON.parse(content);
  } catch (err) {
    console.error("Failed to read messages:", err);
    return {};
  }
}

export function setMessages(messages: Record<string, string>): void {
  writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2), "utf-8");
}
