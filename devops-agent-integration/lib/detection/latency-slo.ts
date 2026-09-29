/**
 * Latency SLO percentile detection (Alert_Monitor: M-trace-latency-slo).
 *
 * Pure detection logic for Requirement 2.2 (Property 2: Latency SLO percentile
 * breach). No AWS calls — these functions operate purely on in-memory data so
 * they can be exercised by property-based tests.
 *
 * A trace latency SLO breach is defined as a configurable latency percentile
 * (selectable from p50 to p99, defaulting to p95) exceeding a configured
 * latency threshold expressed in milliseconds.
 *
 * Percentile method
 * -----------------
 * We use the **linear interpolation between closest ranks** method (a.k.a. the
 * "R-7" / Excel `PERCENTILE.INC` / NumPy default `linear` method):
 *
 *   Given `n` values sorted ascending as `x[0..n-1]` and a percentile `p`
 *   expressed in `[0, 100]`, the rank position is
 *
 *       rank = (p / 100) * (n - 1)
 *
 *   Let `lo = floor(rank)` and `frac = rank - lo`. The percentile is
 *
 *       x[lo]                              when frac == 0 (or lo is the last index)
 *       x[lo] + frac * (x[lo + 1] - x[lo]) otherwise
 *
 * This is deterministic and continuous in `p`, which makes it well suited for
 * property testing. Durations are handled in nanoseconds and converted to
 * milliseconds only at the SLO-comparison boundary (dividing by 1e6).
 *
 * Edge cases
 * ----------
 * - Empty input: there is no observed latency, so `percentile` returns `NaN`
 *   and `breachesSlo` returns `false` (no data => non-triggering). This matches
 *   the deployed monitor's `if (p == null) return false;` behaviour.
 * - Single element: the percentile is that element for every `p`.
 */

/** Lowest supported percentile (p50). */
export const MIN_PERCENTILE = 50;

/** Highest supported percentile (p99). */
export const MAX_PERCENTILE = 99;

/** Default percentile used when none is supplied (p95). */
export const DEFAULT_PERCENTILE = 95;

/**
 * Clamp a requested percentile into the supported `p50..p99` range.
 * Non-finite values fall back to the default (p95).
 */
function normalizePercentile(p: number): number {
  if (!Number.isFinite(p)) {
    return DEFAULT_PERCENTILE;
  }
  if (p < MIN_PERCENTILE) {
    return MIN_PERCENTILE;
  }
  if (p > MAX_PERCENTILE) {
    return MAX_PERCENTILE;
  }
  return p;
}

/**
 * Compute the `p`-th percentile of a set of span durations (in nanoseconds)
 * using linear interpolation between closest ranks (see module docs).
 *
 * @param durationsNanos Span durations in nanoseconds. Order does not matter;
 *                       the input is copied and sorted internally.
 * @param p              Percentile in `p50..p99` (clamped to that range).
 *                       Defaults to p95.
 * @returns The interpolated percentile value in nanoseconds, or `NaN` when the
 *          input is empty.
 */
export function percentile(
  durationsNanos: number[],
  p: number = DEFAULT_PERCENTILE
): number {
  if (durationsNanos.length === 0) {
    return NaN;
  }

  const sorted = [...durationsNanos].sort((a, b) => a - b);

  if (sorted.length === 1) {
    return sorted[0];
  }

  const pct = normalizePercentile(p);
  const rank = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const frac = rank - lo;

  if (frac === 0 || lo >= sorted.length - 1) {
    return sorted[lo];
  }

  return sorted[lo] + frac * (sorted[lo + 1] - sorted[lo]);
}

/**
 * Determine whether the selected latency percentile breaches the SLO.
 *
 * The breach condition converts the percentile from nanoseconds to
 * milliseconds (dividing by 1e6) and compares it strictly greater than the
 * configured threshold in milliseconds, matching the deployed monitor
 * (`return ms > params.thresholdMs;`).
 *
 * @param durationsNanos Span durations in nanoseconds.
 * @param p              Percentile in `p50..p99` (defaults to p95).
 * @param thresholdMs    Latency threshold in milliseconds.
 * @returns `true` iff `percentile(durationsNanos, p) / 1e6 > thresholdMs`.
 *          Returns `false` for an empty input set (no data => no breach).
 */
export function breachesSlo(
  durationsNanos: number[],
  p: number,
  thresholdMs: number
): boolean {
  return percentile(durationsNanos, p) / 1e6 > thresholdMs;
}
