/**
 * Monitor transition state machine (hysteresis + reset).
 *
 * Pure, AWS-free logic implementing the design's Property 4 — "Monitor transition
 * is a pure function of the latest evaluation (hysteresis + reset)" — and the
 * following requirements:
 *
 *  - R2.4: an evaluation that meets/exceeds the threshold transitions to triggered.
 *  - R2.6: a triggered monitor whose subsequent evaluation drops below the threshold
 *          transitions back to the non-triggered state (hysteresis round-trip).
 *  - R3.4: an AMP-style condition transitions to triggered only after the comparison
 *          holds continuously for at least one full evaluation interval.
 *  - R7.8: a cleared scenario (latest values fall below threshold) returns the monitor
 *          to the non-triggered baseline, enabling repeatable demos.
 */

import { Comparator } from "../types";

/**
 * Configuration for evaluating a sequence of monitor values.
 */
export interface MonitorStateConfig {
  /** Numeric threshold the evaluation value is compared against. */
  threshold: number;
  /** Comparison operator applied as `value <comparator> threshold`. */
  comparator: Comparator;
  /**
   * Number of consecutive satisfying evaluations required before a non-triggered
   * monitor transitions to triggered. OpenSearch monitors fire on the latest
   * qualifying evaluation (default `1`); an AMP-style condition that must hold for
   * one full interval uses a value `> 1`. Values `< 1` are treated as `1`.
   */
  requireSustainedIntervals?: number;
}

/**
 * Evaluate a single monitor value against a threshold using the given comparator.
 *
 * Returns `true` iff `latestValue` satisfies the comparison versus `threshold`
 * (R2.4). This is the atomic "does this evaluation qualify?" predicate the
 * transition reducer folds over.
 *
 * @param latestValue the most recent evaluation value
 * @param threshold the configured numeric threshold
 * @param comparator the comparison operator
 * @returns `true` iff the value satisfies the comparison
 */
export function evaluateState(
  latestValue: number,
  threshold: number,
  comparator: Comparator
): boolean {
  switch (comparator) {
    case "gt":
      return latestValue > threshold;
    case "gte":
      return latestValue >= threshold;
    case "lt":
      return latestValue < threshold;
    case "lte":
      return latestValue <= threshold;
    case "eq":
      return latestValue === threshold;
    case "neq":
      return latestValue !== threshold;
    default: {
      // Exhaustiveness guard: unknown comparators never trigger.
      const _exhaustive: never = comparator;
      return _exhaustive as unknown as boolean;
    }
  }
}

/**
 * Reduce a sequence of evaluation values to the monitor's final triggered state.
 *
 * The monitor is modelled as a small state machine folded over the evaluations in
 * order. It is triggered exactly when the most recent evaluation qualifies AND the
 * comparison has held for at least `requireSustainedIntervals` consecutive
 * evaluations. Any single non-qualifying evaluation immediately returns the monitor
 * to the non-triggered state and resets the sustained-interval counter, which gives:
 *
 *  - hysteresis round-trip: crossing above then below the threshold ends non-triggered;
 *  - AMP sustain semantics: a brief spike shorter than `requireSustainedIntervals`
 *    never transitions to triggered;
 *  - reset to baseline: a cleared sequence (latest values below threshold) is
 *    non-triggered.
 *
 * An empty sequence yields the non-triggered baseline (`false`).
 *
 * @param values ordered evaluation values (oldest first, most recent last)
 * @param config threshold, comparator, and optional sustained-interval requirement
 * @returns the final triggered state after processing every evaluation
 */
export function applySequence(
  values: number[],
  config: MonitorStateConfig
): boolean {
  const { threshold, comparator } = config;
  // At least one full interval is always required to transition to triggered.
  const requiredIntervals = Math.max(1, config.requireSustainedIntervals ?? 1);

  let triggered = false;
  let consecutiveSatisfying = 0;

  for (const value of values) {
    if (evaluateState(value, threshold, comparator)) {
      consecutiveSatisfying += 1;
      // Transition to triggered only once the comparison has held long enough;
      // once triggered, it stays triggered while evaluations keep qualifying.
      if (consecutiveSatisfying >= requiredIntervals) {
        triggered = true;
      }
    } else {
      // A non-qualifying evaluation resets to the non-triggered baseline (R2.6, R7.8).
      consecutiveSatisfying = 0;
      triggered = false;
    }
  }

  return triggered;
}
