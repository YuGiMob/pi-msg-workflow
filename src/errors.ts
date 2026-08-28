export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function execFailureMessage(prefix: string, stderr: string, stdout: string): string {
  if (stderr.trim() !== "") return `${prefix}: ${stderr}`;
  if (stdout.trim() !== "") return `${prefix}: ${stdout}`;
  return `${prefix} with no error output`;
}
