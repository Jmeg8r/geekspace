// WHAT: macOS integration layer — reads Calendar.app and Mail.app via JXA
// (osascript -l JavaScript). Runs only in the Electron main process.
// WHY JXA over EventKit: zero compilation, JSON-native output, and the TCC
// Automation prompt is attributed to the app the user is actually using.
import { execFile } from "node:child_process";

const OSASCRIPT = "/usr/bin/osascript";
const ALLOWED_APPS = new Set(["Calendar", "Mail"]);

function run(cmd, args, timeout = 45_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || "");
        if (msg.includes("-1743") || /not authori[sz]ed/i.test(msg)) {
          reject(
            new Error(
              "Permission needed: System Settings → Privacy & Security → Automation → allow Geekspace (or Electron) to control Calendar/Mail."
            )
          );
        } else if (msg.includes("-600")) {
          reject(new Error("The app isn't running."));
        } else {
          reject(new Error(msg.slice(0, 300) || "osascript failed"));
        }
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

const runJxa = (script) => run(OSASCRIPT, ["-l", "JavaScript", "-e", script]);

export async function isAppRunning(name) {
  if (!ALLOWED_APPS.has(name)) return false;
  try {
    await run("/usr/bin/pgrep", ["-x", name], 5_000);
    return true;
  } catch {
    return false;
  }
}

export async function openApp(name) {
  if (!ALLOWED_APPS.has(name)) return;
  await run("/usr/bin/open", ["-a", name], 10_000);
}

export async function listCalendars() {
  const out = await runJxa(`JSON.stringify(Application("Calendar").calendars.name())`);
  return JSON.parse(out || "[]");
}

export async function fetchCalendarEvents(startMs, endMs, names) {
  const script = `
(() => {
  const Calendar = Application("Calendar");
  const startWindow = new Date(${Number(startMs)});
  const endWindow = new Date(${Number(endMs)});
  const wanted = ${JSON.stringify(Array.isArray(names) ? names : [])};
  const out = [];
  const cals = Calendar.calendars();
  for (const cal of cals) {
    let name = "";
    try { name = cal.name(); } catch (e) { continue; }
    if (wanted.length > 0 && wanted.indexOf(name) === -1) continue;
    let events = [];
    try {
      events = cal.events.whose({
        _and: [
          { startDate: { _greaterThan: startWindow } },
          { startDate: { _lessThan: endWindow } },
        ],
      })();
    } catch (e) { continue; }
    for (const ev of events) {
      try {
        const sd = ev.startDate();
        const ed = ev.endDate();
        if (!sd || !ed) continue;
        out.push({
          // uid + start: recurring events share a uid, so each occurrence
          // needs its own identity for the mirror upsert.
          externalId: String(ev.uid() || name) + ":" + sd.getTime(),
          title: String(ev.summary() || "Untitled"),
          start: sd.getTime(),
          end: ed.getTime(),
          allDay: Boolean(ev.alldayEvent()),
          calendarName: name,
        });
      } catch (e) {}
    }
  }
  return JSON.stringify(out);
})()`;
  const out = await runJxa(script);
  return JSON.parse(out || "[]");
}

export async function fetchInbox(limit = 12) {
  const script = `
(() => {
  const Mail = Application("Mail");
  const out = [];
  let count = 0;
  try { count = Mail.inbox.messages.length; } catch (e) { return "[]"; }
  const n = Math.min(count, ${Math.max(1, Math.min(Number(limit) || 12, 25))});
  for (let i = 0; i < n; i++) {
    try {
      const m = Mail.inbox.messages[i];
      out.push({
        id: String(m.messageId() || ""),
        subject: String(m.subject() || "(no subject)"),
        sender: String(m.sender() || ""),
        date: m.dateReceived().getTime(),
        read: Boolean(m.readStatus()),
      });
    } catch (e) {}
  }
  return JSON.stringify(out);
})()`;
  const out = await runJxa(script);
  return JSON.parse(out || "[]");
}

/** Deep link into Mail.app for a specific message. */
export function messageUrl(messageId) {
  const bare = String(messageId).replace(/^<|>$/g, "");
  return `message://%3C${encodeURIComponent(bare)}%3E`;
}
