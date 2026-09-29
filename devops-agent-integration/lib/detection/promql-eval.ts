/**
 * PromQL threshold comparison semantics for the AMP monitor (M-amp-promql).
 *
 * Pure, AWS-free logic implementing the PromQL threshold comparison from the
 * design and Requirement 3.2: a PromQL-based condition defines a numeric
 * threshold expressed as a finite decimal value paired with a comparison
 * operator (one of: greater than, greater than or equal to, less than, less
 * than or equal to, equal to, not equal to). The AMP condition evaluates to
 * triggered if and only if the metric value relates to the threshold according
 * to that comparator.
 */

import { Comparator } from "../types";

/**
 * Compare a metric `value` against a finite decimal `threshold` using the
 * given {@link Comparator}, returning whether the AMP condition is satisfied
 * (triggered).
 *
 * Comparisons are exact against the numeric operands:
 * - `gt`  => `value > threshold`
 * - `gte` => `value >= threshold`
 * - `lt`  => `value < threshold`
 * - `lte` => `value <= threshold`
 * - `eq`  => `value === threshold` (strict numeric equality)
 * - `neq` => `value !== threshold` (strict numeric inequality)
 *
 * @param value the observed metric value
 * @param comparator the comparison operator to apply
 * @param threshold the finite decimal threshold to compare against
 * @returns `true` iff `value` relates to `threshold` per `comparator`
 */
export function compare(
  value: number,
  comparator: Comparator,
  threshold: number
): boolean {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    case "neq":
      return value !== threshold;
    default: {
      // Exhaustiveness guard: if a new Comparator is added to the type without
      // being handled here, this produces a compile-time error.
      const _exhaustive: never = comparator;
      throw new Error(`Unsupported comparator: ${String(_exhaustive)}`);
    }
  }
}
