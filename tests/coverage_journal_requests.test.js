import assert from "node:assert/strict";
import test from "node:test";
import { completeJournalRequests } from "../static/js/modules/features/coverage-journal/requests.js";

test("a superseded viewport request does not discard a successful range update", async () => {
  const controller = new AbortController();
  let notesFinished = false;
  const result = await completeJournalRequests(
    [
      Promise.reject(new DOMException("Viewport moved", "AbortError")),
      Promise.resolve().then(() => {
        notesFinished = true;
      }),
    ],
    controller.signal
  );
  assert.equal(result, true);
  assert.equal(notesFinished, true);
});

test("an obsolete range never publishes its completed requests", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await completeJournalRequests([Promise.resolve()], controller.signal),
    false
  );
});

test("real request failures still reach the journal error UI", async () => {
  await assert.rejects(
    completeJournalRequests(
      [Promise.reject(new Error("Could not load history"))],
      new AbortController().signal
    ),
    /Could not load history/
  );
});
