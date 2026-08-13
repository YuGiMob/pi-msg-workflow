import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function readJsonFile(file: string): unknown | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

export function readJsonObject(
  file: string,
  onError?: (err: unknown) => void,
): Record<string, unknown> | null {
  try {
    const parsed = readJsonFile(file);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (err) {
    onError?.(err);
    return null;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, file);
}

export function compareNumericKeys(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isNaN(na) && Number.isNaN(nb)) return a.localeCompare(b);
  if (Number.isNaN(na)) return 1;
  if (Number.isNaN(nb)) return -1;
  return na - nb;
}
