/**
 * DevOps Agent runbook-execution engine — the orchestration half of Component 6.
 *
 * {@link executeRunbook} ties together the pieces built earlier:
 *
 * 1. **Lookup (R5.6):** resolve the fired alert's Runbook entry by
 *    `incident.data.monitorId` via {@link lookup}. When no entry exists the
 *    engine records a missing-runbook error and produces **no** RcaFinding —
 *    returning a distinct `missing_runbook` result variant.
 * 2. **Evidence gathering (R5.2, R5.5, R5.7):** for an entry, walk its
 *    investigation steps in ascending `order` and gather each step's
 *    Evidence_Bundle item through {@link gatherEvidence} (which itself bounds
 *    per-source retries to 3 and continues past failures). Each individual
 *    query is bounded by a per-query cap (≤60 s, R5.2) and the whole execution
 *    by an overall cap (≤300 s, R5.7). If either cap is exceeded the engine
 *    halts and emits exactly one RcaFinding flagged `timedOut:true` over the
 *    partial bundle gathered up to that point (Property 16 / R5.7).
 * 3. **RCA finding (R5.3):** produce exactly one {@link RcaFinding} whose
 *    `evidenceRefs` reference **every** Evidence_Bundle item (gathered *and*
 *    retrieval-failed), derive `candidateRootCauses` from the gathered item
 *    names via {@link deriveCandidateRootCauses}, select the first candidate (or
 *    a sensible default) as `selectedRootCause`, and record `unreachableSources`
 *    from the failed items (R5.5).
 * 4. **Remediation (R5.4):** surface the entry's remediation guidance
 *    **separately** from the RCA finding, as a distinct field on the result.
 *
 * The clock, per-query timeout race, retry delay, and MCP tool invocation are
 * all injectable, so this module is unit- and property-testable with no AWS
 * calls and no wall-clock dependency.
 *
 * Requirements: R5.1, R5.2, R5.3, R5.4, R5.6, R5.7.
 */

import { gatherEvidence } from "./evidence";
import { deriveCandidateRootCauses } from "../runbook/rca-mapping";
import { lookup, sortedSteps } from "../runbook/store";
import type {
  DevOpsAgentIncident,
  EvidenceBundleItem,
  McpInvoker,
  RcaFinding,
  RemediationAction,
  Runbook,
  RunbookEntry,
} from "../types";

/** Default overall runbook-execution cap in milliseconds (R5.7). */
export const DEFAULT_OVERALL_CAP_MS = 300_000;

/** Default per-query cap in milliseconds (R5.2). */
export const DEFAULT_PER_QUERY_CAP_MS = 60_000;

/** Default per-source retrieval attempt bound reused from evidence gathering (R5.5). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Selected root cause used when the RCA mapping yields no candidate causes
 * (e.g. every relevant source was unreachable, or execution timed out before
 * any qualifying evidence was gathered). Overridable via
 * {@link ExecuteRunbookOptions.defaultRootCause}.
 */
export const DEFAULT_ROOT_CAUSE = "undetermined — insufficient evidence gathered";

/**
 * Error used by the default per-query timeout race when a single query exceeds
 * its cap. Surfaced only internally; the engine converts it into a halt.
 */
export class QueryTimeoutError extends Error {
  /** The per-query cap (ms) that was exceeded. */
  readonly capMs: number;

  constructor(capMs: number) {
    super(`evidence query exceeded its ${capMs}ms cap`);
    this.name = "QueryTimeoutError";
    this.capMs = capMs;
    Object.setPrototypeOf(this, QueryTimeoutError.prototype);
  }
}

/**
 * Injectable timeout race: run `factory()` but reject (or otherwise stop
 * waiting) once `capMs` elapses. The default implementation races the promise
 * against a `setTimeout`-based rejection; tests inject a deterministic version
 * driven by a virtual clock.
 *
 * @returns the factory's resolved value if it settles before the cap
 * @throws when the cap elapses first (default throws {@link QueryTimeoutError})
 */
export type RaceTimeout = <T>(
  factory: () => Promise<T>,
  capMs: number
) => Promise<T>;

/** Injectable options for {@link executeRunbook}. All are optional. */
export interface ExecuteRunbookOptions {
  /** Injected monotonic-ish clock returning epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Overall execution cap in ms (R5.7). Defaults to {@link DEFAULT_OVERALL_CAP_MS}. */
  overallCapMs?: number;
  /** Per-query cap in ms (R5.2). Defaults to {@link DEFAULT_PER_QUERY_CAP_MS}. */
  perQueryCapMs?: number;
  /** Per-source retrieval attempt bound (R5.5). Defaults to {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Injected inter-attempt delay passed through to {@link gatherEvidence}. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected backoff schedule passed through to {@link gatherEvidence}. */
  backoffMs?: (attempt: number) => number;
  /** Injected per-query timeout race. Defaults to a `setTimeout`-based race. */
  raceTimeout?: RaceTimeout;
  /** Selected root cause when no candidate is derived. Defaults to {@link DEFAULT_ROOT_CAUSE}. */
  defaultRootCause?: string;
}

/**
 * Result when the fired alert has no associated Runbook entry (R5.6). No RCA
 * finding is produced; the missing-association error is recorded instead.
 */
export interface MissingRunbookResult {
  outcome: "missing_runbook";
  monitorId: string;
  /** The recorded missing-runbook error message (R5.6). */
  error: string;
  /** Always `null` — no RCA finding is produced when the runbook is missing (R5.6). */
  finding: null;
}

/**
 * Result when a Runbook entry was found and executed. Exactly one RCA finding
 * is produced; `outcome` is `timed_out` when a cap halted execution (R5.7),
 * otherwise `completed`. Remediation guidance is surfaced separately (R5.4).
 */
export interface ExecutedRunbookResult {
  outcome: "completed" | "timed_out";
  monitorId: string;
  /** Exactly one RCA finding referencing every gathered/failed item (R5.3). */
  finding: RcaFinding;
  /** Remediation guidance, surfaced SEPARATELY from the RCA finding (R5.4). */
  remediation: RemediationAction[];
  /** The Evidence_Bundle backing the finding (partial when timed out). */
  evidence: EvidenceBundleItem[];
}

/** Discriminated result of {@link executeRunbook}. */
export type ExecuteRunbookResult = MissingRunbookResult | ExecutedRunbookResult;

/**
 * Execute the Runbook associated with a fired alert and produce an RCA finding.
 *
 * Looks up the entry by `incident.data.monitorId`. If none exists, records the
 * missing-runbook error and produces no RCA finding (R5.6). Otherwise gathers
 * the Evidence_Bundle step-by-step (ascending `order`) under a per-query cap
 * (R5.2) and an overall cap (R5.7): if either cap is exceeded, execution halts
 * and a single `timedOut` RCA finding is produced over the partial bundle.
 * Either way exactly one RCA finding is produced, referencing every bundle item
 * (R5.3), with `candidateRootCauses` derived from the gathered item names and
 * `unreachableSources` recorded from the failed items (R5.5). Remediation
 * guidance is returned as a distinct field, separate from the finding (R5.4).
 *
 * @param incident the DevOps Agent incident payload delivered by the Signal_Bridge
 * @param runbook the machine-readable runbook to execute against
 * @param invoke the injected generic maintained-server MCP invoker used to gather evidence
 * @param opts injectable clock, caps, retry/timeout behavior, and default cause
 * @returns a {@link MissingRunbookResult} or an {@link ExecutedRunbookResult}
 */
export async function executeRunbook(
  incident: DevOpsAgentIncident,
  runbook: Runbook,
  invoke: McpInvoker,
  opts: ExecuteRunbookOptions = {}
): Promise<ExecuteRunbookResult> {
  const monitorId = incident.data.monitorId;

  // 1. Lookup by monitorId. Missing entry => record error, produce NO RCA (R5.6).
  const entry = lookup(runbook, monitorId);
  if (!entry) {
    return {
      outcome: "missing_runbook",
      monitorId,
      error: `no runbook entry associated with monitorId "${monitorId}"`,
      finding: null,
    };
  }

  const {
    now = Date.now,
    overallCapMs = DEFAULT_OVERALL_CAP_MS,
    perQueryCapMs = DEFAULT_PER_QUERY_CAP_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sleep,
    backoffMs,
    raceTimeout = defaultRaceTimeout,
    defaultRootCause = DEFAULT_ROOT_CAUSE,
  } = opts;

  // 2. Gather the Evidence_Bundle step-by-step under the per-query + overall caps.
  //    Execution begins immediately on receipt (R5.1); the start time anchors
  //    the overall 300 s cap (R5.7).
  const startedAtMs = now();
  const bundle: EvidenceBundleItem[] = [];
  let timedOut = false;

  // One InvestigationStep carries exactly one query, so bounding each single-step
  // gather is precisely the per-query cap (R5.2).
  for (const step of sortedSteps(entry)) {
    const elapsed = now() - startedAtMs;

    // Overall cap already reached: halt with the partial bundle (R5.7).
    if (elapsed >= overallCapMs) {
      timedOut = true;
      break;
    }

    // This query may run for at most the smaller of the per-query cap and the
    // remaining overall budget.
    const remainingOverall = overallCapMs - elapsed;
    const stepCapMs = Math.min(perQueryCapMs, remainingOverall);

    const singleStepEntry: RunbookEntry = {
      ...entry,
      investigationSteps: [step],
    };

    try {
      const items = await raceTimeout(
        () =>
          gatherEvidence(singleStepEntry, invoke, {
            maxAttempts,
            sleep,
            backoffMs,
          }),
        stepCapMs
      );
      // gatherEvidence returns one item per step; append it (gathered or failed).
      bundle.push(...items);
    } catch {
      // Per-query (or remaining-overall) cap exceeded: halt over the partial
      // bundle without recording the timed-out query as an item (R5.7 / Property 16).
      timedOut = true;
      break;
    }
  }

  // 3. Produce exactly one RCA finding referencing every bundle item (R5.3).
  const finding = buildRcaFinding(
    incident,
    entry,
    bundle,
    timedOut,
    defaultRootCause
  );

  return {
    outcome: timedOut ? "timed_out" : "completed",
    monitorId,
    finding,
    // 4. Remediation guidance surfaced separately from the RCA finding (R5.4).
    remediation: entry.remediation,
    evidence: bundle,
  };
}

/**
 * Assemble the single RCA finding from the gathered bundle.
 *
 * `evidenceRefs` covers EVERY item — gathered and retrieval-failed alike (R5.3).
 * `candidateRootCauses` is derived from the names of the successfully *gathered*
 * items via {@link deriveCandidateRootCauses} (R4.3). `selectedRootCause` is the
 * first candidate, or `defaultRootCause` when none apply. `unreachableSources`
 * lists the distinct data sources of the failed items (R5.5).
 */
function buildRcaFinding(
  incident: DevOpsAgentIncident,
  entry: RunbookEntry,
  bundle: EvidenceBundleItem[],
  timedOut: boolean,
  defaultRootCause: string
): RcaFinding {
  // Reference every element of the Evidence_Bundle, including failed items (R5.3).
  const evidenceRefs = bundle.map((item) => item.name);

  // Candidate causes derive only from the item names that were actually gathered.
  const gatheredNames = bundle
    .filter((item) => item.status === "gathered")
    .map((item) => item.name);
  const candidateRootCauses = deriveCandidateRootCauses(entry, gatheredNames);

  // Distinct, order-stable list of the data sources that were unreachable (R5.5).
  const unreachableSources = dedupe(
    bundle
      .filter((item) => item.status === "retrieval_failed")
      .map((item) => item.failureDetail?.dataSource ?? item.source)
  );

  return {
    incidentId: incident.incidentId,
    monitorId: entry.monitorId,
    evidenceRefs,
    candidateRootCauses,
    selectedRootCause: candidateRootCauses[0] ?? defaultRootCause,
    timedOut,
    unreachableSources,
  };
}

/** Return `values` with duplicates removed, preserving first-seen order. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/**
 * Default per-query timeout race: run `factory()` and race it against a
 * `setTimeout`-based rejection at `capMs`. The timer is cleared as soon as the
 * factory settles so no handle is left dangling.
 */
const defaultRaceTimeout: RaceTimeout = <T>(
  factory: () => Promise<T>,
  capMs: number
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueryTimeoutError(capMs)), capMs);
  });

  return Promise.race([factory(), timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
};
