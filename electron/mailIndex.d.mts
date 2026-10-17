// WHAT: types for the Mail Envelope Index reader, so tests/ can import it (see meetingProcessor.d.mts).
import type { Stats } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type MailIndexErrorKind = "no-store" | "no-access" | "schema" | "no-inbox" | "query";

export class MailIndexError extends Error {
  kind: MailIndexErrorKind;
  constructor(kind: MailIndexErrorKind, detail?: string);
}

export interface InboxMessage {
  id: string;
  subject: string;
  sender: string;
  date: number;
  read: boolean;
}

export function findEnvelopeIndex(
  mailRoot: string,
  deps?: {
    readdir?: (dir: string) => string[];
    stat?: (file: string) => Pick<Stats, "isFile">;
  }
): string;

export function openIndexReadOnly(file: string): DatabaseSync;

export function readNewestInbox(
  file: string,
  limit: number,
  deps?: { open?: (file: string) => DatabaseSync }
): InboxMessage[];
