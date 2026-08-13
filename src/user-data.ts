import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULTS_FILE = "defaults.json";

function homeBase(): string {
  const envHome = process.env.HOME;
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export function userDataDir(): string {
  return join(homeBase(), ".config", "pi-msg-workflow");
}

export function userDataPath(fileName: string): string {
  return join(userDataDir(), fileName);
}

export function ensureUserDataDir(): void {
  mkdirSync(userDataDir(), { recursive: true });
}
function checksumFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function readDefaults(): Record<string, string> {
  const file = userDataPath(DEFAULTS_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function setDefaultChecksum(fileName: string, checksum: string): void {
  const defaults = readDefaults();
  defaults[fileName] = checksum;
  const file = userDataPath(DEFAULTS_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(defaults, null, 2), "utf-8");
  renameSync(tmp, file);
}

export function ensureUserData(fileName: string): void {
  try {
    const userFile = userDataPath(fileName);
    const packageFile = join(PACKAGE_ROOT, fileName);
    if (!existsSync(packageFile)) return;
    const packageChecksum = checksumFile(packageFile);
    if (!existsSync(userFile)) {
      mkdirSync(userDataDir(), { recursive: true });
      copyFileSync(packageFile, userFile);
      setDefaultChecksum(fileName, packageChecksum);
      return;
    }
    const recorded = readDefaults()[fileName];
    if (recorded === undefined) {
      if (checksumFile(userFile) === packageChecksum) {
        setDefaultChecksum(fileName, packageChecksum);
      }
      return;
    }
    if (checksumFile(userFile) === recorded && recorded !== packageChecksum) {
      copyFileSync(packageFile, userFile);
      setDefaultChecksum(fileName, packageChecksum);
    }
  } catch (err) {
    console.error(`Failed to sync user data for ${fileName}:`, err);
  }
}

export function resetUserData(fileName: string): boolean {
  try {
    const packageFile = join(PACKAGE_ROOT, fileName);
    if (!existsSync(packageFile)) return false;
    mkdirSync(userDataDir(), { recursive: true });
    copyFileSync(packageFile, userDataPath(fileName));
    setDefaultChecksum(fileName, checksumFile(packageFile));
    return true;
  } catch (err) {
    console.error(`Failed to reset user data for ${fileName}:`, err);
    return false;
  }
}
