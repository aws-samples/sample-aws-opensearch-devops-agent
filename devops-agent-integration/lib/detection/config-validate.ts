/**
 * Monitor config validation for the Alert_Monitor set.
 *
 * Pure, AWS-free logic implementing the evaluation-interval bounds and
 * threshold checks from the design's monitor config contract and Requirements
 * 2.8 and 3.3:
 * - Each Alert_Monitor SHALL define a measurable numeric threshold (R2.8, R3.3).
 * - OpenSearch monitors use an evaluation interval bounded between 1 minute and
 *   5 minutes inclusive, i.e. `evaluationIntervalSeconds` in [60, 300] (R2.8).
 * - AMP monitors use an evaluation interval >= 15 seconds and <= 5 minutes
 *   inclusive, i.e. `evaluationIntervalSeconds` in [15, 300] (R3.3).
 */

import { AlertMonitorConfig } from "../types";

/** Inclusive evaluation-interval bounds (seconds) for each monitor source. */
export const OPENSEARCH_INTERVAL_MIN_SECONDS = 60;
export const OPENSEARCH_INTERVAL_MAX_SECONDS = 300;
export const AMP_INTERVAL_MIN_SECONDS = 15;
export const AMP_INTERVAL_MAX_SECONDS = 300;

/** Result of validating a single {@link AlertMonitorConfig}. */
export interface MonitorConfigValidationResult {
  /** `true` iff the config satisfies every validation rule. */
  valid: boolean;
  /** Human-readable reasons for each violation; empty when `valid`. */
  errors: string[];
}

/**
 * Validate a single monitor config, enforcing:
 * - `threshold` is a finite number (R2.8, R3.3);
 * - for `source === "opensearch"`, `evaluationIntervalSeconds` in [60, 300] (R2.8);
 * - for `source === "amp"`, `evaluationIntervalSeconds` in [15, 300] (R3.3).
 *
 * The check is pure and performs no AWS calls.
 *
 * @param config the monitor config to validate
 * @returns a {@link MonitorConfigValidationResult} indicating validity plus any reasons
 */
export function validateMonitorConfig(
  config: AlertMonitorConfig
): MonitorConfigValidationResult {
  const errors: string[] = [];

  // Threshold must be a finite number (rejects NaN, +/-Infinity). (R2.8, R3.3)
  if (typeof config.threshold !== "number" || !Number.isFinite(config.threshold)) {
    errors.push(
      `threshold must be a finite number, got ${String(config.threshold)}`
    );
  }

  // Evaluation-interval bounds depend on the source system.
  const interval = config.evaluationIntervalSeconds;
  if (typeof interval !== "number" || !Number.isFinite(interval)) {
    errors.push(
      `evaluationIntervalSeconds must be a finite number, got ${String(interval)}`
    );
  } else if (config.source === "opensearch") {
    if (
      interval < OPENSEARCH_INTERVAL_MIN_SECONDS ||
      interval > OPENSEARCH_INTERVAL_MAX_SECONDS
    ) {
      errors.push(
        `opensearch evaluationIntervalSeconds must be within [${OPENSEARCH_INTERVAL_MIN_SECONDS}, ${OPENSEARCH_INTERVAL_MAX_SECONDS}], got ${interval}`
      );
    }
  } else if (config.source === "amp") {
    if (
      interval < AMP_INTERVAL_MIN_SECONDS ||
      interval > AMP_INTERVAL_MAX_SECONDS
    ) {
      errors.push(
        `amp evaluationIntervalSeconds must be within [${AMP_INTERVAL_MIN_SECONDS}, ${AMP_INTERVAL_MAX_SECONDS}], got ${interval}`
      );
    }
  } else {
    // Defensive: an unknown source cannot be bounds-checked.
    errors.push(`unknown monitor source: ${String(config.source)}`);
  }

  return { valid: errors.length === 0, errors };
}
