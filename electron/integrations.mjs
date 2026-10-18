// WHAT: macOS integration layer — reads Calendar.app via JXA (osascript -l JavaScript)
// and Mail's local index (mailIndex.mjs). Runs only in the Electron main process.
// WHY JXA over EventKit: zero compilation, JSON-native output, and the TCC
// Automation prompt is attributed to the app the user is actually using.
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readNewestInboxInWorker } from "./mailIndex.mjs";

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
              "Timed out — three usual suspects: a macOS permission dialog is open (check behind windows), the app is unresponsive (quit and reopen Calendar/Mail), or it's just huge. Then hit Refresh."
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
  // WHY: the sync deletes mirrors that weren't returned. Only a calendar read without a
  // single error may be judged that way, so report which ones that was.
  const complete = [];
  // Every calendar Calendar.app lists, so the sync can drop mirrors of deleted calendars;
  // left null if any name can't be read, since then absence proves nothing.
  let present = [];
  const cals = Calendar.calendars();
  for (const cal of cals) {
    let name = "";
    try { name = cal.name(); } catch (e) { present = null; continue; }
    if (present) present.push(name);
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
    let clean = true;
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
      } catch (e) { clean = false; }
    }
    if (clean) complete.push(name);
  }
  return JSON.stringify({ events: out, complete: complete, present: present });
})()`;
  const out = await runJxa(script);
  return JSON.parse(out || '{"events":[],"complete":[],"present":null}');
}

export async function fetchInbox(limit = 12) {
  const n = Math.max(1, Math.min(Number(limit) || 12, 25));
  // WHY not JXA: on a ~264K-message inbox every scripting path fails or takes 68 s+.
  // Mail's own index answers in ~25 ms and needs Full Disk Access, not Automation.
  return readNewestInboxInWorker(path.join(os.homedir(), "Library", "Mail"), n);
}

/** Deep link into Mail.app for a specific message. */
export function messageUrl(messageId) {
  const bare = String(messageId).replace(/^<|>$/g, "");
  return `message://%3C${encodeURIComponent(bare)}%3E`;
}
