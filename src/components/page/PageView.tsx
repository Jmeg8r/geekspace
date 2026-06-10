import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { MoreHorizontal, Star, Trash2 } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { useUI } from "../../state/ui";
import { cn, debounce } from "../../lib/utils";
import { Popover } from "../common/Popover";
import { MenuItem, MenuList } from "../common/Menu";
import { EmojiPicker } from "../common/EmojiPicker";
import { Editor } from "./Editor";
import { DatabaseContainer } from "../database/DatabaseContainer";

export function PageView({ pageId }: { pageId: Id<"pages"> }) {
  const page = useQuery(api.pages.get, { pageId });
  const setContent = useMutation(api.pages.setContent);

  if (page === undefined) {
    return <div className="flex h-full items-center justify-center text-ink-3">Loading…</div>;
  }
  if (page === null || page.trashed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
        <span className="text-3xl">🗑️</span>
        <p className="text-[14px]">This page is gone — check the trash.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <PageHeader page={page} />
      {page.kind === "doc" ? (
        <div className="mx-auto w-full max-w-3xl flex-1 px-14 pb-40">
          <Editor
            key={page._id}
            initialJson={page.content}
            onSave={(json) => void setContent({ pageId: page._id, content: json })}
          />
        </div>
      ) : page.databaseId ? (
        <DatabaseContainer key={page.databaseId} databaseId={page.databaseId} />
      ) : null}
    </div>
  );
}

function PageHeader({ page }: { page: Doc<"pages"> }) {
  const update = useMutation(api.pages.update);
  const toggleFavorite = useMutation(api.pages.toggleFavorite);
  const trash = useMutation(api.pages.trash);
  const navigate = useUI((s) => s.navigate);

  const [title, setTitle] = useState(page.title);
  const pageIdRef = useRef(page._id);
  useEffect(() => {
    if (pageIdRef.current !== page._id) {
      pageIdRef.current = page._id;
      setTitle(page.title);
    }
  }, [page._id, page.title]);

  const saveTitle = useRef(
    debounce((pageId: Id<"pages">, value: string) => {
      void update({ pageId, title: value });
    }, 400)
  );
  useEffect(() => {
    const saver = saveTitle.current;
    return () => saver.flush();
  }, []);

  return (
    <div className="mx-auto w-full max-w-3xl px-14 pb-2 pt-10">
      {/* top-right page actions */}
      <div className="flex justify-end gap-1 pb-4">
        <button
          title={page.favorite ? "Remove from favorites" : "Add to favorites"}
          onClick={() => void toggleFavorite({ pageId: page._id })}
          className={cn(
            "rounded-md p-1.5 hover:bg-hov",
            page.favorite ? "text-[var(--pal-yellow)]" : "text-ink-3"
          )}
        >
          <Star size={16} fill={page.favorite ? "currentColor" : "none"} />
        </button>
        <Popover
          placement="bottom-end"
          trigger={(props) => (
            <button {...props} className="rounded-md p-1.5 text-ink-3 hover:bg-hov">
              <MoreHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <MenuList>
              <MenuItem
                icon={Trash2}
                label="Move to trash"
                danger
                onClick={() => {
                  close();
                  void trash({ pageId: page._id });
                  navigate({ kind: "home" });
                }}
              />
            </MenuList>
          )}
        </Popover>
      </div>

      <Popover
        trigger={(props) => (
          <button
            {...props}
            className="-ml-1 mb-1 rounded-lg p-1 text-[42px] leading-none hover:bg-hov"
            title="Change icon"
          >
            {page.icon ?? <span className="text-[36px] text-ink-3">{page.kind === "database" ? "🗄️" : "📄"}</span>}
          </button>
        )}
      >
        {(close) => (
          <EmojiPicker
            close={close}
            onPick={(emoji) => void update({ pageId: page._id, icon: emoji })}
            onRemove={() => void update({ pageId: page._id, icon: "" })}
          />
        )}
      </Popover>

      <input
        value={title}
        placeholder="Untitled"
        onChange={(e) => {
          setTitle(e.target.value);
          saveTitle.current(page._id, e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-full bg-transparent text-[34px] font-extrabold tracking-tight outline-none placeholder:text-ink-3"
      />
    </div>
  );
}
