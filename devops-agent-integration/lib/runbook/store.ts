/**
 * Runbook store — pure lookup helpers over a machine-readable {@link Runbook}.
 *
 * Implements the read side of Component 4 ("Runbook Store") from the design and
 * the "Runbook coverage and lookup" property (Property 13): every Alert_Monitor
 * identifier maps to exactly one entry keyed by `monitorId`, `lookup(id)` returns
 * that single entry, and `lookup(unknownId)` returns `undefined` — the signal the
 * DevOps Agent uses to detect the missing-runbook case and produce zero RCA
 * findings (R5.6).
 *
 * These functions are pure: they perform no I/O and make no AWS calls. Schema and
 * remediation-gating validation (task 5.4) and RCA mapping (task 5.6) live in
 * separate modules and are intentionally out of scope here.
 *
 * Requirements: R4.1, R4.5, R4.6, R5.6.
 */

import { InvestigationStep, Runbook, RunbookEntry } from "../types";

/**
 * Look up the single Runbook entry for an Alert_Monitor identifier.
 *
 * The Runbook is keyed by `monitorId` (R4.1, R4.6), so each identifier addresses
 * exactly one entry (R4.5). When no entry exists for the given identifier this
 * returns `undefined`, which the agent treats as the missing-runbook case: it
 * records the missing-runbook error and produces no RCA finding (R5.6).
 *
 * @param runbook the machine-readable runbook to search
 * @param monitorId the Alert_Monitor identifier / runbook key
 * @returns the matching {@link RunbookEntry}, or `undefined` when absent
 */
export function lookup(
  runbook: Runbook,
  monitorId: string
): RunbookEntry | undefined {
  // Guard against inherited/prototype keys: only own enumerable keys of the
  // `entries` record count as real runbook entries.
  if (!Object.prototype.hasOwnProperty.call(runbook.entries, monitorId)) {
    return undefined;
  }

  return runbook.entries[monitorId];
}

/**
 * Return an entry's investigation steps ordered by ascending `order`.
 *
 * The DevOps Agent executes investigation steps in ascending `order` (R4.1).
 * This returns a new array sorted stably by `order` without mutating the input
 * entry or its `investigationSteps` array; steps that share the same `order`
 * retain their original relative position (stable sort).
 *
 * @param entry the runbook entry whose steps to order
 * @returns a new array of {@link InvestigationStep} sorted ascending by `order`
 */
export function sortedSteps(entry: RunbookEntry): InvestigationStep[] {
  // Copy first so the caller's array is never mutated. Array.prototype.sort is
  // guaranteed stable per the ECMAScript spec, so equal `order` values keep
  // their input ordering.
  return [...entry.investigationSteps].sort((a, b) => a.order - b.order);
}
