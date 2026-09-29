/**
 * FGAC role-mapping custom-resource Lambda handler.
 *
 * At deploy time this handler maps the MCP AgentCore Runtime execution role ARN
 * into a **read-only FGAC role** on the `obs-stack` OpenSearch domain, so the MCP
 * server's SigV4 requests are authorized inside OpenSearch security (design:
 * "FGAC role mapping on the domain"; R6.1/R6.3/R6.6).
 *
 * It drives the OpenSearch security plugin API over TLS + SigV4:
 *   1. `PUT _plugins/_security/api/roles/<roleName>` — create/update a scoped read
 *      role restricted to the three index patterns (`logs-otel-v1*`,
 *      `otel-v1-apm-span*`, `otel-v2-apm-service-map*`) with `read`/`search` +
 *      `indices:data/read/*` index permissions and cluster monitor permissions.
 *   2. `PUT _plugins/_security/api/rolesmapping/<roleName>` — map the FGAC role's
 *      `backend_roles` to the MCP execution role ARN.
 * Both use `PUT`, which is create-or-update, so the operation is **idempotent**.
 *
 * AUTHENTICATION AS THE FGAC MASTER
 * ---------------------------------
 * The domain's FGAC master is IAM `role/Admin`. The security API only accepts
 * calls from a security-admin identity, so this handler signs as the FGAC master
 * one of two ways (selected by the construct via env vars):
 *   - **Run-as** (default): the Lambda's own execution role *is* the FGAC master
 *     (or a role mapped as security admin). SigV4 uses the Lambda's role
 *     credentials from the standard environment (`AWS_ACCESS_KEY_ID` etc.).
 *   - **Assume**: when `MASTER_ROLE_ARN` is set, the handler assumes that role via
 *     STS first and signs with the returned temporary credentials. This keeps the
 *     Lambda's own execution role least-privilege while still signing as the master.
 *
 * The AWS SDK is only referenced lazily (for the optional STS assume) and is
 * provided by the Node.js 20 Lambda runtime, so the pure signing/request core has
 * no external dependency and can be reasoned about in isolation. SigV4 is
 * implemented with Node's built-in `crypto` to avoid adding SDK dependencies to
 * the CDK project.
 *
 * _Requirements: 6.1, 6.3, 6.6_
 */

import * as https from "https";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// CloudFormation custom-resource event shapes (dependency-free)
// ---------------------------------------------------------------------------

/** The subset of the CFN custom-resource event this handler consumes. */
export interface OnEventRequest {
  RequestType: "Create" | "Update" | "Delete";
  PhysicalResourceId?: string;
  ResourceProperties?: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

/** The response the CDK Provider framework expects from an onEvent handler. */
export interface OnEventResponse {
  PhysicalResourceId: string;
  Data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SigV4 credentials + minimal signer (Node `crypto`, no AWS SDK)
// ---------------------------------------------------------------------------

/** AWS credentials used to SigV4-sign a request. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** An HTTP request to be SigV4-signed and sent over TLS. */
export interface SignableRequest {
  method: "GET" | "PUT" | "POST" | "DELETE";
  /** Absolute `https://` URL (path only; this handler builds no query strings). */
  url: string;
  service: string; // "es" for the OpenSearch domain
  region: string;
  body?: string;
  headers?: Record<string, string>;
}

/** Raw HTTP response returned by the transport. */
export interface RawResponse {
  statusCode: number;
  body: string;
}

const EMPTY_SHA256 = crypto.createHash("sha256").update("").digest("hex");

function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/** Two-part timestamp (`amzDate`, `dateStamp`) SigV4 requires. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

/**
 * Compute SigV4 headers (including `Authorization`) for `req`, signing with
 * `creds` at time `now`. Pure and dependency-free so it can be tested directly.
 */
export function signSigV4(
  req: SignableRequest,
  creds: AwsCredentials,
  now: Date
): Record<string, string> {
  const url = new URL(req.url);
  const { amzDate, dateStamp } = amzDates(now);

  const payloadHash = req.body ? sha256Hex(req.body) : EMPTY_SHA256;

  // Header set to sign: host + x-amz-date (+ security token when present) plus any
  // caller-supplied headers (e.g. content-type). Keys are lower-cased and sorted.
  const baseHeaders: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(creds.sessionToken ? { "x-amz-security-token": creds.sessionToken } : {}),
    ...lowerCaseHeaders(req.headers),
  };

  const sortedKeys = Object.keys(baseHeaders).sort();
  const canonicalHeaders =
    sortedKeys.map((k) => `${k}:${baseHeaders[k].trim()}`).join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");

  // This handler never uses query strings on signed requests.
  const canonicalQuery = url.search ? canonicalizeQuery(url.searchParams) : "";

  const canonicalRequest = [
    req.method,
    url.pathname,
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

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, req.region);
  const kService = hmac(kRegion, req.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization =
    `${algorithm} Credential=${creds.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...baseHeaders, authorization };
}

function lowerCaseHeaders(
  headers?: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function canonicalizeQuery(params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  params.forEach((value, key) => pairs.push([key, value]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return pairs
    .map(
      ([k, v]) =>
        `${encodeURIComponent(k)}=${encodeURIComponent(v)}`.replace(
          /[!'()*]/g,
          (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
        )
    )
    .join("&");
}

// ---------------------------------------------------------------------------
// Transport (injectable; defaults to Node `https` over TLS)
// ---------------------------------------------------------------------------

/** Signs `req` with `creds` and sends it over TLS, resolving to the raw response. */
export type SignedTransport = (
  req: SignableRequest,
  creds: AwsCredentials,
  now: Date
) => Promise<RawResponse>;

/** Default TLS transport: SigV4-sign with `crypto`, then POST/PUT via `https`. */
export function defaultSignedTransport(): SignedTransport {
  return (req, creds, now) =>
    new Promise<RawResponse>((resolve, reject) => {
      const url = new URL(req.url);
      if (url.protocol !== "https:") {
        reject(new Error(`TLS required: refusing non-HTTPS request to ${req.url}`));
        return;
      }

      const headers = signSigV4(req, creds, now);
      const body = req.body ?? "";

      const request = https.request(
        {
          hostname: url.hostname,
          port: url.port.length > 0 ? Number(url.port) : 443,
          path: `${url.pathname}${url.search}`,
          method: req.method,
          headers: {
            ...headers,
            ...(body.length > 0
              ? { "content-length": Buffer.byteLength(body).toString() }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      );
      request.on("error", reject);
      if (body.length > 0) {
        request.write(body);
      }
      request.end();
    });
}

// ---------------------------------------------------------------------------
// Read-only FGAC role + role-mapping bodies (design: "FGAC role mapping")
// ---------------------------------------------------------------------------

/** Build the scoped read-only FGAC role document for the given index patterns. */
export function buildReadOnlyRole(indexPatterns: string[]): Record<string, unknown> {
  return {
    description:
      "Read-only role for the DevOps Agent MCP evidence server (logs/traces/service-map).",
    // Cluster monitor permissions are needed for _search coordination + health.
    cluster_permissions: ["cluster_composite_ops_ro", "cluster:monitor/*"],
    index_permissions: [
      {
        index_patterns: indexPatterns,
        allowed_actions: ["read", "search", "indices:data/read/*"],
      },
    ],
    tenant_permissions: [],
  };
}

/** Build the rolesmapping body that maps the FGAC role to the MCP role ARN. */
export function buildRoleMapping(
  mcpExecutionRoleArn: string
): Record<string, unknown> {
  return {
    backend_roles: [mcpExecutionRoleArn],
    hosts: [],
    users: [],
  };
}

// ---------------------------------------------------------------------------
// Config resolution + core apply/delete logic
// ---------------------------------------------------------------------------

/** Resolved configuration the core logic operates on. */
export interface FgacConfig {
  domainEndpoint: string; // host or https URL of the domain
  region: string;
  fgacRoleName: string;
  mcpExecutionRoleArn: string;
  indexPatterns: string[];
  masterRoleArn?: string; // when set, assume this role before signing
}

const DEFAULT_INDEX_PATTERNS = [
  "logs-otel-v1*",
  "otel-v1-apm-span*",
  "otel-v2-apm-service-map*",
];

/** Normalize a domain endpoint (host or URL) to an `https://` base with no trailing slash. */
export function normalizeEndpoint(endpoint: string): string {
  const withScheme = endpoint.startsWith("http") ? endpoint : `https://${endpoint}`;
  return withScheme.endsWith("/") ? withScheme.slice(0, -1) : withScheme;
}

/** Resolve {@link FgacConfig} from the custom-resource properties + environment. */
export function resolveConfig(props: Record<string, unknown>): FgacConfig {
  const domainEndpoint = requireString(props, "DomainEndpoint");
  const mcpExecutionRoleArn = requireString(props, "McpExecutionRoleArn");
  const fgacRoleName =
    optionalString(props, "FgacRoleName") ?? "devops_agent_mcp_readonly";
  const indexPatterns = parsePatterns(props["IndexPatterns"]);
  const region =
    optionalString(props, "Region") ?? process.env["AWS_REGION"] ?? "ap-southeast-2";
  const masterRoleArn =
    optionalString(props, "MasterRoleArn") ?? emptyToUndefined(process.env["MASTER_ROLE_ARN"]);

  return {
    domainEndpoint: normalizeEndpoint(domainEndpoint),
    region,
    fgacRoleName,
    mcpExecutionRoleArn,
    indexPatterns: indexPatterns.length > 0 ? indexPatterns : DEFAULT_INDEX_PATTERNS,
    ...(masterRoleArn ? { masterRoleArn } : {}),
  };
}

/** A stable physical id for the custom resource (bound to domain + role name). */
export function physicalId(config: FgacConfig): string {
  const host = new URL(config.domainEndpoint).host;
  return `fgac-mapping:${host}:${config.fgacRoleName}`;
}

/**
 * Apply the read-only role and its role-mapping via the security API (idempotent
 * create-or-update). Throws with the response body when the domain returns a
 * non-2xx status so the deployment surfaces the failure.
 */
export async function applyMapping(
  config: FgacConfig,
  creds: AwsCredentials,
  transport: SignedTransport,
  now: Date = new Date()
): Promise<void> {
  const roleUrl = `${config.domainEndpoint}/_plugins/_security/api/roles/${encodeURIComponent(config.fgacRoleName)}`;
  const mappingUrl = `${config.domainEndpoint}/_plugins/_security/api/rolesmapping/${encodeURIComponent(config.fgacRoleName)}`;

  await putJson(roleUrl, buildReadOnlyRole(config.indexPatterns), config, creds, transport, now);
  await putJson(mappingUrl, buildRoleMapping(config.mcpExecutionRoleArn), config, creds, transport, now);
}

/** Delete the role-mapping and role on stack deletion (best-effort). */
export async function deleteMapping(
  config: FgacConfig,
  creds: AwsCredentials,
  transport: SignedTransport,
  now: Date = new Date()
): Promise<void> {
  const roleUrl = `${config.domainEndpoint}/_plugins/_security/api/roles/${encodeURIComponent(config.fgacRoleName)}`;
  const mappingUrl = `${config.domainEndpoint}/_plugins/_security/api/rolesmapping/${encodeURIComponent(config.fgacRoleName)}`;

  // Remove the mapping first (so the role is unreferenced), then the role. Treat a
  // 404 as success (already gone) so deletion is idempotent.
  await deleteAllowingMissing(mappingUrl, config, creds, transport, now);
  await deleteAllowingMissing(roleUrl, config, creds, transport, now);
}

async function putJson(
  url: string,
  bodyObj: Record<string, unknown>,
  config: FgacConfig,
  creds: AwsCredentials,
  transport: SignedTransport,
  now: Date
): Promise<void> {
  const res = await transport(
    {
      method: "PUT",
      url,
      service: "es",
      region: config.region,
      body: JSON.stringify(bodyObj),
      headers: { "content-type": "application/json" },
    },
    creds,
    now
  );
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`security API PUT ${url} failed: HTTP ${res.statusCode} ${res.body}`);
  }
}

async function deleteAllowingMissing(
  url: string,
  config: FgacConfig,
  creds: AwsCredentials,
  transport: SignedTransport,
  now: Date
): Promise<void> {
  const res = await transport(
    { method: "DELETE", url, service: "es", region: config.region },
    creds,
    now
  );
  if (res.statusCode === 404) {
    return;
  }
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`security API DELETE ${url} failed: HTTP ${res.statusCode} ${res.body}`);
  }
}

// ---------------------------------------------------------------------------
// Credential resolution (env or optional STS assume of the master role)
// ---------------------------------------------------------------------------

/**
 * Resolve the credentials to sign with. When `masterRoleArn` is set the handler
 * assumes that role via STS (AWS SDK provided by the Lambda runtime, required
 * lazily); otherwise it uses the Lambda execution role's environment credentials
 * (the run-as-master case).
 */
export async function resolveCredentials(
  config: FgacConfig
): Promise<AwsCredentials> {
  if (config.masterRoleArn) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sts = require("@aws-sdk/client-sts");
    const client = new sts.STSClient({ region: config.region });
    const response = await client.send(
      new sts.AssumeRoleCommand({
        RoleArn: config.masterRoleArn,
        RoleSessionName: "fgac-role-mapping",
        DurationSeconds: 900,
      })
    );
    const c = response.Credentials;
    if (!c || !c.AccessKeyId || !c.SecretAccessKey || !c.SessionToken) {
      throw new Error(`failed to assume master role ${config.masterRoleArn}`);
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretAccessKey,
      sessionToken: c.SessionToken,
    };
  }

  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"];
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("no AWS credentials available in the Lambda environment");
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(process.env["AWS_SESSION_TOKEN"]
      ? { sessionToken: process.env["AWS_SESSION_TOKEN"] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Handler entry point
// ---------------------------------------------------------------------------

/**
 * Provider-framework onEvent entry point. Applies the mapping on Create/Update and
 * removes it on Delete. Returns a stable `PhysicalResourceId` so updates target the
 * same logical resource (no replacement churn).
 */
export async function handler(event: OnEventRequest): Promise<OnEventResponse> {
  const config = resolveConfig(event.ResourceProperties ?? {});
  const transport = defaultSignedTransport();
  const creds = await resolveCredentials(config);
  const id = physicalId(config);

  if (event.RequestType === "Delete") {
    await deleteMapping(config, creds, transport);
    return { PhysicalResourceId: event.PhysicalResourceId ?? id };
  }

  await applyMapping(config, creds, transport);
  return {
    PhysicalResourceId: id,
    Data: {
      FgacRoleName: config.fgacRoleName,
      MappedBackendRole: config.mcpExecutionRoleArn,
      IndexPatterns: config.indexPatterns.join(","),
    },
  };
}

// ---------------------------------------------------------------------------
// Small property helpers
// ---------------------------------------------------------------------------

function requireString(props: Record<string, unknown>, key: string): string {
  const value = props[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required custom-resource property: ${key}`);
  }
  return value;
}

function optionalString(
  props: Record<string, unknown>,
  key: string
): string | undefined {
  const value = props[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePatterns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
