import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "./errors.js";
import { readJsonObject, writeJsonAtomic } from "./json-file.js";
import { DEFAULTS_FILE } from "./constants.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  return (readJsonObject(userDataPath(DEFAULTS_FILE), (err) => console.error(`Failed to read ${DEFAULTS_FILE}: ${errorMessage(err)}`)) ?? {}) as Record<string, string>;
}

function setDefaultChecksum(fileName: string, checksum: string): void {
  const defaults = readDefaults();
  defaults[fileName] = checksum;
  writeJsonAtomic(userDataPath(DEFAULTS_FILE), defaults);
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
    console.error(`Failed to sync user data for ${fileName}: ${errorMessage(err)}`);
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
    console.error(`Failed to reset user data for ${fileName}: ${errorMessage(err)}`);
    return false;
  }
}
