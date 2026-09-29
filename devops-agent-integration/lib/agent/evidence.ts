/**
 * DevOps Agent evidence gathering with per-source bounded retry + continuation.
 *
 * Implements the evidence-gathering half of the DevOps Agent runbook-execution
 * engine (Component 6). For a given {@link RunbookEntry}, {@link gatherEvidence}
 * walks the investigation steps in ascending `order` (via `sortedSteps`),
 * invokes the generic maintained-server tool each step names (with that step's
 * `server`/`tool`/`args`), and assembles an {@link EvidenceBundleItem} per step:
 *
 * - On success the item is `{ status: "gathered", result }`.
 * - On an unreachable/failed source the retrieval is retried up to 3 times
 *   (bounded by {@link withRetry}); on exhaustion the item is
 *   `{ status: "retrieval_failed", failureDetail: { dataSource, attempts } }`
 *   and gathering CONTINUES with the remaining steps rather than aborting.
 *
 * This encodes Property 15 (Retry bound and continuation on failure): every
 * failing retrieval is attempted at most 3 times, the failure + affected data
 * source are recorded, and the remaining Evidence_Bundle elements are still
 * gathered.
 *
 * The reusable {@link withRetry} helper is exported so the monitor
 * query-failure path can share the identical bounded-retry semantics (retry up
 * to 3 times, then surface a failure so the caller can retain its previous
 * non-triggered state and emit a failure indication — R2.9, R2.10, R3.6).
 *
 * Tool invocation goes through the injected {@link McpInvoker} and all
 * inter-attempt delay is injectable, so this module is unit-testable with no
 * AWS calls and no wall-clock dependency.
 *
 * Requirements: R2.9, R2.10, R3.6, R5.5.
 */

import { sortedSteps } from "../runbook/store";
import type {
  EvidenceBundleItem,
  EvidenceQuery,
  McpInvoker,
  RunbookEntry,
} from "../types";

/** Default maximum number of retrieval attempts per source (R5.5, R2.9). */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Error thrown by {@link withRetry} once every attempt has failed. It carries
 * the number of attempts actually made and the last underlying error so callers
 * (e.g. {@link gatherEvidence}) can record `failureDetail.attempts` accurately.
 */
export class RetryExhaustedError extends Error {
  /** Number of attempts made before giving up (equals the attempt bound). */
  readonly attempts: number;
  /** The last error thrown by the wrapped function. */
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    super(
      `retry exhausted after ${attempts} attempt(s): ${errorMessage(lastError)}`
    );
    this.name = "RetryExhaustedError";
    this.attempts = attempts;
    this.lastError = lastError;
    // Restore the prototype chain (TS target < ES2015 downlevel safety).
    Object.setPrototypeOf(this, RetryExhaustedError.prototype);
  }
}

/** Injectable options controlling {@link withRetry} delay behavior. */
export interface WithRetryOptions {
  /**
   * Injected delay between attempts. Defaults to no delay so callers/tests run
   * deterministically with no wall-clock dependency; inject a real timer to
   * space out retries in production.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Backoff duration (ms) to wait before the retry that follows the given
   * 1-based failed `attempt`. Only consulted when {@link WithRetryOptions.sleep}
   * is provided. Defaults to `0` (immediate retry).
   */
  backoffMs?: (attempt: number) => number;
}

/**
 * Run `fn`, retrying on rejection up to `maxAttempts` total attempts.
 *
 * The function is invoked at least once and at most `maxAttempts` times (the
 * retrieval is "attempted at most 3 times" for the default bound). On the first
 * success the resolved value is returned. If every attempt rejects, a
 * {@link RetryExhaustedError} is thrown carrying the attempt count and the last
 * underlying error.
 *
 * Reused by both evidence gathering (R5.5) and the monitor query-failure path
 * (R2.9/R2.10/R3.6) so the retry bound is defined in exactly one place.
 *
 * @param fn the (async) operation to attempt
 * @param maxAttempts total attempt bound (>= 1); defaults to 3
 * @param opts injectable delay between attempts
 * @returns the first successful result of `fn`
 * @throws {RetryExhaustedError} when all attempts fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
  opts: WithRetryOptions = {}
): Promise<T> {
  // A bound below 1 would mean "never attempt"; clamp to at least one attempt.
  const attemptsBound = Math.max(1, Math.floor(maxAttempts));
  const { sleep, backoffMs } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attemptsBound; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Wait before the next attempt only when a delay was injected and there
      // is a further attempt to make.
      if (attempt < attemptsBound && sleep) {
        const delay = backoffMs ? backoffMs(attempt) : 0;
        await sleep(delay);
      }
    }
  }

  throw new RetryExhaustedError(attemptsBound, lastError);
}

/** Injectable options for {@link gatherEvidence}. */
export interface GatherEvidenceOptions {
  /** Per-source attempt bound. Defaults to {@link DEFAULT_MAX_ATTEMPTS} (3). */
  maxAttempts?: number;
  /** Injected inter-attempt delay (see {@link WithRetryOptions.sleep}). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected backoff schedule (see {@link WithRetryOptions.backoffMs}). */
  backoffMs?: (attempt: number) => number;
}

/**
 * Gather the Evidence_Bundle for a runbook entry.
 *
 * Steps are executed in ascending `order` (R4.1) via `sortedSteps`. For each
 * step the generic tool named by `step.query.tool` is invoked on
 * `step.query.server` with `step.query.args` through the injected
 * {@link McpInvoker} (no AWS calls happen here). A
 * failing/unreachable source is retried up to `maxAttempts` times (default 3);
 * on exhaustion a `retrieval_failed` item is recorded with the affected
 * `dataSource` and attempt count, and gathering CONTINUES with the remaining
 * steps (R5.5).
 *
 * The returned bundle has exactly one item per investigation step, in ascending
 * step order, so a downstream RCA finding can reference every element including
 * failed ones (R5.3).
 *
 * @param entry the runbook entry whose investigation steps to execute
 * @param invoke the injected generic maintained-server MCP invoker
 * @param opts injectable attempt bound and delay
 * @returns one {@link EvidenceBundleItem} per step, in ascending step order
 */
export async function gatherEvidence(
  entry: RunbookEntry,
  invoke: McpInvoker,
  opts: GatherEvidenceOptions = {}
): Promise<EvidenceBundleItem[]> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryOpts: WithRetryOptions = {
    sleep: opts.sleep,
    backoffMs: opts.backoffMs,
  };

  const bundle: EvidenceBundleItem[] = [];

  for (const step of sortedSteps(entry)) {
    const { server, tool, args, source } = step.query;

    try {
      const result = await withRetry(
        () => invokeTool(invoke, server, tool, args),
        maxAttempts,
        retryOpts
      );

      bundle.push({
        name: step.evidenceItem,
        source,
        status: "gathered",
        result,
      });
    } catch (err) {
      // Exhausted all retries for this source: record the failure + affected
      // data source and continue with the remaining steps (R5.5).
      const attempts =
        err instanceof RetryExhaustedError ? err.attempts : maxAttempts;

      bundle.push({
        name: step.evidenceItem,
        source,
        status: "retrieval_failed",
        failureDetail: { dataSource: source, attempts },
      });
    }
  }

  return bundle;
}

/**
 * Invoke the generic maintained-server MCP tool named `tool` on `server` with
 * `args`, through the injected {@link McpInvoker}.
 *
 * Any synchronous throw is normalized to a rejection so the failure is funneled
 * through {@link withRetry} like any other retrieval failure.
 */
function invokeTool(
  invoke: McpInvoker,
  server: EvidenceQuery["server"],
  tool: EvidenceQuery["tool"],
  args: Record<string, unknown>
): Promise<unknown> {
  try {
    return Promise.resolve(invoke({ server, tool, args }));
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
