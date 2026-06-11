import { useEffect, useRef, useState } from "react";
import { Bot, Cpu, Loader2, RotateCcw, Send, Sparkles, X } from "lucide-react";
import { useUI } from "../../state/ui";
import { cn } from "../../lib/utils";
import {
  agentChat,
  agentReset,
  agentStatus,
  onAgentEvent,
  type AgentMode,
  type AgentState,
  type LocalLaneStatus,
} from "../../lib/agentBridge";

interface Msg {
  role: "user" | "assistant";
  text: string;
}

// WHAT: Chat panel for ARCHITECT — the embedded agent that designs, creates,
// and configures this workspace via the geekspace MCP server. Two lanes share
// the same tools: Local (Ollama, free, default) and Claude (Agent SDK — bills
// the post-2026-06-15 credit pool, reserve it for complex design work).
export function AgentPanel() {
  const open = useUI((s) => s.agentPanelOpen);
  const setOpen = useUI((s) => s.setAgentPanelOpen);
  const [state, setState] = useState<AgentState | "checking">("checking");
  const [local, setLocal] = useState<LocalLaneStatus | undefined>(undefined);
  const [mode, setMode] = useState<AgentMode>("local");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setState("checking");
    void agentStatus().then((r) => {
      if (!r.ok) {
        setState("offline");
        setLocal(undefined);
        return;
      }
      setState(r.data.state);
      setLocal(r.data.local);
      // Default to the free lane when it's up; fall back to Claude when not.
      if (r.data.local?.available === false && r.data.state === "online") setMode("claude");
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    return onAgentEvent((e) => {
      const chunk =
        e.type === "token"
          ? e.text
          : e.type === "tool"
            ? `\n⚙ ${e.text}…\n`
            : undefined;
      if (chunk) {
        setMessages((m) => {
          const last = m[m.length - 1];
          if (last?.role === "assistant") {
            return [...m.slice(0, -1), { ...last, text: last.text + chunk }];
          }
          return [...m, { role: "assistant", text: chunk }];
        });
      }
    });
  }, [open]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming]);

  if (!open) return null;

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", text: "" }]);
    setStreaming(true);
    const result = await agentChat(text, mode);
    setStreaming(false);
    if (!result.ok) {
      setMessages((m) => {
        const last = m[m.length - 1];
        const errText = `⚠️ ${result.error}`;
        if (last?.role === "assistant" && last.text === "") {
          return [...m.slice(0, -1), { role: "assistant", text: errText }];
        }
        return [...m, { role: "assistant", text: errText }];
      });
    }
  }

  // Per-lane availability: the toggle picks the brain, the tools are shared.
  const checking = state === "checking";
  const laneReady = mode === "local" ? local?.available === true : state === "online";
  const offline = !checking && !laneReady;
  const laneLabel =
    mode === "local"
      ? local?.available
        ? `Local · ${local.model ?? "Ollama"}`
        : "Ollama unavailable"
      : state === "online"
        ? "Claude · Agent SDK (credit pool)"
        : state === "no-auth"
          ? "Claude sign-in needed"
          : "Agent unavailable";

  return (
    <aside
      className="fade-in flex h-full w-[400px] shrink-0 flex-col border-l border-border bg-surface"
      style={{ boxShadow: "var(--shadow)" }}
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent-soft">
          <Bot size={16} className="text-accent" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-bold leading-tight">ARCHITECT</div>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                checking
                  ? "bg-[var(--pal-yellow)]"
                  : laneReady
                    ? "bg-[var(--pal-green)]"
                    : "bg-[var(--pal-red)]"
              )}
            />
            {checking ? "Checking…" : laneLabel}
          </div>
        </div>
        <div
          className="flex items-center rounded-lg border border-border p-0.5"
          title="Local runs free on Ollama. Claude bills the Agent SDK credit pool — use it for complex design work."
        >
          {(
            [
              { value: "local" as const, icon: Cpu, label: "Local" },
              { value: "claude" as const, icon: Sparkles, label: "Claude" },
            ]
          ).map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              onClick={() => setMode(value)}
              disabled={streaming}
              className={cn(
                "flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold",
                mode === value ? "bg-accent text-white" : "text-ink-3 hover:text-ink"
              )}
            >
              <Icon size={11} />
              {label}
            </button>
          ))}
        </div>
        <button
          title="Reset conversation"
          onClick={() => {
            setMessages([]);
            void agentReset();
          }}
          className="rounded-md p-1.5 text-ink-3 hover:bg-hov hover:text-ink"
        >
          <RotateCcw size={14} />
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md p-1.5 text-ink-3 hover:bg-hov hover:text-ink"
        >
          <X size={15} />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && (
          <div className="px-2 pt-8 text-center">
            <Bot size={26} className="mx-auto text-ink-3" />
            <p className="pt-2 text-[13px] font-medium">Your workspace expert</p>
            <p className="pt-1 text-[12px] leading-relaxed text-ink-3">
              Ask it to design databases, set up projects, restructure pages, or explain your
              schedule. It works through the workspace itself — changes appear live.
            </p>
            <div className="flex flex-col gap-1.5 pt-4">
              {[
                "Set up a database to track podcast guests",
                "What's overdue and what should I do about it?",
                "Create a project for next week's article with a task chain",
              ].map((s) => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-left text-[12px] text-ink-2 hover:bg-hov hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={cn("pb-3", m.role === "user" && "flex justify-end")}>
            <div
              className={cn(
                "max-w-[88%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[13px] leading-relaxed",
                m.role === "user"
                  ? "bg-accent text-white"
                  : "border border-border bg-raised"
              )}
            >
              {m.text || (streaming && i === messages.length - 1 ? (
                <Loader2 size={14} className="animate-spin text-ink-3" />
              ) : (
                ""
              ))}
            </div>
          </div>
        ))}
      </div>

      <footer className="border-t border-border p-3">
        {offline ? (
          <p className="px-1 text-[12px] leading-relaxed text-ink-3">
            {mode === "local"
              ? local?.error?.includes("models")
                ? "Ollama is running but has no usable models — pull one (e.g. ollama pull qwen3-coder:30b)."
                : "Ollama isn't reachable — start it, or switch to the Claude lane."
              : state === "no-auth"
                ? "Sign in to Claude Code on this Mac (run `claude` once), then reopen this panel."
                : "The agent is unavailable — make sure the app launched via npm run dev."}
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={Math.min(4, Math.max(1, input.split("\n").length))}
              placeholder="Ask ARCHITECT…"
              className="max-h-28 flex-1 resize-none rounded-lg border border-border bg-bg px-2.5 py-2 text-[13px] outline-none focus:border-accent"
            />
            <button
              disabled={!input.trim() || streaming}
              onClick={() => void send()}
              className="rounded-lg bg-accent p-2 text-white hover:bg-accent-2 disabled:opacity-50"
            >
              {streaming ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </div>
        )}
        <p className="px-1 pt-1.5 text-[10.5px] text-ink-3">
          {mode === "local"
            ? "Runs free on local Ollama · workspace tools only, no deletes"
            : "Claude Agent SDK — bills the credit pool · workspace tools only, no deletes"}
        </p>
      </footer>
    </aside>
  );
}
