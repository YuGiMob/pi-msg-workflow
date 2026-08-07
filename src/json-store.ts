import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function createJsonStore(fileName: string): {
  get(): Record<string, string>;
  set(store: Record<string, string>): void;
} {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", fileName);
  return {
    get() {
      if (!existsSync(file)) return {};
      try {
        return JSON.parse(readFileSync(file, "utf-8").trim());
      } catch (err) {
        console.error(`Failed to read ${fileName}:`, err);
        return {};
      }
    },
    set(store) {
      const sorted = Object.fromEntries(Object.entries(store).sort(([a], [b]) => Number(a) - Number(b)));
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(sorted, null, 2), "utf-8");
      renameSync(tmp, file);
    },
  };
}
