/**
 * Deploy-time handler for the {@link MonitorsDeployment} custom resource.
 *
 * Invoked by the CDK {@link cr.Provider} on Create/Update/Delete. On Create/Update it:
 *   1. Creates or references an OpenSearch Notifications channel (type SNS) pointing
 *      at the Signal_Bridge topic and returns its `config_id`.
 *   2. Substitutes each monitor's `<sns-notification-channel-id>` placeholder with
 *      that `config_id` and upserts the monitor via `_plugins/_alerting/monitors`.
 *   3. Applies the AMP rule group namespace (`PutRuleGroupsNamespace`) and the
 *      Alertmanager definition (`PutAlertManagerDefinition`), rewriting the receiver
 *      `topic_arn` to the Signal_Bridge topic.
 * On Delete it best-effort removes what it created so stack teardown is not blocked.
 *
 * The handler is deliberately free of any `@aws-sdk/*` dependency: it signs both the
 * OpenSearch (`es`) and AMP (`aps`) REST calls with a small SigV4 v4 signer built only
 * on node `https` + `crypto`, using the Lambda role credentials exposed in the
 * standard `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN`
 * environment variables. This keeps the file typecheck-clean without installing the
 * SDK (matching the repo convention in `lib/signal-bridge/handler.ts`).
 *
 * _Requirements: 2.5, 3.5_
 */

import * as https from "https";
import * as crypto from "crypto";
import { URL } from "url";

// ---------------------------------------------------------------------------
// Event / response shapes (minimal — avoids an @types/aws-lambda dependency).
// ---------------------------------------------------------------------------

interface CfnCustomResourceEvent {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, string>;
}

interface OnEventResponse {
  PhysicalResourceId: string;
  Data?: Record<string, string>;
}

interface MonitorDefinition {
  name: string;
  body: string;
}

interface SigV4Request {
  method: "GET" | "POST" | "PUT" | "DELETE";
  host: string;
  path: string; // already URL-encoded path (no query)
  service: "es" | "aps";
  region: string;
  query?: Record<string, string>;
  body?: string;
  headers?: Record<string, string>;
}

interface HttpResponse {
  statusCode: number;
  body: string;
}

const PLACEHOLDER = "<sns-notification-channel-id>";

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export async function onEvent(
  event: CfnCustomResourceEvent,
): Promise<OnEventResponse> {
  const props = event.ResourceProperties;
  const physicalId =
    event.PhysicalResourceId ?? `monitors-deploy-${props.DomainEndpoint}`;

  if (event.RequestType === "Delete") {
    await handleDelete(props).catch((err) => {
      // Best-effort teardown: never block stack deletion on a cleanup failure.
      console.error("Delete cleanup encountered an error (ignored):", err);
    });
    return { PhysicalResourceId: physicalId };
  }

  const channelId = await ensureNotificationChannel(props);
  await deployOpenSearchMonitors(props, channelId);
  await deployAmpRuleGroup(props);
  await deployAlertManager(props);

  return {
    PhysicalResourceId: physicalId,
    Data: { NotificationChannelId: channelId },
  };
}

// ---------------------------------------------------------------------------
// OpenSearch Notifications channel (type SNS).
// ---------------------------------------------------------------------------

/**
 * Create or reference an OpenSearch Notifications SNS channel targeting the
 * Signal_Bridge topic and return its `config_id`. Idempotent: if a channel with the
 * configured name already exists it is reused.
 */
async function ensureNotificationChannel(
  props: Record<string, string>,
): Promise<string> {
  const host = props.DomainEndpoint;
  const region = props.Region;
  const channelName = props.NotificationChannelName;

  // Reuse an existing channel with the same name if present.
  const existing = await sigv4Request({
    method: "GET",
    host,
    path: "/_plugins/_notifications/configs",
    service: "es",
    region,
    query: { config_type: "sns", "query": channelName },
  });
  if (existing.statusCode >= 200 && existing.statusCode < 300) {
    const parsed = safeJson(existing.body);
    const items: any[] = parsed?.config_list ?? [];
    const match = items.find(
      (item) => item?.config?.name === channelName,
    );
    if (match?.config_id) {
      return match.config_id as string;
    }
  }

  const sns: Record<string, string> = { topic_arn: props.SnsTopicArn };
  if (props.SnsNotificationRoleArn) {
    sns.role_arn = props.SnsNotificationRoleArn;
  }
  const createBody = JSON.stringify({
    config: {
      name: channelName,
      description: "Signal_Bridge SNS channel for DevOps Agent alerts.",
      config_type: "sns",
      is_enabled: true,
      sns,
    },
  });

  const created = await sigv4Request({
    method: "POST",
    host,
    path: "/_plugins/_notifications/configs",
    service: "es",
    region,
    body: createBody,
    headers: { "content-type": "application/json" },
  });
  if (created.statusCode < 200 || created.statusCode >= 300) {
    throw new Error(
      `Failed to create Notifications channel (status ${created.statusCode}): ${created.body}`,
    );
  }
  const configId = safeJson(created.body)?.config_id;
  if (!configId) {
    throw new Error(
      `Notifications channel create returned no config_id: ${created.body}`,
    );
  }
  return configId as string;
}

// ---------------------------------------------------------------------------
// OpenSearch Alerting monitors.
// ---------------------------------------------------------------------------

/**
 * Upsert every OpenSearch Alerting monitor, substituting the channel-id placeholder
 * with the real Notifications channel id first.
 */
async function deployOpenSearchMonitors(
  props: Record<string, string>,
  channelId: string,
): Promise<void> {
  const host = props.DomainEndpoint;
  const region = props.Region;
  const monitors: MonitorDefinition[] = JSON.parse(props.OpenSearchMonitors);

  for (const monitor of monitors) {
    const body = monitor.body.split(PLACEHOLDER).join(channelId);
    const existingId = await findMonitorId(host, region, monitor.name);

    if (existingId) {
      const put = await sigv4Request({
        method: "PUT",
        host,
        path: `/_plugins/_alerting/monitors/${encodeURIComponent(existingId)}`,
        service: "es",
        region,
        body,
        headers: { "content-type": "application/json" },
      });
      if (put.statusCode < 200 || put.statusCode >= 300) {
        throw new Error(
          `Failed to update monitor ${monitor.name} (status ${put.statusCode}): ${put.body}`,
        );
      }
    } else {
      const post = await sigv4Request({
        method: "POST",
        host,
        path: "/_plugins/_alerting/monitors",
        service: "es",
        region,
        body,
        headers: { "content-type": "application/json" },
      });
      if (post.statusCode < 200 || post.statusCode >= 300) {
        throw new Error(
          `Failed to create monitor ${monitor.name} (status ${post.statusCode}): ${post.body}`,
        );
      }
    }
  }
}

/** Return the id of an existing monitor by name, or `undefined`. */
async function findMonitorId(
  host: string,
  region: string,
  name: string,
): Promise<string | undefined> {
  const search = await sigv4Request({
    method: "POST",
    host,
    path: "/_plugins/_alerting/monitors/_search",
    service: "es",
    region,
    body: JSON.stringify({ query: { term: { "monitor.name.keyword": name } } }),
    headers: { "content-type": "application/json" },
  });
  if (search.statusCode < 200 || search.statusCode >= 300) {
    return undefined;
  }
  const hits = safeJson(search.body)?.hits?.hits ?? [];
  return hits.length > 0 ? (hits[0]._id as string) : undefined;
}

// ---------------------------------------------------------------------------
// AMP rule group namespace + Alertmanager definition.
// ---------------------------------------------------------------------------

/** Apply the AMP rule group namespace, creating it or updating it if it exists. */
async function deployAmpRuleGroup(
  props: Record<string, string>,
): Promise<void> {
  const region = props.Region;
  const host = `aps.${region}.amazonaws.com`;
  const workspaceId = props.AmpWorkspaceId;
  const name = props.RuleGroupNamespaceName;
  const dataB64 = Buffer.from(props.RuleGroupYaml, "utf8").toString("base64");
  const basePath = `/workspaces/${encodeURIComponent(workspaceId)}/rulegroupsnamespaces`;

  // Create first; on conflict (already exists) fall back to Put (update).
  const create = await sigv4Request({
    method: "POST",
    host,
    path: basePath,
    service: "aps",
    region,
    body: JSON.stringify({
      name,
      data: dataB64,
      clientToken: clientToken(),
    }),
    headers: { "content-type": "application/json" },
  });

  if (create.statusCode >= 200 && create.statusCode < 300) {
    return;
  }
  if (create.statusCode !== 409) {
    throw new Error(
      `Failed to create AMP rule group (status ${create.statusCode}): ${create.body}`,
    );
  }

  const put = await sigv4Request({
    method: "PUT",
    host,
    path: `${basePath}/${encodeURIComponent(name)}`,
    service: "aps",
    region,
    body: JSON.stringify({ data: dataB64, clientToken: clientToken() }),
    headers: { "content-type": "application/json" },
  });
  if (put.statusCode < 200 || put.statusCode >= 300) {
    throw new Error(
      `Failed to update AMP rule group (status ${put.statusCode}): ${put.body}`,
    );
  }
}

/**
 * Apply the AMP Alertmanager definition, rewriting the SNS receiver `topic_arn` to
 * the Signal_Bridge topic. Creates it or updates it if it already exists.
 */
async function deployAlertManager(
  props: Record<string, string>,
): Promise<void> {
  const region = props.Region;
  const host = `aps.${region}.amazonaws.com`;
  const workspaceId = props.AmpWorkspaceId;
  const yaml = rewriteTopicArn(props.AlertManagerYaml, props.SnsTopicArn);
  const dataB64 = Buffer.from(yaml, "utf8").toString("base64");
  const defPath = `/workspaces/${encodeURIComponent(workspaceId)}/alertmanager/definition`;

  const create = await sigv4Request({
    method: "POST",
    host,
    path: defPath,
    service: "aps",
    region,
    body: JSON.stringify({ data: dataB64, clientToken: clientToken() }),
    headers: { "content-type": "application/json" },
  });

  if (create.statusCode >= 200 && create.statusCode < 300) {
    return;
  }
  if (create.statusCode !== 409) {
    throw new Error(
      `Failed to create AMP Alertmanager definition (status ${create.statusCode}): ${create.body}`,
    );
  }

  const put = await sigv4Request({
    method: "PUT",
    host,
    path: defPath,
    service: "aps",
    region,
    body: JSON.stringify({ data: dataB64 }),
    headers: { "content-type": "application/json" },
  });
  if (put.statusCode < 200 || put.statusCode >= 300) {
    throw new Error(
      `Failed to update AMP Alertmanager definition (status ${put.statusCode}): ${put.body}`,
    );
  }
}

/** Rewrite the `topic_arn:` value in the Alertmanager YAML to the given topic ARN. */
function rewriteTopicArn(yaml: string, topicArn: string): string {
  return yaml.replace(
    /topic_arn:\s*\S+/g,
    `topic_arn: ${topicArn}`,
  );
}

// ---------------------------------------------------------------------------
// Delete (best-effort teardown).
// ---------------------------------------------------------------------------

async function handleDelete(props: Record<string, string>): Promise<void> {
  const host = props.DomainEndpoint;
  const region = props.Region;

  // Delete each monitor by name if present.
  const monitors: MonitorDefinition[] = JSON.parse(
    props.OpenSearchMonitors ?? "[]",
  );
  for (const monitor of monitors) {
    const id = await findMonitorId(host, region, monitor.name).catch(
      () => undefined,
    );
    if (id) {
      await sigv4Request({
        method: "DELETE",
        host,
        path: `/_plugins/_alerting/monitors/${encodeURIComponent(id)}`,
        service: "es",
        region,
      }).catch(() => undefined);
    }
  }

  // Delete the AMP rule group namespace and Alertmanager definition.
  const ampHost = `aps.${region}.amazonaws.com`;
  const workspaceId = props.AmpWorkspaceId;
  await sigv4Request({
    method: "DELETE",
    host: ampHost,
    path: `/workspaces/${encodeURIComponent(workspaceId)}/rulegroupsnamespaces/${encodeURIComponent(
      props.RuleGroupNamespaceName,
    )}`,
    service: "aps",
    region,
  }).catch(() => undefined);
  await sigv4Request({
    method: "DELETE",
    host: ampHost,
    path: `/workspaces/${encodeURIComponent(workspaceId)}/alertmanager/definition`,
    service: "aps",
    region,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// SigV4 signer + HTTPS transport (node crypto + https only).
// ---------------------------------------------------------------------------

/** Sign and send a single request with AWS Signature Version 4 over TLS. */
async function sigv4Request(req: SigV4Request): Promise<HttpResponse> {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing AWS credentials in the Lambda environment.");
  }

  const now = new Date();
  const amzDate = toAmzDate(now); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8); // YYYYMMDD
  const payload = req.body ?? "";
  const payloadHash = sha256Hex(payload);

  const canonicalQuery = buildCanonicalQuery(req.query ?? {});

  const baseHeaders: Record<string, string> = {
    host: req.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(sessionToken ? { "x-amz-security-token": sessionToken } : {}),
    ...normalizeHeaderKeys(req.headers ?? {}),
  };

  const sortedHeaderKeys = Object.keys(baseHeaders).sort();
  const canonicalHeaders =
    sortedHeaderKeys
      .map((k) => `${k}:${String(baseHeaders[k]).trim()}\n`)
      .join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    req.method,
    req.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = deriveSigningKey(
    secretAccessKey,
    dateStamp,
    req.region,
    req.service,
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const requestHeaders: Record<string, string> = {
    ...baseHeaders,
    Authorization: authorization,
  };
  if (payload.length > 0) {
    requestHeaders["content-length"] = Buffer.byteLength(payload).toString();
  }

  const url = new URL(`https://${req.host}${req.path}`);
  if (canonicalQuery.length > 0) {
    url.search = canonicalQuery;
  }

  return httpsSend(url, req.method, requestHeaders, payload);
}

/** Perform the HTTPS request and buffer the response body. */
function httpsSend(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (body.length > 0) {
      request.write(body);
    }
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function hmac(key: crypto.BinaryLike, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

/** Build the canonical, RFC-3986-encoded, key-sorted query string. */
function buildCanonicalQuery(query: Record<string, string>): string {
  const keys = Object.keys(query).sort();
  return keys
    .map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`)
    .join("&");
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Lower-case header keys so they sort/sign deterministically. */
function normalizeHeaderKeys(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function clientToken(): string {
  return crypto.randomUUID();
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
