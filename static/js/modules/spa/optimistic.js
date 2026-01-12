export async function optimisticAction({ optimistic, request, commit, rollback }) {
  let snapshot = null;
  try {
    snapshot = optimistic?.();
    const result = await request();
    if (commit) {
      commit(result, snapshot);
    }
    return result;
  } catch (error) {
    if (rollback) {
      rollback(snapshot, error);
    }
    throw error;
  }
}
