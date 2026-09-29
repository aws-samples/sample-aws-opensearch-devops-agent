/**
 * Deterministic RCA mapping — derives candidate root causes for a fired alert by
 * applying a {@link RunbookEntry}'s `rcaMapping` rules against the set of
 * Evidence_Bundle item names that were gathered.
 *
 * Implements the RCA-guidance side of Component 4 ("Runbook Store") from the
 * design and the "RCA mapping determinism" property (Property 18):
 *
 *   For any set of Evidence_Bundle items, applying the Runbook's RCA mapping
 *   yields a deterministic candidate-root-cause list, and that list is non-empty
 *   whenever at least one mapping rule's pattern is satisfied.
 *
 * A rule's pattern is satisfied when **all** of its `evidenceItems` are present
 * in the provided evidence-item set (a conjunctive match). Satisfied rules
 * contribute their `candidateRootCauses`, which are then de-duplicated while
 * preserving first-seen order — walking rules in array order, and each rule's
 * causes in array order. This makes the output a pure, deterministic function of
 * the inputs: identical inputs always produce an identical ordering (R4.3).
 *
 * This function is pure: it performs no I/O and makes no AWS calls. It does not
 * mutate the entry or the provided evidence-item list.
 *
 * Requirements: R4.3.
 */

import { RunbookEntry } from "../types";

/**
 * Derive the deterministic, de-duplicated list of candidate root causes for an
 * incident from a runbook entry's RCA mapping and the evidence items gathered.
 *
 * Each {@link RcaRule} contributes its `candidateRootCauses` iff every one of the
 * rule's `evidenceItems` appears in `evidenceItems` (all-present conjunction).
 * Results are accumulated in rule array order, and within each rule in cause
 * array order, then de-duplicated so each root cause appears once at its
 * first-seen position. The list is non-empty whenever at least one rule is
 * satisfied (assuming satisfied rules name at least one candidate cause, per
 * R4.3's "one or more" guarantee).
 *
 * @param entry the runbook entry whose `rcaMapping` rules to apply
 * @param evidenceItems the names of the Evidence_Bundle items that were gathered
 * @returns a deterministic, order-stable, de-duplicated list of candidate root causes
 */
export function deriveCandidateRootCauses(
  entry: RunbookEntry,
  evidenceItems: string[]
): string[] {
  // Membership set for O(1) "is this evidence item present?" checks. Building a
  // Set does not affect ordering of the output, which is driven solely by the
  // rule/cause array order below.
  const present = new Set(evidenceItems);

  // Preserve first-seen order while de-duplicating: `seen` guards against
  // repeats, `result` holds the order-stable output.
  const seen = new Set<string>();
  const result: string[] = [];

  for (const rule of entry.rcaMapping) {
    // A rule fires only when ALL of its required evidence items are present.
    // An empty `evidenceItems` array trivially satisfies `every`, so such a
    // rule always contributes — consistent with "no required evidence".
    const satisfied = rule.evidenceItems.every((item) => present.has(item));
    if (!satisfied) {
      continue;
    }

    for (const cause of rule.candidateRootCauses) {
      if (!seen.has(cause)) {
        seen.add(cause);
        result.push(cause);
      }
    }
  }

  return result;
}
