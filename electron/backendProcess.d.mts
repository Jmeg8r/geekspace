// WHAT: types for the backend process lifecycle, so tests/ can import it (see meetingProcessor.d.mts).
import type { ChildProcess } from "node:child_process";

export interface Backend {
  child: ChildProcess | null;
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null;
}

export function spawnBackend(
  bin: string,
  args: string[],
  options: { cwd: string; log: (msg: string) => void; output: (chunk: Buffer) => void }
): Backend;

export function waitHealthy(
  backend: Backend,
  options: { isHealthy: () => Promise<boolean>; logPath: string; deadlineMs?: number; intervalMs?: number }
): Promise<void>;

export function stopBackendProcess(backend: Backend, log: (msg: string) => void): Promise<void>;

export function killBackendProcessSync(backend: Backend): void;
