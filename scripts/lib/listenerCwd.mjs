// WHAT: the working directory of the process listening on a local TCP port, or null when
// it can't be determined.
// WHY: deploy:local stamps its checkout's ordinal on the packaged data dir, which is only
// true when the packaged backend (spawned with that dir as cwd) is the one it deployed to.
// `convex dev` can hold the port while the packaged config exists (Codex, PR #67 round 1).
// mac only: Windows has no shell-free way to read another process's cwd, so it returns
// null there and the caller falls back to forgetting the marker.
import { spawnSync } from "node:child_process";

const defaultRun = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

export function listenerCwd(port, { platform = process.platform, run = defaultRun } = {}) {
  if (platform !== "darwin") return null;
  const listeners = run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pids = listeners.status === 0 ? listeners.stdout.split("\n").filter((line) => /^\d+$/.test(line.trim())) : [];
  // Zero: nothing to attribute the deploy to. Several: can't tell which one took it.
  if (pids.length !== 1) return null;
  const cwd = run("lsof", ["-a", "-p", pids[0].trim(), "-d", "cwd", "-Fn"]);
  if (cwd.status !== 0) return null;
  // -Fn prints one field per line; the cwd's name is the line starting with "n".
  const name = cwd.stdout.split("\n").find((line) => line.startsWith("n"));
  return name ? name.slice(1) : null;
}
