// WHAT: macOS integration layer — reads Calendar.app and Mail.app via JXA
// (osascript -l JavaScript). Runs only in the Electron main process.
// WHY JXA over EventKit: zero compilation, JSON-native output, and the TCC
// Automation prompt is attributed to the app the user is actually using.
import { execFile } from "node:child_process";

const OSASCRIPT = "/usr/bin/osascript";
const ALLOWED_APPS = new Set(["Calendar", "Mail"]);

function run(cmd, args, timeout = 90_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || "");
        // WHY: a timeout kill produces a bare "Command failed: …" with no
        // stderr — usually the macOS Automation dialog sitting unanswered
        // (it blocks the script and loves hiding behind windows).
        if (err.killed || err.signal) {
          reject(
            new Error(
              "Timed out — if a macOS permission dialog is open (it may be behind a window), approve it and hit Refresh. Otherwise check System Settings → Privacy & Security → Automation."
            )
          );
        } else if (msg.includes("-1743") || /not authori[sz]ed/i.test(msg)) {
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

const runJxa = (script, timeout) => run(OSASCRIPT, ["-l", "JavaScript", "-e", script], timeout);

/**
 * Trigger the one-time Automation permission with a near-zero-work probe and a
 * generous window for the user to find the dialog. Heavy fetches run after.
 */
async function armAutomation(appName) {
  if (!ALLOWED_APPS.has(appName)) throw new Error(`Unsupported app: ${appName}`);
  await runJxa(`Application(${JSON.stringify(appName)}).name()`, 180_000);
}

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
  await armAutomation("Calendar");
  const out = await runJxa(`JSON.stringify(Application("Calendar").calendars.name())`);
  return JSON.parse(out || "[]");
}

export async function fetchCalendarEvents(startMs, endMs, names) {
  await armAutomation("Calendar");
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
  await armAutomation("Mail");
  const n = Math.max(1, Math.min(Number(limit) || 12, 25));
  // WHY bulk arrays: one Apple event per property instead of ~5 per message —
  // far fewer round trips, and we get every date so we can sort newest-first
  // ourselves (Mail's `messages` order is oldest-first on many setups).
  const script = `
(() => {
  const Mail = Application("Mail");
  let msgs;
  try {
    msgs = Mail.inbox.messages;
    if (msgs.length === 0) return "[]";
  } catch (e) { return "[]"; }
  const subjects = msgs.subject();
  const senders = msgs.sender();
  const dates = msgs.dateReceived();
  const ids = msgs.messageId();
  const reads = msgs.readStatus();
  const idx = dates.map((d, i) => i);
  idx.sort((a, b) => dates[b] - dates[a]);
  const out = [];
  for (let k = 0; k < Math.min(idx.length, ${n}); k++) {
    const i = idx[k];
    out.push({
      id: String(ids[i] || ""),
      subject: String(subjects[i] || "(no subject)"),
      sender: String(senders[i] || ""),
      date: dates[i].getTime(),
      read: Boolean(reads[i]),
    });
  }
  return JSON.stringify(out);
})()`;
  const out = await runJxa(script, 120_000);
  return JSON.parse(out || "[]");
}

/** Deep link into Mail.app for a specific message. */
export function messageUrl(messageId) {
  const bare = String(messageId).replace(/^<|>$/g, "");
  return `message://%3C${encodeURIComponent(bare)}%3E`;
}
