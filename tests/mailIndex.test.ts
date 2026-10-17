import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MailIndexError, findEnvelopeIndex, openIndexReadOnly, readNewestInbox } from "../electron/mailIndex.mjs";

// WHAT: the Home Mail widget reads Mail's Envelope Index, newest inbox messages first,
// and every failure is a named, visible error. See docs/changes/2026-10-16-mail-widget/.
// Fixtures are synthetic: only the tables and columns the reader uses, nothing real.

const SCHEMA = `
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT, total_count INTEGER);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT, comment TEXT);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY, message_id INTEGER, message_id_header TEXT);
CREATE TABLE labels (message_id INTEGER, mailbox_id INTEGER);
CREATE TABLE messages (
  ROWID INTEGER PRIMARY KEY, global_message_id INTEGER, sender INTEGER, subject_prefix TEXT,
  subject INTEGER, date_received INTEGER, mailbox INTEGER, read INTEGER, deleted INTEGER
);`;

const IMAP_INBOX = 1;
const EWS_INBOX = 2;
const GMAIL_ALL = 3;
const ARCHIVE = 4;
const GMAIL_INBOX = 5;

type Msg = {
  id: number;
  mailbox: number;
  date: number;
  subject?: string | null;
  prefix?: string;
  sender?: { address: string; comment?: string } | null;
  read?: 0 | 1;
  deleted?: 0 | 1;
  label?: number;
};

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gs-mailindex-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function buildIndex(
  messages: Msg[],
  opts: { mailboxes?: [number, string][]; schema?: string } = {}
): string {
  const file = path.join(dir, "Envelope Index");
  const db = new DatabaseSync(file);
  db.exec(opts.schema ?? SCHEMA);
  const boxes = opts.mailboxes ?? [
    [IMAP_INBOX, "imap://11111111-AAAA/INBOX"],
    [EWS_INBOX, "ews://22222222-BBBB/Inbox"],
    [GMAIL_ALL, "imap://33333333-CCCC/%5BGmail%5D/All%20Mail"],
    [ARCHIVE, "imap://11111111-AAAA/INBOX/Archive"],
    [GMAIL_INBOX, "imap://33333333-CCCC/INBOX"],
  ];
  for (const [id, url] of boxes) {
    db.prepare("INSERT INTO mailboxes (ROWID, url, total_count) VALUES (?, ?, 0)").run(id, url);
  }
  for (const m of messages) {
    let subjectRow: number | null = null;
    if (m.subject !== null) {
      subjectRow = Number(
        db.prepare("INSERT INTO subjects (subject) VALUES (?)").run(m.subject ?? `s${m.id}`)
          .lastInsertRowid
      );
    }
    let senderRow: number | null = null;
    if (m.sender !== null) {
      const s = m.sender ?? { address: `a${m.id}@example.test` };
      senderRow = Number(
        db.prepare("INSERT INTO addresses (address, comment) VALUES (?, ?)").run(s.address, s.comment ?? "")
          .lastInsertRowid
      );
    }
    db.prepare("INSERT INTO message_global_data (ROWID, message_id, message_id_header) VALUES (?, ?, ?)").run(
      m.id,
      m.id,
      `<m${m.id}@example.test>`
    );
    db.prepare(
      `INSERT INTO messages (ROWID, global_message_id, sender, subject_prefix, subject, date_received, mailbox, read, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(m.id, m.id, senderRow, m.prefix ?? "", subjectRow, m.date, m.mailbox, m.read ?? 0, m.deleted ?? 0);
    if (m.label !== undefined) {
      db.prepare("INSERT INTO labels (message_id, mailbox_id) VALUES (?, ?)").run(m.id, m.label);
    }
  }
  db.close();
  return file;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("readNewestInbox", () => {
  it("returns inbox messages newest first, across direct and Gmail-label inboxes", () => {
    const file = buildIndex([
      { id: 1, mailbox: IMAP_INBOX, date: 1000 },
      { id: 2, mailbox: EWS_INBOX, date: 3000 },
      { id: 3, mailbox: GMAIL_ALL, date: 4000, label: GMAIL_INBOX },
      { id: 4, mailbox: GMAIL_ALL, date: 5000 }, // All Mail, no inbox label
      { id: 5, mailbox: ARCHIVE, date: 6000 }, // a folder under INBOX, not the inbox
      { id: 6, mailbox: IMAP_INBOX, date: 7000, deleted: 1 },
      { id: 7, mailbox: IMAP_INBOX, date: 2000 },
    ]);
    expect(ids(readNewestInbox(file, 10))).toEqual([
      "<m3@example.test>",
      "<m2@example.test>",
      "<m7@example.test>",
      "<m1@example.test>",
    ]);
  });

  it("respects the limit", () => {
    const file = buildIndex(
      Array.from({ length: 30 }, (_, i) => ({ id: i + 1, mailbox: IMAP_INBOX, date: 1000 + i }))
    );
    const rows = readNewestInbox(file, 12);
    expect(rows).toHaveLength(12);
    expect(rows[0].id).toBe("<m30@example.test>");
  });

  it("maps fields to the widget's message shape", () => {
    const file = buildIndex([
      {
        id: 1,
        mailbox: IMAP_INBOX,
        date: 1_760_000_000,
        prefix: "Re: ",
        subject: "Lunch",
        sender: { address: "pat@example.test", comment: "Pat Lee" },
        read: 1,
      },
      { id: 2, mailbox: IMAP_INBOX, date: 1_759_000_000, subject: null, sender: { address: "x@example.test" } },
    ]);
    expect(readNewestInbox(file, 5)).toEqual([
      {
        id: "<m1@example.test>",
        subject: "Re: Lunch",
        sender: "Pat Lee <pat@example.test>",
        date: 1_760_000_000_000,
        read: true,
      },
      {
        id: "<m2@example.test>",
        subject: "(no subject)",
        sender: "x@example.test",
        date: 1_759_000_000_000,
        read: false,
      },
    ]);
  });

  it("returns an empty list only when inbox mailboxes exist and hold nothing", () => {
    const file = buildIndex([{ id: 1, mailbox: ARCHIVE, date: 1000 }]);
    expect(readNewestInbox(file, 12)).toEqual([]);
  });

  it("fails loudly, not with an empty list, when no inbox mailbox exists", () => {
    const file = buildIndex([{ id: 1, mailbox: 9, date: 1000 }], {
      mailboxes: [[9, "imap://11111111-AAAA/Sent"]],
    });
    expect(() => readNewestInbox(file, 12)).toThrow(
      expect.objectContaining({ name: "MailIndexError", kind: "no-inbox" })
    );
  });

  it("names the missing column when Mail's schema has changed", () => {
    const file = buildIndex([], { schema: SCHEMA.replace("date_received INTEGER, ", "") });
    const read = () => readNewestInbox(file, 12);
    expect(read).toThrow(MailIndexError);
    expect(read).toThrow(
      expect.objectContaining({ kind: "schema", message: expect.stringContaining("messages.date_received") })
    );
  });

  it("closes the handle after reading", () => {
    const file = buildIndex([{ id: 1, mailbox: IMAP_INBOX, date: 1000 }]);
    let handle: DatabaseSync | undefined;
    readNewestInbox(file, 1, {
      open: (p: string) => {
        handle = openIndexReadOnly(p);
        return handle;
      },
    });
    expect(handle?.isOpen).toBe(false);
  });

  it("opens the index read-only, so a write through the handle fails", () => {
    const file = buildIndex([{ id: 1, mailbox: IMAP_INBOX, date: 1000 }]);
    const db = openIndexReadOnly(file);
    expect(() => db.exec("DELETE FROM messages")).toThrow(/readonly/i);
    db.close();
  });

  it.each([
    ["authorization denied", Object.assign(new Error("authorization denied"), { errcode: 23 })],
    ["unable to open database file", Object.assign(new Error("unable to open database file"), { errcode: 14 })],
    ["EPERM", Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })],
  ])("reports a missing Full Disk Access grant (%s)", (_label, thrown) => {
    const read = () =>
      readNewestInbox(path.join(dir, "Envelope Index"), 12, {
        open: () => {
          throw thrown;
        },
      });
    expect(read).toThrow(MailIndexError);
    expect(read).toThrow(
      expect.objectContaining({ kind: "no-access", message: expect.stringMatching(/Full Disk Access/) })
    );
  });
});

describe("findEnvelopeIndex", () => {
  function makeStore(version: string, withFile: boolean) {
    const data = path.join(dir, version, "MailData");
    fs.mkdirSync(data, { recursive: true });
    if (withFile) fs.writeFileSync(path.join(data, "Envelope Index"), "");
  }

  it("picks the highest V<n> that holds an Envelope Index", () => {
    makeStore("V9", true);
    makeStore("V10", true);
    makeStore("V11", false);
    expect(findEnvelopeIndex(dir)).toBe(path.join(dir, "V10", "MailData", "Envelope Index"));
  });

  it("reports a missing Mail store", () => {
    makeStore("V10", false);
    expect(() => findEnvelopeIndex(dir)).toThrow(expect.objectContaining({ kind: "no-store" }));
    expect(() => findEnvelopeIndex(path.join(dir, "absent"))).toThrow(
      expect.objectContaining({ kind: "no-store" })
    );
  });

  it("reports a missing Full Disk Access grant when ~/Library/Mail can't be listed", () => {
    const denied = () => {
      throw Object.assign(new Error("EPERM: operation not permitted, scandir"), { code: "EPERM" });
    };
    expect(() => findEnvelopeIndex(dir, { readdir: denied })).toThrow(
      expect.objectContaining({ kind: "no-access" })
    );
  });
});
