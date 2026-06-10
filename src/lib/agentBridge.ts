// WHAT: Typed renderer wrapper for the ARCHITECT agent IPC bridge (ClaudeClaw).

export type AgentState = "online" | "offline" | "no-token" | "error";

export interface AgentEvent {
  type: "token" | "done" | "error" | string;
  text?: string;
  message?: string;
  chatId?: string;
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface AgentBridge {
  status(): Promise<IpcResult<{ state: AgentState }>>;
  chat(message: string): Promise<IpcResult<boolean>>;
  reset(): Promise<IpcResult<boolean>>;
  onEvent(cb: (e: AgentEvent) => void): () => void;
}

function bridge(): AgentBridge | undefined {
  return (window as { geekspace?: { agent?: AgentBridge } }).geekspace?.agent;
}

export const agentAvailable = (): boolean => Boolean(bridge());

async function call<T>(fn: (b: AgentBridge) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const b = bridge();
  if (!b) return { ok: false, error: "The agent needs the desktop app" };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

export const agentStatus = () => call((b) => b.status());
export const agentChat = (message: string) => call((b) => b.chat(message));
export const agentReset = () => call((b) => b.reset());
export const onAgentEvent = (cb: (e: AgentEvent) => void): (() => void) => {
  const b = bridge();
  if (!b) return () => {};
  return b.onEvent(cb);
};
