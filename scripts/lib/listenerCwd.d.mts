// WHAT: types for listenerCwd, so tests/ can import it.
export function listenerCwd(
  port: number,
  options?: { platform?: string; run?: (cmd: string, args: string[]) => { status: number | null; stdout: string } }
): string | null;
