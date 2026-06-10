import { useState } from "react";
import { searchEmoji } from "../../lib/emoji";

export function EmojiPicker({
  onPick,
  onRemove,
  close,
}: {
  onPick: (emoji: string) => void;
  onRemove?: () => void;
  close: () => void;
}) {
  const [q, setQ] = useState("");
  const results = searchEmoji(q);
  return (
    <div className="w-72 p-2">
      <div className="mb-2 flex items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search icons…"
          className="w-full rounded-md border border-border bg-surface px-2 py-1 text-[13px] outline-none focus:border-accent"
        />
        {onRemove && (
          <button
            onClick={() => {
              onRemove();
              close();
            }}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] text-ink-2 hover:bg-hov"
          >
            Remove
          </button>
        )}
      </div>
      <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-auto">
        {results.map(([emoji, name]) => (
          <button
            key={emoji + name}
            title={name}
            onClick={() => {
              onPick(emoji);
              close();
            }}
            className="rounded-md p-1 text-[18px] leading-none hover:bg-hov"
          >
            {emoji}
          </button>
        ))}
        {results.length === 0 && (
          <div className="col-span-8 py-6 text-center text-[12px] text-ink-3">No matches</div>
        )}
      </div>
    </div>
  );
}
