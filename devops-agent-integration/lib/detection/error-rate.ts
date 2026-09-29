/**
 * Error-rate detection for the Logs_Index monitor (M-logs-error-rate).
 *
 * Pure, AWS-free logic implementing the error-rate condition from the design's
 * error-rate monitor and Requirement 2.1: error-rate is the count of error-level
 * log documents divided by the total count of log documents within the evaluation
 * interval, expressed as a percentage from 0 to 100, compared against a configured
 * error-rate threshold percentage.
 */

/**
 * Compute the error-rate percentage as `100 * errorCount / totalCount`.
 *
 * The result is bounded to the inclusive range [0, 100] (R2.1). When `totalCount`
 * is `0` there are no documents to evaluate, so the rate is `0` (non-triggering).
 *
 * @param errorCount count of error-level log documents in the interval
 * @param totalCount total count of log documents in the interval
 * @returns error-rate percentage in [0, 100]
 */
export function computeErrorRate(errorCount: number, totalCount: number): number {
  // No documents in the interval => nothing to trigger on.
  if (totalCount <= 0) {
    return 0;
  }

  const rate = (100 * errorCount) / totalCount;

  // Bound to [0, 100] to guard against malformed inputs (e.g. errorCount > totalCount
  // or negative counts) so the result always represents a valid percentage.
  if (rate < 0) {
    return 0;
  }
  if (rate > 100) {
    return 100;
  }
  return rate;
}

/**
 * Determine whether a computed error-rate triggers the monitor.
 *
 * The monitor transitions to triggered when the value meets or exceeds its
 * threshold (R2.1 / R2.4), i.e. `rate >= threshold`.
 *
 * @param rate error-rate percentage (typically from {@link computeErrorRate})
 * @param threshold configured error-rate threshold percentage
 * @returns `true` iff `rate >= threshold`
 */
export function triggersErrorRate(rate: number, threshold: number): boolean {
  return rate >= threshold;
}
