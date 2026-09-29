/**
 * Signal_Bridge delivery with capped exponential-backoff retry.
 *
 * Implements `deliverWithRetry`: it repeatedly POSTs the signed DevOps Agent
 * incident payload to the agent webhook over TLS until an HTTP 200 is received
 * or a caller-provided deadline (default 120 000 ms from a start time) passes.
 *
 * Requirements:
 * - R1.4: when an alert fires, the Signal_Bridge delivers it to DevOps_Agent
 *   within 120 seconds. Success is `delivered:true` iff a 200 arrives before
 *   the deadline; otherwise `delivered:false` with a `failureReason`.
 * - R6.4 / R6.5: delivery is over TLS; a non-HTTPS URL is rejected and no data
 *   is transmitted.
 * - R6.6: each attempt is HMAC-signed (fresh timestamp) via {@link signHmac} and
 *   carries the `x-amzn-event-timestamp` / `x-amzn-event-signature` headers.
 *
 * The clock and transport are injected so tests run pure, with no real AWS,
 * network, or wall-clock dependencies.
 */

import { signHmac } from "./hmac";
import type { DeliveryResult, DevOpsAgentIncident } from "../types";

/** Response shape returned by the injected transport. */
export interface TransportResponse {
  status: number;
}

/**
 * Injected transport: POST `body` with `headers` to `url`, resolving to the
 * HTTP status. Rejections are treated as a failed attempt and retried.
 */
export type Transport = (
  url: string,
  body: string,
  headers: Record<string, string>
) => Promise<TransportResponse>;

/** Options for {@link deliverWithRetry}. Clock, transport, and delay are injectable. */
export interface DeliveryOptions {
  /** The DevOps Agent webhook URL. MUST be an `https://` URL (TLS, R6.4/R6.5). */
  url: string;
  /** Shared webhook HMAC key used to sign each attempt (R6.6). */
  secret: string;
  /** Injected monotonic-ish clock returning epoch milliseconds. */
  now: () => number;
  /** Injected HTTPS transport. Never called for a non-HTTPS URL. */
  post: Transport;
  /**
   * Total delivery deadline in milliseconds, measured from `startTimeMs`.
   * Defaults to 120 000 ms (R1.4). Property tests drive this directly.
   */
  deadlineMs?: number;
  /** Start time (epoch ms) the deadline is measured from. Defaults to `now()`. */
  startTimeMs?: number;
  /**
   * Injected delay used between attempts. Defaults to a real timer; tests
   * supply a pure implementation (e.g. one that advances a virtual clock).
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Fresh timestamp provider used as the signed prefix + `x-amzn-event-timestamp`
   * header on each attempt. Defaults to the ISO-8601 rendering of `now()`.
   */
  timestampProvider?: () => string;
  /** Base backoff delay in ms (first retry). Defaults to 1000 ms. */
  baseDelayMs?: number;
  /** Cap on the exponential backoff delay in ms. Defaults to 30 000 ms. */
  maxDelayMs?: number;
}

const DEFAULT_DEADLINE_MS = 120_000;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Real-timer delay used when no `sleep` is injected. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Capped exponential backoff: `min(maxDelayMs, baseDelayMs * 2^(attempt-1))`.
 * `attempt` is 1-based (the delay applied after the first failed attempt).
 */
function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const raw = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(maxDelayMs, raw);
}

/**
 * Deliver a signed HTTPS POST of `payload`, retrying with capped exponential
 * backoff until a 200 is received or the deadline passes.
 *
 * TLS enforcement (R6.5): if `url` is not an `https://` URL the connection is
 * rejected and the transport is never invoked, so no data is transmitted.
 *
 * @param payload the DevOps Agent incident payload to deliver
 * @param opts injected clock/transport/delay plus URL, secret, and deadline
 * @returns a {@link DeliveryResult}: `delivered:true` with `httpStatus:200` on
 *   success, else `delivered:false` with a `failureReason`
 */
export async function deliverWithRetry(
  payload: DevOpsAgentIncident,
  opts: DeliveryOptions
): Promise<DeliveryResult> {
  const monitorId = payload.data.monitorId;
  const {
    url,
    secret,
    now,
    post,
    deadlineMs = DEFAULT_DEADLINE_MS,
    startTimeMs = now(),
    sleep = defaultSleep,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    timestampProvider = () => new Date(now()).toISOString(),
  } = opts;

  // TLS enforcement: reject a non-HTTPS URL up front and transmit nothing (R6.5).
  if (!isHttpsUrl(url)) {
    return {
      delivered: false,
      monitorId,
      attempt: 0,
      failureReason: "TLS required: refusing to deliver to a non-HTTPS URL",
    };
  }

  // Serialize once: the payload does not change between attempts (only the
  // per-attempt timestamp/signature do), and the exact bytes are what we sign.
  const body = JSON.stringify(payload);

  let attempt = 0;
  let lastFailureReason = "no delivery attempt was made before the deadline";

  const elapsed = (): number => now() - startTimeMs;

  while (true) {
    // Respect the deadline before starting another attempt (R1.4).
    if (elapsed() >= deadlineMs) {
      return {
        delivered: false,
        monitorId,
        attempt,
        failureReason: `delivery deadline of ${deadlineMs}ms exceeded (${lastFailureReason})`,
      };
    }

    attempt += 1;

    // Sign this attempt with a fresh timestamp (R6.6).
    const timestamp = timestampProvider();
    const signature = signHmac(body, secret, timestamp);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-amzn-event-timestamp": timestamp,
      "x-amzn-event-signature": signature,
    };

    try {
      const response = await post(url, body, headers);
      if (response.status === 200) {
        return { delivered: true, httpStatus: 200, monitorId, attempt };
      }
      lastFailureReason = `received non-200 HTTP status ${response.status}`;
    } catch (err) {
      lastFailureReason = `transport error: ${errorMessage(err)}`;
    }

    // Compute the capped exponential backoff for the next attempt.
    const delay = backoffDelayMs(attempt, baseDelayMs, maxDelayMs);

    // If waiting the full backoff would reach/exceed the deadline, stop now
    // rather than sleeping past it.
    if (elapsed() + delay >= deadlineMs) {
      return {
        delivered: false,
        monitorId,
        attempt,
        failureReason: `delivery deadline of ${deadlineMs}ms exceeded (${lastFailureReason})`,
      };
    }

    await sleep(delay);
  }
}

/** True iff `url` parses as an `https:` URL (TLS transport, R6.4/R6.5). */
function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
