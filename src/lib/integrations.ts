// WHAT: Typed renderer wrapper over the Electron preload bridge.
// In the browser (dev QA) the bridge is absent and every surface hides itself.

export interface MacCalendarEvent {
  externalId: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  calendarName: string;
}

export interface MacMailMessage {
  id: string;
  subject: string;
  sender: string;
  date: number;
  read: boolean;
}

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

interface Bridge {
  isRunning(name: string): Promise<IpcResult<boolean>>;
  openApp(name: string): Promise<IpcResult<void>>;
  listCalendars(): Promise<IpcResult<string[]>>;
  fetchCalendarEvents(
    start: number,
    end: number,
    names: string[]
  ): Promise<IpcResult<MacCalendarEvent[]>>;
  fetchInbox(limit: number): Promise<IpcResult<MacMailMessage[]>>;
  openMessage(messageId: string): Promise<IpcResult<void>>;
}

function bridge(): Bridge | undefined {
  return (window as { geekspace?: { integrations?: Bridge } }).geekspace?.integrations;
}

export const integrationsAvailable = (): boolean => Boolean(bridge());

async function call<T>(fn: (b: Bridge) => Promise<IpcResult<T>>): Promise<IpcResult<T>> {
  const b = bridge();
  if (!b) return { ok: false, error: "Only available in the desktop app" };
  try {
    return await fn(b);
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

export const macIsRunning = (name: "Calendar" | "Mail") => call((b) => b.isRunning(name));
export const macOpenApp = (name: "Calendar" | "Mail") => call((b) => b.openApp(name));
export const macListCalendars = () => call((b) => b.listCalendars());
export const macFetchEvents = (start: number, end: number, names: string[]) =>
  call((b) => b.fetchCalendarEvents(start, end, names));
export const macFetchInbox = (limit = 12) => call((b) => b.fetchInbox(limit));
export const macOpenMessage = (messageId: string) => call((b) => b.openMessage(messageId));
