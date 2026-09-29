/**
 * Runbook schema + remediation-gating validation — pure validation over a
 * machine-readable {@link Runbook}.
 *
 * Implements the validation side of Component 4 ("Runbook Store") from the
 * design. It enforces the invariants the DevOps Agent relies on at runtime:
 *
 *  - Coverage (R4.6): every Alert_Monitor in the monitored set has exactly one
 *    Runbook entry, and each entry is keyed by its own `monitorId` (R4.1/R4.5).
 *  - Investigation steps (R4.2): every step names a `source`, a `tool`, and the
 *    `evidenceItem` its results populate. Under the Path 2 generic maintained-
 *    tool contract, every OpenSearch step (`server:"opensearch"`) must also
 *    carry an explicit `index`, and any time-ranged OpenSearch query must name
 *    its `timeField`.
 *  - Remediation (R4.4): every action carries a non-empty `description` and an
 *    observable `postRemediationResolutionState`.
 *  - Remediation gating (Property 17, R4.7/R4.8): an action requires
 *    confirmation iff it mutates the demo, and is auto-executable iff it does
 *    not — i.e. `requiresConfirmation === mutatesDemo` and
 *    `autoExecutable === !mutatesDemo`.
 *
 * All violations are collected (no short-circuit) so a single call surfaces the
 * complete set of problems. This function is pure: it performs no I/O and makes
 * no AWS calls.
 *
 * Requirements: R4.2, R4.4, R4.6, R4.7, R4.8.
 */

import {
  RemediationAction,
  Runbook,
  RunbookEntry,
} from "../types";

/** Result of validating a {@link Runbook} against a monitored set. */
export interface RunbookValidationResult {
  /** True iff no violations were found. */
  valid: boolean;
  /** Every violation found, in a stable, human-readable form (no short-circuit). */
  errors: string[];
}

/** A source is present when it is a non-empty, non-whitespace string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A query is "time-ranged" when its DSL body contains a `range` clause anywhere
 * (the standard OpenSearch way to bound a query to a time window). Time-ranged
 * OpenSearch steps must name their `timeField` under the Path 2 generic-tool
 * contract; non-time-ranged tools (e.g. `ListIndexTool`, `IndexMappingTool`,
 * `GetShardsTool`) carry no range clause and need no time field.
 */
function queryIsTimeRanged(args: unknown): boolean {
  if (args === null || typeof args !== "object") {
    return false;
  }
  if (Array.isArray(args)) {
    return args.some((element) => queryIsTimeRanged(element));
  }
  for (const [propKey, value] of Object.entries(args as Record<string, unknown>)) {
    if (propKey === "range" && value !== null && typeof value === "object") {
      return true;
    }
    if (queryIsTimeRanged(value)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a machine-readable Runbook against the set of Alert_Monitor
 * identifiers it must cover.
 *
 * The validation is exhaustive: it walks the full coverage relationship and
 * every entry, step, and remediation action, accumulating a violation message
 * for each failed check rather than stopping at the first one.
 *
 * Coverage (R4.6) is checked in both directions:
 *  - every `monitorId` in `monitorIds` must have exactly one entry, and
 *  - each entry's key must equal its `monitorId` (R4.1/R4.5).
 *
 * @param runbook the machine-readable runbook to validate
 * @param monitorIds the Alert_Monitor identifiers that must each be covered
 * @returns a {@link RunbookValidationResult} with `valid` and all `errors`
 */
export function validateRunbook(
  runbook: Runbook,
  monitorIds: string[]
): RunbookValidationResult {
  const errors: string[] = [];

  const entries = runbook.entries ?? {};
  const entryKeys = Object.keys(entries);

  // --- Coverage (R4.6): every monitored id has exactly one entry ---------
  // Duplicate monitorIds in the input set are de-duplicated for coverage so a
  // repeated id is not double-counted as a missing entry.
  const seen = new Set<string>();
  for (const monitorId of monitorIds) {
    if (seen.has(monitorId)) {
      continue;
    }
    seen.add(monitorId);

    if (!Object.prototype.hasOwnProperty.call(entries, monitorId)) {
      errors.push(`Coverage: no runbook entry for monitor "${monitorId}".`);
    }
  }

  // --- Coverage (R4.1/R4.5): each entry's key must match its monitorId ----
  for (const key of entryKeys) {
    const entry = entries[key];
    if (entry.monitorId !== key) {
      errors.push(
        `Coverage: entry keyed "${key}" has mismatched monitorId "${entry.monitorId}".`
      );
    }
  }

  // --- Per-entry structural checks ---------------------------------------
  for (const key of entryKeys) {
    validateEntry(entries[key], key, errors);
  }

  return { valid: errors.length === 0, errors };
}

/** Validate a single entry's investigation steps and remediation actions. */
function validateEntry(
  entry: RunbookEntry,
  key: string,
  errors: string[]
): void {
  // --- Investigation steps (R4.2): source + tool + evidenceItem ----------
  entry.investigationSteps.forEach((step, index) => {
    const label = `entry "${key}" step ${index} (order ${step.order})`;
    if (!isNonEmptyString(step.query?.source)) {
      errors.push(`R4.2: ${label} is missing a query source.`);
    }
    if (!isNonEmptyString(step.query?.tool)) {
      errors.push(`R4.2: ${label} is missing a query tool.`);
    }
    if (!isNonEmptyString(step.evidenceItem)) {
      errors.push(`R4.2: ${label} is missing an evidenceItem.`);
    }

    // --- Generic maintained-tool contract (Path 2): OpenSearch steps must
    //     carry an explicit target index (no implicit index), and any
    //     time-ranged OpenSearch query must name its time field. ----------
    if (step.query?.server === "opensearch") {
      if (!isNonEmptyString(step.query.index)) {
        errors.push(
          `R4.2: ${label} on the OpenSearch MCP server is missing an explicit index.`
        );
      }
      if (queryIsTimeRanged(step.query.args) && !isNonEmptyString(step.query.timeField)) {
        errors.push(
          `R4.2: ${label} is a time-ranged OpenSearch query but is missing a timeField.`
        );
      }
    }
  });

  // --- Remediation actions (R4.4 + gating R4.7/R4.8) ---------------------
  entry.remediation.forEach((action, index) => {
    validateRemediation(action, key, index, errors);
  });
}

/** Validate a single remediation action for content and gating invariants. */
function validateRemediation(
  action: RemediationAction,
  key: string,
  index: number,
  errors: string[]
): void {
  const label = `entry "${key}" remediation ${index} ("${action.actionId}")`;

  // R4.4: non-empty description and observable post-remediation state.
  if (!isNonEmptyString(action.description)) {
    errors.push(`R4.4: ${label} is missing a description.`);
  }
  if (!isNonEmptyString(action.postRemediationResolutionState)) {
    errors.push(
      `R4.4: ${label} is missing a postRemediationResolutionState.`
    );
  }

  // R4.7: confirmation gate must match mutation.
  if (action.requiresConfirmation !== action.mutatesDemo) {
    errors.push(
      `R4.7: ${label} requiresConfirmation (${action.requiresConfirmation}) must equal mutatesDemo (${action.mutatesDemo}).`
    );
  }

  // R4.8: auto-executability must be the inverse of mutation.
  if (action.autoExecutable !== !action.mutatesDemo) {
    errors.push(
      `R4.8: ${label} autoExecutable (${action.autoExecutable}) must equal !mutatesDemo (${!action.mutatesDemo}).`
    );
  }
}
