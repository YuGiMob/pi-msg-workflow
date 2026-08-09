import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { ensureUserData, ensureUserDataDir, userDataPath } from "./user-data.js";

export function createJsonStore(fileName: string): {
  get(): Record<string, string>;
  set(store: Record<string, string>): void;
} {
  const file = userDataPath(fileName);
  return {
    get() {
      ensureUserData(fileName);
      if (!existsSync(file)) return {};
      try {
        return JSON.parse(readFileSync(file, "utf-8").trim());
      } catch (err) {
        console.error(`Failed to read ${fileName}:`, err);
        return {};
      }
    },
    set(store) {
      ensureUserDataDir();
      const sorted = Object.fromEntries(
        Object.entries(store).sort(([a], [b]) => {
          const na = Number(a);
          const nb = Number(b);
          if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
          if (Number.isNaN(na)) return 1;
          if (Number.isNaN(nb)) return -1;
          return na - nb;
        }),
      );
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(sorted, null, 2), "utf-8");
      renameSync(tmp, file);
    },
  };
}
