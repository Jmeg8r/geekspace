# CLAUDE.md — geekspace

## Project Purpose

A Notion-style macOS desktop app (Electron + React + Convex) with a block editor,
Notion-Projects-style databases (table/board/list/calendar/timeline views), and a
calendar that auto-schedules itself around task dependencies. Built on the ASTGL brand.

## Key Commands

```bash
npm run dev        # Convex + Vite + Electron together
npm run dev:web    # Convex + Vite (no Electron)
npm test           # vitest run
npm run build      # tsc -b && vite build
npm run package    # build + electron-builder --mac
```

<!-- COMPOUND:START -->
## Compound Engineering Setup

Learnings are captured by gstack into `~/.gstack/projects/<slug>/learnings.jsonl` and
auto-loaded into context at session start. This repo commits only the human-readable
digest below — the gstack store is the source of truth.

- **View learnings offline:** `./show-learnings.sh` (also `high`, or a type filter)
- **Record a constraint:** `/gstack-learn add` (write constraints, not observations)
- **Refresh the table below** after a session's Compound step: `./refresh-digest.sh`
- **Session logs:** copy `sessions/TEMPLATE.md` → `sessions/SESSION-NNN-<title>.md` and
  follow Brainstorm → Plan → Work → Review → Compound.

## Known Patterns

<!-- LEARNINGS:START -->
_No learnings yet. Run `/gstack-learn add` during a session, then `./refresh-digest.sh`._
<!-- LEARNINGS:END -->
<!-- COMPOUND:END -->
