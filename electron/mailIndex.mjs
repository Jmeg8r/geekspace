// WHAT: read the newest inbox messages from Mail's local SQLite "Envelope Index", read-only.
// WHY: at ~264K inbox messages every JXA/AppleScript path fails or takes 68 s+, while this
// query takes ~55 ms. The schema is Apple's and undocumented, so it is checked before use
// and every failure is a named error the widget shows. See docs/changes/2026-10-16-mail-widget/.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";

const BUSY_TIMEOUT_MS = 2_000;
const WORKER_TIMEOUT_MS = 15_000;
const STORE_DIR = /^V(\d+)$/;
const INDEX_FILE = ["MailData", "Envelope Index"];
// SQLite primary result codes for a refused open: SQLITE_CANTOPEN, SQLITE_AUTH, SQLITE_PERM.
const ACCESS_SQLITE_CODES = new Set([14, 23, 3]);
const ACCESS_FS_CODES = new Set(["EPERM", "EACCES"]);

const REQUIRED_COLUMNS = {
  mailboxes: ["url"],
  messages: [
    "global_message_id",
    "sender",
    "subject_prefix",
    "subject",
    "date_received",
    "mailbox",
    "read",
    "deleted",
  ],
  subjects: ["subject"],
  addresses: ["address", "comment"],
  message_global_data: ["message_id_header"],
  labels: ["message_id", "mailbox_id"],
};

const MESSAGES = {
  "no-store":
    "Couldn't find Mail's data (~/Library/Mail/V*/MailData/Envelope Index). Is Mail set up on this Mac?",
  "no-access":
    "Geekspace needs Full Disk Access to read your inbox: System Settings → Privacy & Security → Full Disk Access → turn on Geekspace, then quit and reopen it.",
  schema: "Mail's data format has changed, so the Inbox widget can't read it yet.",
  "no-inbox": "Mail's data lists no inbox mailboxes. Check Mail's accounts, then hit Refresh.",
  query: "Couldn't read Mail's data.",
};

export class MailIndexError extends Error {
  constructor(kind, detail = "") {
    super(detail ? `${MESSAGES[kind]} (${detail})` : MESSAGES[kind]);
    this.name = "MailIndexError";
    this.kind = kind;
    this.detail = detail;
  }
}

function isAccessDenied(error) {
  if (ACCESS_FS_CODES.has(error?.code)) return true;
  if (ACCESS_SQLITE_CODES.has(Number(error?.errcode) & 0xff)) return true;
  return /authorization denied|operation not permitted/i.test(String(error?.message));
}

function errorCode(error) {
  return String(error?.errcode ?? error?.code ?? "unknown");
}

/** The Envelope Index in the highest-numbered `V<n>` store under `mailRoot` (~/Library/Mail). */
export function findEnvelopeIndex(mailRoot, { readdir = fs.readdirSync, stat = fs.statSync } = {}) {
  let entries;
  try {
    entries = readdir(mailRoot);
  } catch (error) {
    // WHY: ~/Library/Mail is itself privacy-protected, so a missing grant shows up here first.
    if (isAccessDenied(error)) throw new MailIndexError("no-access", errorCode(error));
    if (error?.code === "ENOENT") throw new MailIndexError("no-store");
    throw new MailIndexError("query", errorCode(error));
  }
  const versions = entries
    .map((name) => STORE_DIR.exec(name))
    .filter(Boolean)
    .map((m) => ({ name: m[0], n: Number(m[1]) }))
    .sort((a, b) => b.n - a.n);
  for (const { name } of versions) {
    const file = path.join(mailRoot, name, ...INDEX_FILE);
    try {
      if (stat(file).isFile()) return file;
    } catch (error) {
      if (isAccessDenied(error)) throw new MailIndexError("no-access", errorCode(error));
      if (error?.code !== "ENOENT") throw new MailIndexError("query", errorCode(error));
      // ENOENT: this store version has no index; try the next older one.
    }
  }
  throw new MailIndexError("no-store");
}

export function openIndexReadOnly(file) {
  return new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

function checkSchema(db) {
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const present = new Set(
      db.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((r) => r.name)
    );
    const missing = columns.find((c) => !present.has(c));
    if (missing) throw new MailIndexError("schema", `missing ${table}.${missing}`);
  }
}

function lastPathSegment(url) {
  const segment = String(url).replace(/\/+$/, "").split("/").pop() ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed percent-encoding: compare the raw text instead
  }
}

function inboxMailboxIds(db) {
  return db
    .prepare("SELECT ROWID AS id, url FROM mailboxes")
    .all()
    .filter((r) => lastPathSegment(r.url).toLowerCase() === "inbox")
    .map((r) => Number(r.id));
}

function newestQuery(inboxCount) {
  const ids = Array(inboxCount).fill("?").join(",");
  // WHY the labels branch: Gmail keeps inbox mail in All Mail and maps it onto INBOX
  // through `labels` (about half of James's inbox), so `messages.mailbox` alone misses it.
  return `
    SELECT m.date_received AS date, m.read AS read, m.subject_prefix AS prefix,
           sj.subject AS subject, ad.address AS address, ad.comment AS comment,
           gd.message_id_header AS messageId
    FROM messages m
    LEFT JOIN subjects sj ON sj.ROWID = m.subject
    LEFT JOIN addresses ad ON ad.ROWID = m.sender
    LEFT JOIN message_global_data gd ON gd.ROWID = m.global_message_id
    WHERE m.deleted = 0
      AND (m.mailbox IN (${ids})
           OR m.ROWID IN (SELECT message_id FROM labels WHERE mailbox_id IN (${ids})))
    ORDER BY m.date_received DESC
    LIMIT ?`;
}

function toMessage(row) {
  const subject = `${row.prefix ?? ""}${row.subject ?? ""}`;
  const address = String(row.address ?? "");
  return {
    id: String(row.messageId ?? ""),
    subject: subject || "(no subject)",
    sender: row.comment ? `${row.comment} <${address}>` : address,
    date: Number(row.date) * 1000,
    read: Number(row.read) !== 0,
  };
}

/** Newest `limit` non-deleted inbox messages across every account, newest first. */
export function readNewestInbox(file, limit, { open = openIndexReadOnly } = {}) {
  let db;
  try {
    db = open(file);
  } catch (error) {
    if (isAccessDenied(error)) throw new MailIndexError("no-access", errorCode(error));
    throw new MailIndexError("query", errorCode(error));
  }
  try {
    checkSchema(db);
    const inbox = inboxMailboxIds(db);
    if (inbox.length === 0) throw new MailIndexError("no-inbox");
    return db
      .prepare(newestQuery(inbox.length))
      .all(...inbox, ...inbox, limit)
      .map(toMessage);
  } catch (error) {
    if (error instanceof MailIndexError) throw error;
    throw new MailIndexError("query", errorCode(error));
  } finally {
    db.close();
  }
}

/** `readNewestInbox` on a worker thread, with the same errors plus a timeout. */
export function readNewestInboxInWorker(mailRoot, limit, { timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./mailIndexWorker.mjs", import.meta.url), {
      workerData: { mailRoot, limit },
    });
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn(value);
    };
    const timer = setTimeout(
      () => settle(reject, new MailIndexError("query", `timed out after ${timeoutMs} ms`)),
      timeoutMs
    );
    worker.once("message", (m) =>
      m.ok ? settle(resolve, m.data) : settle(reject, new MailIndexError(m.kind, m.detail))
    );
    worker.once("error", (error) => settle(reject, new MailIndexError("query", String(error?.message ?? error))));
    worker.once("exit", (code) => settle(reject, new MailIndexError("query", `reader exited (${code})`)));
  });
}
