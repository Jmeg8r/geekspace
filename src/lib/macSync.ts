import { convex } from "./convex";
import { api } from "../../convex/_generated/api";
import { tzOffsetMin } from "./utils";
import { integrationsAvailable, macFetchEvents, macIsRunning } from "./integrations";

const DAY_MS = 86_400_000;

export interface SyncOutcome {
  ok: boolean;
  message: string;
}

// WHAT: One sync pass — pull a ~6-week window from Calendar.app and mirror it
// into Convex. Shared by the background loop and the Settings "Sync now" button.
export async function syncMacCalendar(calendarNames: string[]): Promise<SyncOutcome> {
  if (!integrationsAvailable()) {
    return { ok: false, message: "Only available in the desktop app" };
  }
  const running = await macIsRunning("Calendar");
  if (!running.ok || !running.data) {
    return { ok: false, message: "Calendar.app isn't running — open it to sync" };
  }
  const windowStart = Date.now() - 7 * DAY_MS;
  const windowEnd = Date.now() + 35 * DAY_MS;
  const events = await macFetchEvents(windowStart, windowEnd, calendarNames);
  if (!events.ok) return { ok: false, message: events.error };

  const result = await convex.mutation(api.events.syncExternal, {
    windowStart,
    windowEnd,
    items: events.data.map((e) => ({
      externalId: e.externalId,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay || undefined,
      calendarName: e.calendarName,
    })),
    tzOffsetMin: tzOffsetMin(),
  });
  const changes = result.created + result.updated + result.removed;
  return {
    ok: true,
    message:
      changes === 0
        ? `Up to date (${result.total} events)`
        : `Synced ${result.total} events (+${result.created} / ~${result.updated} / -${result.removed})`,
  };
}
