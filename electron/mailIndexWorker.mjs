// WHAT: worker-thread entry for readNewestInboxInWorker (mailIndex.mjs).
// WHY: node:sqlite is synchronous; running it here keeps a busy lock or a cold read of the
// multi-GB index from freezing Electron's main process.
import { parentPort, workerData } from "node:worker_threads";
import { findEnvelopeIndex, readNewestInbox } from "./mailIndex.mjs";

try {
  const { mailRoot, limit } = workerData;
  parentPort.postMessage({ ok: true, data: readNewestInbox(findEnvelopeIndex(mailRoot), limit) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    kind: error?.kind ?? "query",
    detail: error?.detail ?? String(error?.message ?? error),
  });
}
