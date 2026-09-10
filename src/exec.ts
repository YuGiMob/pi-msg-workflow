import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
export function execWithSignal(pi: ExtensionAPI, cmd: string, args: string[], signal?: AbortSignal | null): Promise<ExecResult> {
  if (signal === undefined || signal === null) return pi.exec(cmd, args);
  return pi.exec(cmd, args, { signal });
}
