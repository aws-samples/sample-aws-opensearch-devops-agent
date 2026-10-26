/**
 * Shared contracts for the DevOps Agent Integration (autonomous incident-response) demo.
 *
 * These types are the single source of truth for the detection logic, the Signal_Bridge,
 * the runbook store, the MCP evidence server, and the DevOps Agent runbook-execution engine.
 * They are derived directly from the design document's "Components and Interfaces" and
 * "Data Models" sections.
 */

// ---------------------------------------------------------------------------
// Account / region containment (R1.7, R6.7, R6.8)
// ---------------------------------------------------------------------------
//
// Resolved from the environment so no code edit is needed to target your account:
//   ACCOUNT  <- CDK_DEFAULT_ACCOUNT | CDK_ACCOUNT   (falls back to the docs example)
//   REGION   <- CDK_DEFAULT_REGION  | AWS_REGION    (falls back to us-east-1)
// Set these in your shell before `cdk synth`/`cdk deploy`, e.g.:
//   export CDK_DEFAULT_ACCOUNT=<your-account-id>
//   export CDK_DEFAULT_REGION=<your-region>

/** The only AWS account this demo is permitted to operate within. */
export const ACCOUNT: string =
  process.env.CDK_DEFAULT_ACCOUNT ?? process.env.CDK_ACCOUNT ?? "111122223333";

/** The only AWS region this demo is permitted to operate within. */
export const REGION: string =
  process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";

export type Account = string;
export type Region = string;

// ---------------------------------------------------------------------------
// Alert monitor configuration (Component 1)
// ---------------------------------------------------------------------------

/** Comparison operators for threshold evaluation. */
export type Comparator = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

/** Source telemetry system an Alert_Monitor evaluates. */
export type MonitorSource = "opensearch" | "amp";

/** Time field used by OpenSearch monitors: logs use `time`, traces use `endTime`. */
export type TimeField = "time" | "endTime";

/**
 * Monitor config contract. `monitorId` is the stable id and also the Runbook key.
 * OpenSearch monitors use `evaluationIntervalSeconds` in [60, 300]; AMP uses [15, 300].
 */
export interface AlertMonitorConfig {
  monitorId: string;
  source: MonitorSource;
  index?: string; // OpenSearch monitors only
  timeField?: TimeField; // logs use `time`, traces use `endTime`
  query: object | string; // OpenSearch query DSL or PromQL string
  threshold: number; // numeric threshold
  comparator: Comparator;
  evaluationIntervalSeconds: number; // OpenSearch: 60-300; AMP: 15-300
  notificationChannelId: string; // SNS channel / Alertmanager receiver
  runbookRef: string; // e.g. "runbook://M-logs-error-rate"
}

// ---------------------------------------------------------------------------
// Signal_Bridge contracts (Component 2)
// ---------------------------------------------------------------------------

/** Envelope parsed from the SNS notification a fired monitor emits. */
export interface SnsAlertEnvelope {
  monitorId: string;
  triggeringCondition: string; // human-readable, e.g. "error-rate 8.3% >= 5%"
  incidentTimestamp: string; // ISO-8601, when the monitor transitioned
  seedEvidence?: Record<string, unknown>; // small snapshot from the monitor result
}

/** Result of a single (or final) delivery attempt to the DevOps Agent webhook. */
export interface DeliveryResult {
  delivered: boolean;
  httpStatus?: number;
  monitorId: string;
  attempt: number;
  failureReason?: string; // set when !delivered
}

/**
 * DevOps Agent incident payload (Signal_Bridge output). Matches the documented
 * generic-webhook schema; incident-specific context rides in `data`.
 */
export interface DevOpsAgentIncident {
  eventType: "incident";
  incidentId: string; // `${monitorId}-${incidentTimestamp}` (dedupe key)
  action: "created" | "updated" | "closed" | "resolved";
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "MINIMAL";
  title: string; // e.g. "M-logs-error-rate: error-rate 8.3% >= 5%"
  description?: string;
  timestamp: string; // incident timestamp (ISO-8601)
  service?: string; // e.g. "checkout"
  data: {
    monitorId: string; // R1.6 required
    triggeringCondition: string; // R1.6 required
    incidentTimestamp: string; // R1.6 required
    runbookRef: string; // R1.6 required
    seedEvidence?: Record<string, unknown>;
    metadata: { account: Account; region: Region };
  };
}

// ---------------------------------------------------------------------------
// Runbook schema (Component 4)
// ---------------------------------------------------------------------------

/** Machine-readable runbook, one entry per Alert_Monitor (R4.1, R4.6). */
export interface Runbook {
  version: string;
  entries: Record<string, RunbookEntry>; // keyed by Alert_Monitor id
}

export interface RunbookEntry {
  monitorId: string;
  title: string;
  incidentScenarioRefs: string[]; // scenarios this entry covers
  investigationSteps: InvestigationStep[]; // executed in ascending `order` (R4.1)
  rcaMapping: RcaRule[]; // evidence -> candidate root causes (R4.3)
  remediation: RemediationAction[]; // R4.4, R4.7, R4.8
}

export interface InvestigationStep {
  order: number; // ascending execution order
  description: string;
  query: EvidenceQuery; // R4.2
  evidenceItem: string; // Evidence_Bundle item this populates (R4.2)
}

/** Named evidence source an investigation step queries. */
export type EvidenceSource =
  | "Logs_Index"
  | "Traces_Index"
  | "Service_Map_Index"
  | "AMP_Workspace";

// Generic maintained-server tools. OpenSearch: opensearch-mcp-server-py.
// No custom/typed tool layer.

/** Generic tools exposed by the OpenSearch-maintained `opensearch-mcp-server-py`. */
export type OpenSearchMcpTool =
  | "ListIndexTool"
  | "SearchIndexTool"
  | "IndexMappingTool"
  | "GetShardsTool"
  | "PPLTool";

/** Any maintained MCP tool name a runbook step may invoke. */
export type McpToolName = OpenSearchMcpTool;

/** Which maintained MCP server serves a given evidence query. */
export type McpServer = "opensearch";

/** Time field used by a time-ranged OpenSearch query, per target index. */
export type EvidenceTimeField = "time" | "endTime" | "@timestamp";

export interface EvidenceQuery {
  source: EvidenceSource;
  server: McpServer; // which maintained MCP server
  tool: McpToolName; // generic tool to invoke
  index?: string; // REQUIRED for OpenSearch tools (no implicit index)
  timeField?: EvidenceTimeField; // REQUIRED for time-ranged OpenSearch queries
  args: Record<string, unknown>; // full query DSL (incl. the time-range on `timeField`) or PromQL
}

export interface RcaRule {
  // If the named evidence items match `whenPattern`, these candidate causes apply.
  evidenceItems: string[];
  whenPattern: string; // predicate description, machine-evaluable
  candidateRootCauses: string[]; // one or more (R4.3)
}

export interface RemediationAction {
  actionId: string;
  description: string;
  mutatesDemo: boolean; // true => confirmation-gated (R4.7)
  requiresConfirmation: boolean; // MUST equal mutatesDemo
  autoExecutable: boolean; // MUST equal !mutatesDemo (R4.8)
  postRemediationResolutionState: string; // observable resolved condition (R4.4)
}

// ---------------------------------------------------------------------------
// Evidence bundle & RCA finding (Component 6 / DevOps Agent execution)
// ---------------------------------------------------------------------------

export interface EvidenceBundleItem {
  name: string; // matches InvestigationStep.evidenceItem
  source: EvidenceSource;
  status: "gathered" | "retrieval_failed"; // R5.5
  result?: unknown; // query result when gathered
  failureDetail?: { dataSource: string; attempts: number }; // R5.5
}

export interface RcaFinding {
  incidentId: string;
  monitorId: string;
  evidenceRefs: string[]; // MUST reference every bundle item (R5.3)
  candidateRootCauses: string[]; // derived via rcaMapping (R4.3)
  selectedRootCause: string; // exactly one finding (R5.3)
  timedOut: boolean; // true if 300s cap hit (R5.7)
  unreachableSources: string[]; // recorded per R5.5
}

// ---------------------------------------------------------------------------
// Maintained MCP evidence servers (Component 3) + supporting result shapes
// ---------------------------------------------------------------------------

/**
 * Generic MCP tool invoker: the DevOps Agent calls a named tool on the maintained
 * OpenSearch MCP server (`opensearch-mcp-server-py`) with args. The real tool
 * execution happens on the maintained server, not in this TypeScript codebase —
 * this type models the single call seam the agent-execution engine drives during
 * runbook execution.
 */
export type McpInvoker = (call: {
  server: McpServer;
  tool: McpToolName;
  args: Record<string, unknown>;
}) => Promise<unknown>;

/** A single log document returned by the read-only logs search tool. */
export interface LogHit {
  timestamp: string;
  severityNumber?: number;
  severityText?: string;
  body?: string;
  serviceName?: string;
  attributes?: Record<string, unknown>;
}

/** A single trace/span document returned by the read-only traces search tool. */
export interface TraceSpanDocument {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name?: string;
  kind?: string;
  serviceName?: string;
  startTime?: string;
  endTime?: string;
  durationInNanos?: number;
  statusCode?: string;
  attributes?: Record<string, unknown>;
}

/** A single dependency edge from the service map. */
export interface ServiceMapEdge {
  source: string; // serviceName
  destination: string; // destination.resource
  errorCount: number;
  totalCount: number;
  averageLatencyMs: number;
}

/** A single PromQL sample: [unix-seconds, string-encoded value]. */
export type PromQLSample = [number, string];

/** A PromQL result series (instant or range vector). */
export interface PromQLSeries {
  metric: Record<string, string>;
  value?: PromQLSample; // instant query
  values?: PromQLSample[]; // range query
}

/** Result of a PromQL query against the AMP workspace. */
export interface PromQLResult {
  resultType: "vector" | "matrix" | "scalar" | "string";
  result: PromQLSeries[];
}
