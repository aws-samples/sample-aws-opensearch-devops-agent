/**
 * Signal_Bridge translator Lambda handler.
 *
 * Consumes the SNS notifications a fired Alert_Monitor emits, normalizes each into
 * the DevOps Agent generic-webhook incident payload, signs it, and delivers it to
 * the agent webhook within the 120 s deadline. On delivery failure it records a
 * delivery-failure indication (identifying the affected `monitorId`) and rethrows
 * so the SNS/Lambda invocation fails and the message is returned to the SQS DLQ for
 * redelivery.
 *
 * Requirements:
 * - R1.4: deliver a fired alert within 120 seconds (delegated to {@link deliverWithRetry}).
 * - R1.5: on non-delivery, record a delivery-failure indication identifying the
 *   Alert_Monitor and retain the undelivered alert for redelivery. This is achieved
 *   by {@link recordDeliveryFailure} plus throwing, which returns the message to the
 *   SQS DLQ (redrive) rather than acknowledging it.
 * - R1.6: the delivered payload carries `monitorId`, triggering condition, incident
 *   timestamp, and the runbook reference (delegated to {@link buildAgentPayload}).
 *
 * The AWS-specific pieces (Secrets Manager fetch, the HTTPS transport, the clock)
 * are injected via {@link HandlerConfig} so the core handler runs pure in tests with
 * no AWS calls. {@link parseEnvelope} and {@link recordDeliveryFailure} are exported
 * for direct unit/property testing.
 */

import * as https from "https";

import { buildAgentPayload } from "./payload";
import { deliverWithRetry, type Transport } from "./delivery";
import { REGION, type DeliveryResult, type SnsAlertEnvelope } from "../types";

// ---------------------------------------------------------------------------
// SNS event shape (minimal, dependency-free)
// ---------------------------------------------------------------------------

/**
 * Minimal record shape. The Lambda has two event sources:
 *  - the SNS topic (records carry `Sns.Message`), and
 *  - the SQS DLQ redrive (records carry `body`, whose payload is the original async
 *    SNS event JSON that failed to deliver — see {@link resolveRecordMessage}).
 * Only these fields are consumed, so we avoid a hard dependency on `@types/aws-lambda`.
 */
export interface SnsEventRecord {
  Sns?: {
    Message: string;
    [key: string]: unknown;
  };
  /** Present on SQS redrive records (the DLQ event source). */
  body?: string;
  [key: string]: unknown;
}

/** Minimal event shape delivered to the Lambda (SNS invocation or SQS redrive). */
export interface SnsEvent {
  Records: SnsEventRecord[];
}

/**
 * Resolve the raw alert-message string from a record, transparently handling both
 * event sources wired to this Lambda:
 *
 *  - SNS invocation: the message is `record.Sns.Message`.
 *  - SQS DLQ redrive: when an async invocation fails, Lambda writes the *original*
 *    event payload to the DLQ, so `record.body` is the JSON of the original SNS
 *    event (`{ "Records": [ { "Sns": { "Message": ... } } ] }`). We unwrap it back to
 *    the inner `Sns.Message`. As a fallback (e.g. a producer that enqueued a bare
 *    message), the body is treated as the message string itself.
 *
 * This makes the R1.5 redelivery loop actually redeliver instead of crashing on an
 * absent `Sns` field.
 *
 * @param record an SNS or SQS-redrive record
 * @returns the raw alert-message string to hand to {@link parseEnvelope}
 * @throws when no message string can be recovered from the record
 */
export function resolveRecordMessage(record: SnsEventRecord): string {
  if (record.Sns && typeof record.Sns.Message === "string") {
    return record.Sns.Message;
  }

  if (typeof record.body === "string") {
    try {
      const inner = JSON.parse(record.body);
      if (isRecord(inner) && Array.isArray(inner["Records"])) {
        const innerRecord = inner["Records"][0];
        if (
          isRecord(innerRecord) &&
          isRecord(innerRecord["Sns"]) &&
          typeof innerRecord["Sns"]["Message"] === "string"
        ) {
          return innerRecord["Sns"]["Message"] as string;
        }
      }
    } catch {
      // fall through: treat the body as a bare message string.
    }
    return record.body;
  }

  throw new Error(
    "unsupported record: expected an SNS record (Sns.Message) or an SQS redrive record (body)"
  );
}

/**
 * A parsed alert envelope. It is a superset of {@link SnsAlertEnvelope} that may
 * additionally carry a `runbookRef` extracted from the monitor's notification (the
 * OpenSearch/AMP message templates embed `runbook=...`). When absent, the handler
 * derives the default `runbook://${monitorId}`.
 */
export type ParsedEnvelope = SnsAlertEnvelope & { runbookRef?: string };

// ---------------------------------------------------------------------------
// Webhook secret retrieval (cached, injectable AWS fetch)
// ---------------------------------------------------------------------------

/** Injectable secret fetch. The default implementation reads Secrets Manager. */
export type SecretFetcher = () => Promise<string>;

/** Module-level cache for the webhook HMAC secret (reused across warm invocations). */
let cachedSecret: string | undefined;

/**
 * Return the webhook HMAC secret, fetching it once via `fetch` and caching the
 * result for subsequent invocations. The fetch is injectable so the AWS-specific
 * Secrets Manager call stays out of the pure core and out of tests.
 *
 * @param fetch the secret fetcher to use on a cache miss
 * @returns the webhook HMAC secret string
 */
export async function getWebhookSecret(fetch: SecretFetcher): Promise<string> {
  if (cachedSecret === undefined) {
    cachedSecret = await fetch();
  }
  return cachedSecret;
}

/**
 * Reset the cached webhook secret. Intended for tests that exercise the cache; not
 * used on the Lambda hot path.
 */
export function __resetWebhookSecretCache(): void {
  cachedSecret = undefined;
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

/**
 * Parse the SNS `Message` string into a {@link ParsedEnvelope}.
 *
 * Three encodings are accepted:
 * 1. A JSON object with a top-level `monitorId` (and optionally
 *    `triggeringCondition`/`condition`, `incidentTimestamp`/`ts`/`timestamp`,
 *    `runbookRef`/`runbook`, `seedEvidence`). Emitted by the OpenSearch monitors.
 * 2. The AMP Alertmanager JSON payload — a JSON object with an `alerts` array whose
 *    first entry carries `labels.monitorId` and `annotations.runbookRef`/
 *    `annotations.triggeringCondition` (+ `startsAt` for the incident timestamp).
 * 3. The compact `key=value` notification template, e.g.
 *    `monitorId=M-logs-error-rate condition=error-rate>=5% ts=... runbook=runbook://M-logs-error-rate`.
 *
 * @param message the raw SNS message body
 * @returns the parsed alert envelope
 * @throws when the message carries no recoverable `monitorId` in any known encoding
 */
export function parseEnvelope(message: string): ParsedEnvelope {
  const trimmed = message.trim();

  const asJson = tryParseJsonEnvelope(trimmed);
  if (asJson) {
    return asJson;
  }

  const asAlertmanager = tryParseAlertmanagerEnvelope(trimmed);
  if (asAlertmanager) {
    return asAlertmanager;
  }

  const asKv = tryParseKvEnvelope(trimmed);
  if (asKv) {
    return asKv;
  }

  throw new Error(
    "malformed SNS alert message: expected a top-level-monitorId JSON object, an Alertmanager alerts[] JSON payload, or a key=value string carrying a monitorId"
  );
}

/**
 * Attempt to parse `message` as an AMP Alertmanager notification payload.
 *
 * The AMP Alertmanager SNS integration emits a JSON object shaped like
 * `{ "status": "firing", "alerts": [ { "labels": { "monitorId": ... },
 * "annotations": { "runbookRef": ..., "triggeringCondition": ... },
 * "startsAt": ... } ] }`. Unlike the OpenSearch encoding the `monitorId` lives on
 * `alerts[0].labels`, so {@link tryParseJsonEnvelope} (which looks only at the top
 * level) returns null and we recover it here.
 *
 * Returns null when the payload is not JSON, has no `alerts` array, or the first
 * alert carries no `monitorId` label.
 */
function tryParseAlertmanagerEnvelope(message: string): ParsedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed["alerts"])) {
    return null;
  }

  const firstAlert = parsed["alerts"][0];
  if (!isRecord(firstAlert)) {
    return null;
  }

  const labels = isRecord(firstAlert["labels"]) ? firstAlert["labels"] : {};
  const annotations = isRecord(firstAlert["annotations"])
    ? firstAlert["annotations"]
    : {};

  const monitorId = firstString(labels, ["monitorId", "monitor_id"]);
  if (monitorId === undefined || monitorId.length === 0) {
    return null;
  }

  const triggeringCondition =
    firstString(annotations, ["triggeringCondition", "condition"]) ?? "";
  const incidentTimestamp =
    firstString(firstAlert, ["startsAt", "incidentTimestamp", "ts", "timestamp"]) ??
    "";
  const runbookRef = firstString(annotations, ["runbookRef", "runbook"]);

  return {
    monitorId,
    triggeringCondition,
    incidentTimestamp,
    ...(runbookRef !== undefined ? { runbookRef } : {}),
  };
}

/** Attempt to parse `message` as a JSON incident envelope; return null if it isn't one. */
function tryParseJsonEnvelope(message: string): ParsedEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const monitorId = firstString(parsed, ["monitorId", "monitor_id"]);
  if (monitorId === undefined) {
    return null;
  }

  const triggeringCondition =
    firstString(parsed, ["triggeringCondition", "condition"]) ?? "";
  const incidentTimestamp =
    firstString(parsed, ["incidentTimestamp", "ts", "timestamp"]) ?? "";
  const runbookRef = firstString(parsed, ["runbookRef", "runbook"]);
  const seedEvidence = isRecord(parsed["seedEvidence"])
    ? (parsed["seedEvidence"] as Record<string, unknown>)
    : undefined;

  return {
    monitorId,
    triggeringCondition,
    incidentTimestamp,
    ...(seedEvidence !== undefined ? { seedEvidence } : {}),
    ...(runbookRef !== undefined ? { runbookRef } : {}),
  };
}

/** Attempt to parse `message` as a compact `key=value` template; return null if it has no monitorId. */
function tryParseKvEnvelope(message: string): ParsedEnvelope | null {
  const map: Record<string, string> = {};
  for (const token of message.split(/\s+/)) {
    if (token.length === 0) {
      continue;
    }
    const eq = token.indexOf("=");
    if (eq > 0) {
      map[token.slice(0, eq)] = token.slice(eq + 1);
    }
  }

  const monitorId = map["monitorId"] ?? map["monitor_id"];
  if (monitorId === undefined || monitorId.length === 0) {
    return null;
  }

  const triggeringCondition =
    map["triggeringCondition"] ?? map["condition"] ?? "";
  const incidentTimestamp =
    map["incidentTimestamp"] ?? map["ts"] ?? map["timestamp"] ?? "";
  const runbookRef = map["runbookRef"] ?? map["runbook"];

  return {
    monitorId,
    triggeringCondition,
    incidentTimestamp,
    ...(runbookRef !== undefined ? { runbookRef } : {}),
  };
}

/** True iff `value` is a non-null object (and not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Return the first key in `keys` whose value on `rec` is a string, else undefined. */
function firstString(
  rec: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Delivery-failure recording (R1.5)
// ---------------------------------------------------------------------------

/**
 * Record a delivery-failure indication for an undelivered alert (R1.5).
 *
 * Logs a structured delivery-failure record to CloudWatch Logs that identifies the
 * affected `monitorId` along with the attempt count and failure reason. This is the
 * "record a delivery-failure indication identifying the affected Alert_Monitor" half
 * of R1.5; the handler completes R1.5 by rethrowing so the message is retained in
 * the SQS DLQ for redelivery.
 *
 * @param result the failed {@link DeliveryResult} to record
 */
export function recordDeliveryFailure(result: DeliveryResult): void {
  // Structured, machine-parseable log line keyed by monitorId for CloudWatch queries.
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      event: "delivery_failure",
      monitorId: result.monitorId,
      attempt: result.attempt,
      httpStatus: result.httpStatus,
      failureReason: result.failureReason,
    })
  );
}

// ---------------------------------------------------------------------------
// Handler wiring
// ---------------------------------------------------------------------------

/** Injectable configuration for the handler core (keeps AWS/network/clock out of tests). */
export interface HandlerConfig {
  /** The DevOps Agent webhook URL (must be `https://`). */
  webhookUrl: string;
  /** Fetches the webhook HMAC secret (cached via {@link getWebhookSecret}). */
  getSecret: SecretFetcher;
  /** HTTPS transport used by {@link deliverWithRetry}. */
  post: Transport;
  /** Injected clock (epoch ms). Defaults to {@link Date.now}. */
  now?: () => number;
  /** Total delivery deadline in ms. Defaults to the delivery layer's 120 000 ms. */
  deadlineMs?: number;
}

/**
 * Build the pure handler core from injected dependencies.
 *
 * For each SNS record it parses the envelope, derives the runbook reference
 * (`env.runbookRef ?? runbook://${monitorId}`), builds the incident payload, and
 * delivers it with retry. On the first non-delivered record it records the failure
 * and throws (`undelivered:${monitorId}`) so the message is redriven to the DLQ.
 *
 * @param config injected webhook URL, secret fetcher, transport, clock, and deadline
 * @returns an async Lambda-style handler over an {@link SnsEvent}
 */
export function createHandler(
  config: HandlerConfig
): (event: SnsEvent) => Promise<void> {
  return async function handler(event: SnsEvent): Promise<void> {
    const secret = await getWebhookSecret(config.getSecret);

    for (const record of event.Records) {
      const env = parseEnvelope(resolveRecordMessage(record));
      const runbookRef = env.runbookRef ?? `runbook://${env.monitorId}`;
      const payload = buildAgentPayload(env, runbookRef);

      const result = await deliverWithRetry(payload, {
        url: config.webhookUrl,
        secret,
        now: config.now ?? Date.now,
        post: config.post,
        ...(config.deadlineMs !== undefined ? { deadlineMs: config.deadlineMs } : {}),
      });

      if (!result.delivered) {
        // R1.5: record the delivery-failure indication (identifies monitorId) ...
        recordDeliveryFailure(result);
        // ... and rethrow so the message returns to the SQS DLQ for redelivery.
        throw new Error(`undelivered:${env.monitorId}`);
      }

      // Structured success line so a delivered alert is observable in CloudWatch
      // (keyed by monitorId, mirrors the delivery_failure record).
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          event: "delivered",
          monitorId: env.monitorId,
          httpStatus: result.httpStatus,
          attempt: result.attempt,
        })
      );
    }
  };
}

// ---------------------------------------------------------------------------
// Default (AWS-wired) handler
// ---------------------------------------------------------------------------

/**
 * Read a required environment variable, throwing a descriptive error when absent.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Create the default Secrets Manager-backed secret fetcher.
 *
 * The AWS SDK v3 is provided by the Node.js 20 Lambda runtime, so it is required
 * lazily at call time. Keeping it behind this injectable means the pure handler
 * core and its tests need no AWS dependency.
 *
 * @param secretId the ARN/name of the webhook HMAC secret
 * @param region the region hosting the secret
 * @returns a {@link SecretFetcher} that reads `SecretString` from Secrets Manager
 */
export function createSecretsManagerFetcher(
  secretId: string,
  region: string
): SecretFetcher {
  return async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sdk = require("@aws-sdk/client-secrets-manager");
    const client = new sdk.SecretsManagerClient({ region });
    const response = await client.send(
      new sdk.GetSecretValueCommand({ SecretId: secretId })
    );
    if (typeof response.SecretString !== "string") {
      throw new Error("webhook secret has no SecretString value");
    }
    return response.SecretString;
  };
}

/**
 * Default HTTPS transport backed by Node's `https` module. Resolves to the response
 * status; rejections are treated as a failed attempt by {@link deliverWithRetry}.
 */
export function defaultHttpsTransport(): Transport {
  return (url, body, headers) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const request = https.request(
        {
          hostname: target.hostname,
          port: target.port.length > 0 ? Number(target.port) : 443,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          headers: {
            ...headers,
            "content-length": Buffer.byteLength(body).toString(),
          },
        },
        (response) => {
          // Drain the response so the socket can be reused/closed.
          response.on("data", () => undefined);
          response.on("end", () => resolve({ status: response.statusCode ?? 0 }));
        }
      );
      request.on("error", reject);
      request.write(body);
      request.end();
    });
}

/** Resolve the default handler configuration from environment variables + AWS. */
function resolveDefaultConfig(): HandlerConfig {
  const webhookUrl = requireEnv("WEBHOOK_URL");
  const secretId = requireEnv("WEBHOOK_SECRET_ARN");
  const region = process.env["AWS_REGION"] ?? REGION;

  return {
    webhookUrl,
    getSecret: createSecretsManagerFetcher(secretId, region),
    post: defaultHttpsTransport(),
  };
}

/**
 * Lambda entry point. Wires the default AWS-backed configuration and delegates to
 * the pure handler core.
 */
export async function handler(event: SnsEvent): Promise<void> {
  return createHandler(resolveDefaultConfig())(event);
}
