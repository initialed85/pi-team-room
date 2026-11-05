import { parentPort } from "node:worker_threads";

import { syncSessionDatabase } from "./session-history.mjs";

// History indexing runs here rather than in the agent's own event loop: one
// sync of a long transcript is hundreds of milliseconds of SQLite, and Pi should
// not pay that between turns. The job carries only paths - the transcript is
// read from disk in this thread, so nothing about the session is copied over.
//
// One job at a time, and the caller keeps at most one more queued: each job
// re-reads the transcript, so a newer job subsumes an older one.
parentPort.on("message", (job) => {
  try {
    const dbPath = syncSessionDatabase(job?.options || {});
    parentPort.postMessage({ id: job?.id, ok: true, dbPath });
  } catch (error) {
    // History is an observability aid. A malformed transcript or a sidecar
    // another process is holding must not surface as a broken coding session.
    parentPort.postMessage({ id: job?.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
