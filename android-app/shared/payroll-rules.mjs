/**
 * Resolve the daily rate effective for a worker/month.
 *
 * The exact month wins. Otherwise the newest earlier monthly record remains
 * effective; when no monthly record exists, the worker default is used. The
 * optional workerRecords argument lets indexed callers avoid scanning records
 * belonging to other workers without changing the business rule.
 */
export function resolveEffectiveDailyRate(data, worker, month, workerRecords) {
  const records = workerRecords ?? data.monthlyRecords;
  let effective = null;
  for (const candidate of records) {
    if (candidate.workerId !== worker.id || candidate.month > month) continue;
    if (effective === null || candidate.month > effective.month) effective = candidate;
  }
  return effective
    ? { rateFen: effective.dailyRateFen, sourceMonth: effective.month }
    : { rateFen: worker.defaultDailyRateFen, sourceMonth: null };
}
