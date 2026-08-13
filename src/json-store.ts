import { ensureUserData, ensureUserDataDir, userDataPath } from "./user-data.js";
import { compareNumericKeys, readJsonObject, writeJsonAtomic } from "./json-file.js";

export function createJsonStore(fileName: string): {
  get(): Record<string, string>;
  set(store: Record<string, string>): void;
} {
  const file = userDataPath(fileName);
  return {
    get() {
      ensureUserData(fileName);
      const parsed = readJsonObject(file, (err) => console.error(`Failed to read ${fileName}:`, err));
      if (parsed === null) return {};
      return Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => typeof value === "string"),
      ) as Record<string, string>;
    },
    set(store) {
      ensureUserDataDir();
      const sorted = Object.fromEntries(
        Object.entries(store).sort(([a], [b]) => compareNumericKeys(a, b)),
      );
      writeJsonAtomic(file, sorted);
    },
  };
}
