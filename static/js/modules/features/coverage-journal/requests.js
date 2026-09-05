// Map movement or a source filter may supersede one request while the selected
// journal range remains current. Only its own signal cancels the entire update.
export async function completeJournalRequests(requests, signal) {
  const results = await Promise.allSettled(requests);
  if (signal.aborted) return false;
  for (const result of results) {
    if (result.status === "rejected" && result.reason?.name !== "AbortError") {
      throw result.reason;
    }
  }
  return true;
}
