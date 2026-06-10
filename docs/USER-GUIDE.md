# Geekspace User Guide

Everything you can do in Geekspace, and how. A condensed version of this guide lives inside the app — look for **📖 User Guide** in the sidebar.

---

## 1. Starting and stopping

```bash
cd ~/Projects/geekspace
npm run dev          # backend + UI + app window, all together
```

- **Stop it with one Ctrl-C** in that terminal — this shuts down all three processes cleanly.
- If you ever see *"A local backend is still running on port 3210"*, something exited uncleanly. Fix: `lsof -ti:3210 | xargs kill`, then `npm run dev` again.
- Your data lives in a local SQLite file under `.convex/` (managed by Convex) — it survives restarts, quits, and crashes. Nothing touches the cloud.
- First-time setup on a new machine: `npm install`, then `npm run dev`, then `npm run seed` once.

---

## 2. Pages and writing

| Action | How |
|---|---|
| New page / database | Sidebar **+ New page**, or hover **Pages** → **+**, or `⌘N` |
| Page inside a page | Hover a sidebar item → **+** |
| Block menu | Type **/** anywhere in a page |
| Markdown shortcuts | `#`, `##`, `-`, `1.`, `[]`, `>` then space |
| Move blocks | Drag the ⋮⋮ handle in the left margin |
| Images | `/image`, then upload — stored in your local backend |
| Icon | Click the big icon above the title |
| Favorite | Star (top right) — pins it to the sidebar Favorites |
| Trash / restore | ⋯ menu → Move to trash; **Trash** at the sidebar bottom to restore or delete forever |

Everything autosaves continuously — there is no save button anywhere in Geekspace.

## 3. Databases

A database is a page full of structured rows. **Every row is also a page** — open it (hover → **Open** in tables, click a card on boards) to get its properties plus a full document.

**Properties** (columns): text, number (plain/minutes/percent/dollar/progress), select, multi-select, status (grouped To-do / In progress / Complete), date (optional time + end date), checkbox, URL, relation, rollup, created/updated time. Add one with **+** at the end of the table header; click any header to rename it, edit its options (click a swatch to recycle its color), or delete it.

**Views** are saved lenses over the same rows — Table, Board, List, Calendar, Timeline. Each view keeps its own **Filter**, **Sort**, and **Properties** (column visibility) settings from the toolbar. Add views with **+** next to the tabs.

**Relations & rollups:** a relation links rows across (or within) a database, and both sides stay in sync automatically. A rollup computes over related rows — count, sum, average, min/max, or **% complete** against a status property (that's what powers project progress bars).

## 4. Project management

Your workspace follows Notion's Projects setup:

- **Projects** ⇄ **Tasks** via the Project relation. Each project's **Progress** bar is the % of its related tasks marked Done.
- **Sub-tasks:** set a task's **Parent task** — the parent's **Sub-tasks** list updates itself.
- **Dependencies:** set **Blocked by** on a task. Two things happen:
  - Timeline views draw an arrow from blocker → blocked.
  - **The auto-scheduler refuses to schedule blocked work before its blockers finish** (this is beyond Notion, where dependencies are just visual). Blocked tasks show a ⛓ chip in My Tasks. Completing the blocker unblocks them automatically.
- **Sprints:** the Sprints database holds two-week iterations (Upcoming / Current / Completed) with their own progress rollups. On the Tasks page, **Sprint Board** shows the current sprint as a kanban and **Backlog** lists unassigned open tasks. When a sprint ends, open the Sprints page and hit **🏁 Complete sprint** — it closes the current one, promotes (or creates) the next, **rolls every unfinished task forward**, and repoints the Sprint Board.

**My Tasks** on Home aggregates open tasks across every task database — Overdue / Today / Upcoming — with one-click done checkboxes.

## 5. The self-scheduling calendar

The core idea, borrowed from Motion/Reclaim: **appointments are fixed, tasks are fluid.** Give a task an *estimate* and a *due date*, and the engine packs work blocks into your working hours around everything that's fixed — earliest-deadline-first, then priority, splitting big tasks into chunks (30 min–2 h by default) with buffers between items.

**Reading the week grid:**

| Look | Meaning |
|---|---|
| Solid color block | Fixed event (appointment) |
| Translucent block, ⚡ | Auto-scheduled task block — the engine may move it |
| Solid block with 🔒 | Locked block — you placed it; the engine schedules around it |
| Red stripes | Past due — couldn't fit before the deadline |
| Dotted left edge | Synced from macOS Calendar (read-only) |
| Red line | Now |

**Interactions:** drag on empty space to create an event · drag a block/event to move (moving a task block **locks** it) · drag the bottom edge to resize · right-click a task block to lock/unlock, mark the task done, or open it · click anything for details. Keyboard: **T** today, **J/K** forward/back, **W/M** week/month.

**Everything reflows automatically** — add or move an appointment, change an estimate or due date, complete a task, drag a block, or change working hours, and the whole future plan recomputes. Past and in-progress blocks are never rewritten; remaining work is recalculated from what's left.

**When work doesn't fit**, nothing silently disappears: the red **needs attention** badge lists tasks that can't fit before the horizon, tasks scheduled past their due date, and tasks missing an estimate.

## 6. AI meeting notes

**Meetings** in the sidebar (`⌘3`) is a fully local recreation of Notion's AI Meeting Notes: record → transcribe → summarize, with nothing leaving your Mac.

**Recording a meeting:**
1. Hit **Record**. Name the meeting, pick a **meeting type** — the summary is tailored to it (General, Standup, 1:1, Client call, Interview, Brainstorm) — and optionally link a calendar event (one happening *right now* is pre-selected).
2. The first time, macOS asks for **Microphone** permission — click OK.
3. A floating recorder appears bottom-right with a live level meter. It follows you anywhere in the app; pause/resume as needed.
4. **Stop** kicks off the pipeline: audio is saved, **whisper.cpp** transcribes it (progress shown live), then your **local Ollama model** writes a summary with key points, decisions, and action items.

**What you get:** a meeting record (audio playback, full transcript, structured summary) *and* an auto-created notes page under **🎙️ Meeting Notes** — searchable like any page, with action items as checkboxes. Hover an action item on the meeting → **+ task** sends it to your Tasks database.

**Good to know:**
- It records your **microphone**. For the far side of video calls, use speakers instead of headphones, or route system audio with a loopback device (BlackHole) set as input.
- Summarizer model and Ollama URL live in **Settings → AI meeting notes**, along with tool status (ffmpeg, whisper.cpp, speech model — with a one-click model download). Default model: your first `gemma*`, currently `gemma4:31b-mlx`.
- If the AI leg fails (Ollama not running, say), the recording and transcript are safe — hit **Re-run AI** on the meeting.
- Deleting a meeting removes its audio but keeps the notes page.

## 7. macOS Calendar & Mail

Open **Settings → macOS integrations** (visible only in the desktop app):

**Calendar sync** — toggle it on, pick which calendars to include, hit **Sync now**. The first sync triggers a macOS permission prompt (*"Geekspace would like to control Calendar"*) — click **OK**. From then on it syncs at launch, on window focus, and every 5 minutes (Calendar.app must be running; the sync covers last week through five weeks out). Synced events appear with a dotted edge, are read-only in Geekspace, and — the whole point — **the auto-scheduler treats them as fixed busy time**. Edit or delete them in Calendar; changes flow back on the next sync.

**Mail inbox** — toggle "Mail inbox on Home." The Home screen gains an Inbox section showing recent messages from Mail.app (unread dots included). Hover a message: **↗** opens it in Mail; **+** creates a task from it, with a link back to the original email in the task's notes. Same one-time permission prompt, this time for Mail.

If you denied a prompt and the integration errors out: System Settings → Privacy & Security → **Automation** → enable Calendar/Mail under Geekspace (or Electron during `npm run dev`).

## 8. Settings

- **Appearance:** Light / Dark / System (ASTGL light = warm gray + burnt orange; dark = deep navy + vivid orange).
- **Working hours:** which days and what window the scheduler may use.
- **Auto-scheduling:** smallest/largest block size, buffer between items, planning horizon.

## 9. Keyboard shortcuts

| Key | Action |
|---|---|
| `⌘K` | Search everything / command palette |
| `⌘N` | New page |
| `⌘1` / `⌘2` / `⌘3` | Home / Calendar / Meetings |
| `T`, `J`, `K`, `W`, `M` | Calendar: today, next, previous, week, month |
| `/` | Block menu in any page |
| `Esc` | Close any modal |

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| "Port 3210 still running" on `npm run dev` | `lsof -ti:3210 \| xargs kill`, retry |
| App opens but no data | The Convex backend isn't running — use `npm run dev`, not `electron .` alone |
| Calendar/Mail sync error mentioning permissions | System Settings → Privacy & Security → Automation |
| Mail/Calendar "timed out" | Three causes, same symptom: ① the macOS permission dialog is blocking — it can hide **behind windows**; find it, approve once. ② The app is **unresponsive** — quit and reopen Mail/Calendar. ③ A very large mailbox/calendar — just Refresh and wait. |
| "Calendar.app isn't running" | Open Calendar (sync needs it alive), or hit Sync now after opening it |
| A task never gets scheduled | It needs both an **estimate** and ideally a due date; check the needs-attention badge |
| Blocks an hour off after a DST switch | Any reflow self-corrects (open the app / hit Reflow) |
| Meeting stuck in "Transcribing" after a crash | Open the meeting → **Re-run AI** (audio is always saved first) |
| Summary fails with an Ollama error | Make sure `ollama serve` is running; check Settings → AI meeting notes |
| Recording has no speech detected | Check the input device in System Settings → Sound; the level meter should move while you talk |

---

*Geekspace — an As The Geek Learns build. If you do something more than twice, automate it.*
