/**
 * DevOps Agent configuration construct (Component 5 — task 11.3).
 *
 * Declares the DevOps Agent configuration that ties the OpenSearch MCP evidence
 * server and the Runbook together. The evidence-gathering channel is the single
 * AWS/OpenSearch-maintained `opensearch-mcp-server-py`, hosted on ECS Fargate
 * behind an internal TLS NLB and reached PRIVATELY via an
 * `AWS::DevOpsAgent::PrivateConnection`. Provisioned with the REAL
 * `AWS::DevOpsAgent::*` CloudFormation schemas:
 *
 *   1. **`AWS::DevOpsAgent::AgentSpace`** — the DevOps Agent workspace the MCP
 *      Association and the runbook Asset bind to. Schema: `Name` (required),
 *      `Description` (optional), `KmsKeyArn` (optional). Read attr: `AgentSpaceId`.
 *   2. **`AWS::DevOpsAgent::PrivateConnection`** — the private path into the
 *      obs-stack VPC: `ServiceManaged` connection to the MCP server's private DNS
 *      host over TLS:8443, trusting the endpoint's self-signed cert.
 *   3. **`AWS::DevOpsAgent::Service` (`ServiceType = "mcpserver"`)** — the OpenSearch
 *      MCP server, addressing the private TLS endpoint via the PrivateConnection
 *      (auth is nominal api-key; the PrivateConnection is the real boundary). Read
 *      attr: `ServiceId`.
 *   4. **`AWS::DevOpsAgent::Association`** — wires the MCP Service into the AgentSpace
 *      (`AgentSpaceId` + `ServiceId`) with the allowed tool list.
 *   5. **`AWS::DevOpsAgent::Asset`** (`agents_md`) — the runbook guidance embedded
 *      INLINE as `Files[].ContentText`, bound to the AgentSpace via `AgentSpaceId`
 *      (no separate Association), so the agent resolves `runbook://<monitorId>`
 *      references without an out-of-band S3 knowledge source (R4.5).
 *
 * The generic HMAC webhook the Signal_Bridge POSTs to is configured OUT-OF-BAND in
 * the DevOps Agent console (not via CloudFormation), so no `Webhook` resource or
 * webhook-secret reference appears here.
 *
 * NOTE ON THE CFN TYPES (DevOps Agent): aws-cdk-lib v2 does not ship L2 constructs
 * for AWS DevOps Agent, so the AgentSpace, PrivateConnection, Service, Association,
 * and Asset are provisioned as L1 {@link cdk.CfnResource}s with `AWS::DevOpsAgent::*`
 * type names and the confirmed property casing. (Legacy AgentCore SigV4 coordinates
 * remain as optional props for the alternative Bedrock AgentCore hosting path.)
 *
 * _Requirements: 1.1, 1.2, 4.5, 5.1_
 */

import * as fs from "fs";
import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { ACCOUNT, REGION } from "../lib/types";

/**
 * The DevOps Agent service principal used for all agentspace trust policies, and
 * the `aidevops` ARN namespace used in the `aws:SourceArn` scoping condition.
 * These match the AUTHORITATIVE AWS DevOps Agent onboarding model (the official
 * CloudFormation getting-started guide): the service assumes both the primary
 * account monitoring role and the operator app role.
 */
const DEVOPS_AGENT_SERVICE_PRINCIPAL = "aidevops.amazonaws.com";
const AGENTSPACE_ARN_NAMESPACE = "aidevops";

/** Stable identifiers so downstream references (and the FGAC/monitor wiring) line up. */
const DEFAULT_AGENT_SPACE_NAME = "devops-agent-incident-response";

/**
 * MCP Service names — must match `^[a-zA-Z0-9_-]+$` (MCPServerSigV4.Name pattern),
 * so underscores (not hyphens-in-arbitrary-shape) are used.
 */
const OPENSEARCH_MCP_SERVICE_NAME = "opensearch_mcp";

/**
 * Lean, principles-based guidance file read at synth time and embedded as the
 * `agents_md` Asset content. Rather than a prescriptive step-by-step flowchart, the
 * agent is given an accurate map of the environment, data sources, and MCP tools and
 * decides how to investigate — smaller standing context, no hard-coded query steps.
 */
const AGENT_GUIDANCE_FILE_NAME = "agent-runbook.md";

/**
 * Canonical file Path the `agents_md` Asset type mandates. The DevOps Agent
 * loads the matching `AGENTS.md` as standing context at the start of every task,
 * so the guidance is in-context and it can resolve `runbook://<monitorId>`.
 */
const AGENTS_MD_FILE_NAME = "AGENTS.md";

/**
 * Allowed MCP tool names per Service (Association `Configuration.MCPServer.Tools`).
 *
 * These names are the EXACT tool names the maintained server advertises via
 * `tools/list` (confirmed by probing the live private endpoint from inside the
 * VPC on the EC2 host). Note the OpenSearch PPL tool is `PPLQueryTool` (not the
 * earlier speculative `PPLTool`).
 */
const OPENSEARCH_MCP_TOOLS = [
  "ListIndexTool",
  "SearchIndexTool",
  "IndexMappingTool",
  "GetShardsTool",
  "PPLQueryTool",
];

// ---------------------------------------------------------------------------
// Phase 2b — private MCP front door (ECS Fargate + internal TLS NLB) coordinates.
// ---------------------------------------------------------------------------
// The evidence-serving path was pivoted from Bedrock AgentCore Runtime to ECS
// Fargate. The maintained OpenSearch MCP server now runs on Fargate behind an
// internal TLS NLB (port 8443) with stable private DNS (`mcp.internal`), deployed by
// `DevOpsAgent-FargateMcp` (Phase 2a). The DevOps Agent reaches it PRIVATELY via
// an `AWS::DevOpsAgent::PrivateConnection` into the obs-stack VPC (Option P) — NOT
// over a public HTTPS endpoint and NOT via SigV4/AgentCore. These are stable,
// deterministic strings (no CFN tokens), so referencing them here creates no
// cross-stack dependency cycle with the Fargate stack.

/** obs-stack VPC + single public subnet + shared SG the PrivateConnection dials into. */
const PRIVATE_CONNECTION_VPC_ID = "vpc-0123456789abcdef0";
const PRIVATE_CONNECTION_SUBNET_IDS = ["subnet-0123456789abcdef0"];
const PRIVATE_CONNECTION_SECURITY_GROUP_IDS = ["sg-0123456789abcdef0"];

/** TLS listener port fronting each MCP service (matches the Fargate NLB listener). */
const MCP_TLS_PORT = "8443";

/** Stable private DNS host name (Route53 private zone `mcp.internal`). */
const OPENSEARCH_MCP_HOST_ADDRESS = "opensearch-mcp.mcp.internal";

/** Stable private HTTPS MCP endpoint (TLS via the internal NLB). */
const OPENSEARCH_PRIVATE_ENDPOINT = `https://${OPENSEARCH_MCP_HOST_ADDRESS}:${MCP_TLS_PORT}/mcp`;

/**
 * PrivateConnection name — 3-30 chars matching `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`.
 * The Service references its PrivateConnection by this name.
 */
const OPENSEARCH_PRIVATE_CONNECTION_NAME = "opensearch-mcp-pc";

/**
 * ServiceType for a private, endpoint-addressed MCP service (the mcpserver variant,
 * reached via a PrivateConnection rather than SigV4/AgentCore).
 */
const MCP_SERVICE_TYPE = "mcpserver";

/**
 * Directory holding the self-signed TLS cert PEMs the internal NLB listeners
 * present. The PrivateConnection carries the matching cert PEM so the DevOps Agent
 * trusts the (self-signed) private endpoint. Same PEMs the Fargate stack imports.
 */
const TLS_DIR = path.join(__dirname, "..", "mcp-servers", "tls");

/**
 * Nominal API-key auth for the mcpserver Services. Auth is NOMINAL by design
 * (agreed with the user): the PrivateConnection is the real security boundary and
 * the maintained servers do not validate a bearer token, so the value is a
 * placeholder. The block is still required by the schema.
 */
const NOMINAL_API_KEY_HEADER = "Authorization";
const NOMINAL_API_KEY_VALUE = "nominal-private-connection-auth";

/**
 * `AuthorizationConfig.Service` — the SigV4 signing service name for the AgentCore
 * data-plane. All MCP invoke requests are signed against `bedrock-agentcore`.
 */
const AGENTCORE_SIGV4_SERVICE = "bedrock-agentcore";

/**
 * ServiceType for a SigV4 MCP service. For the `ServiceDetails.MCPServerSigV4`
 * variant the matching enum value is `mcpserversigv4`.
 */
const MCP_SIGV4_SERVICE_TYPE = "mcpserversigv4";

/**
 * Best-effort default for the AgentCore Runtime MCP invoke endpoint when a real
 * endpoint is not supplied via props.
 *
 * TODO(confirm): AgentCore Runtime MCP invoke URL format. The fully-qualified
 * shape is believed to be
 * `https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/<url-encoded-runtimeArn>/invocations`,
 * but the runtime ARN is only known post-deploy (it is a CFN token), so we fall
 * back to the regional host root here and expect the real endpoint to be threaded
 * in via `openSearchMcpEndpoint`. This is a placeholder that must be confirmed/
 * overridden before deploy — it does NOT block synth. (Legacy AgentCore path only;
 * the default hosting is ECS Fargate reached via a PrivateConnection.)
 */
const DEFAULT_MCP_ENDPOINT = `https://${AGENTCORE_SIGV4_SERVICE}.${REGION}.amazonaws.com/`;

/**
 * Props for {@link DevOpsAgentConfig}.
 *
 * The OpenSearch MCP server runs on ECS Fargate (DevOpsAgent-FargateMcp); its task
 * role ARN and the stable private TLS endpoint are passed in by the CDK app entry
 * point. This construct only references them, it does not create them.
 *
 * NOTE: no `webhookSecretArn` / `kmsKey` props — the generic HMAC webhook is
 * configured out-of-band (see the file header). The MCP server is reached via an
 * `AWS::DevOpsAgent::PrivateConnection` into the obs-stack VPC.
 *
 * TODO(confirm at deploy): the `AWS::DevOpsAgent::*` property casing was verified
 * via `describe-type`, but (a) the `McpRoleArn` semantics — i.e. that the runtime
 * EXECUTION role is the correct role for the agent to SigV4-sign MCP invokes with
 * — and (b) the `Endpoint` URL format still need confirmation against a live
 * deploy.
 */
export interface DevOpsAgentConfigProps {
  /**
   * OPTIONAL ARN of a dedicated DevOps-Agent-assumable invoke role for the
   * OpenSearch Service's SigV4 `AuthorizationConfig.McpRoleArn`. Must trust the
   * DevOps Agent service (session `sigv4McpServerSession`) and be able to
   * `bedrock-agentcore:InvokeAgentRuntime`. When omitted, DevOps Agent resolves
   * credentials automatically. NOTE: the runtime execution role is NOT valid here
   * (it is not assumable by DevOps Agent).
   */
  readonly openSearchMcpRoleArn?: string;

  /**
   * ARN of the OpenSearch MCP AgentCore Runtime. When `McpRoleArn` is omitted,
   * DevOps Agent invokes the MCP server using the primary-account MONITOR role
   * (`sigv4McpViaMonitorAssociationSession`), so that role must be able to
   * `bedrock-agentcore:InvokeAgentRuntime` on this runtime. Passed in to scope the
   * invoke grant.
   */
  readonly openSearchRuntimeArn?: string;

  /**
   * Optional OpenSearch MCP runtime invoke endpoint (https). Defaults to
   * {@link DEFAULT_MCP_ENDPOINT} — see the TODO on that constant; the real URL is
   * only known post-deploy.
   */
  readonly openSearchMcpEndpoint?: string;

  /**
   * Phase 2b: stable PRIVATE HTTPS MCP endpoint (TLS via the internal NLB) for the
   * OpenSearch server, e.g. `https://opensearch-mcp.mcp.internal:8443/mcp`. Used as
   * the `mcpserver` Service `Endpoint`, reached via the PrivateConnection. Defaults
   * to {@link OPENSEARCH_PRIVATE_ENDPOINT}.
   */
  readonly openSearchPrivateEndpoint?: string;

  /**
   * VPC/subnets/SG the DevOps Agent PrivateConnection dials into — the obs-stack
   * VPC that hosts the MCP NLB and the `mcp.internal` private hosted zone. Supplied
   * by the app entry point from the deploy-time VPC context; each falls back to the
   * committed placeholder constant only when omitted.
   */
  readonly privateConnectionVpcId?: string;
  readonly privateConnectionSubnetIds?: string[];
  readonly privateConnectionSecurityGroupIds?: string[];

  /** Optional override for the Agent Space name/identifier. */
  readonly agentSpaceName?: string;

  /**
   * Optional override for the directory containing the agent guidance file
   * (`agent-runbook.md`). Defaults to the repo's `runbooks/` directory. The file is
   * read at synth time and embedded inline in the runbook Asset.
   */
  readonly runbookSourceDir?: string;

  /**
   * Whether to create the runbook `AWS::DevOpsAgent::Asset`. Defaults to `true`.
   * Temporarily set `false` to deploy the core agent wiring (AgentSpace + Services
   * + Associations) first while the Asset's exact schema is being confirmed, so a
   * bad Asset request does not roll back the whole stack.
   */
  readonly createRunbookAsset?: boolean;

  /**
   * Whether to create the two SigV4 MCP `Association`s. Defaults `true`. Set
   * `false` to deploy a PERSISTENT core (AgentSpace + monitor association + the two
   * Services) so the MCP Association `initialize` handshake can be iterated against
   * the live Agent Space (via Cloud Control) without rolling back the whole stack.
   */
  readonly createMcpAssociations?: boolean;

  /**
   * Whether to create the MCP `Service` (and, transitively, its MCP Association).
   * Defaults `true`.
   *
   * This exists to support a TWO-PHASE migration from the old
   * `mcpserversigv4` Services to the new private `mcpserver` Services. Changing a
   * Service's `ServiceType` forces REPLACEMENT, and DevOps Agent dedups Services by
   * their MCP server `Name`, so the default create-new-before-delete-old ordering
   * collides ("Service ... already exists"). To migrate cleanly: (phase A) deploy
   * once with `createMcpServices: false` so CloudFormation DELETES the old Services;
   * then (phase B) deploy with `createMcpServices: true` so the new `mcpserver`
   * Services are created fresh with no name collision. The PrivateConnections are
   * created in both phases (they are independent and do not collide).
   */
  readonly createMcpServices?: boolean;
}

/**
 * DevOps Agent configuration: Agent Space + the OpenSearch MCP Service + its
 * Association + an inline runbook Asset.
 */
export class DevOpsAgentConfig extends Construct {
  /** The `runbook://` scheme prefix the Signal_Bridge uses in `runbookRef`. */
  public readonly runbookRefScheme = "runbook://";

  /**
   * The primary-account monitoring role (the "primary account" role). Trusted by
   * the DevOps Agent service and referenced by the primary-account monitor
   * Association's `Configuration.Aws.AssumableRoleArn`.
   */
  public readonly agentSpaceRole: iam.Role;

  /**
   * The operator app role. Trusted by the DevOps Agent service (AssumeRole +
   * TagSession) and referenced by the AgentSpace `OperatorApp.Iam.OperatorAppRoleArn`.
   */
  public readonly operatorRole: iam.Role;

  /** L1 Agent Space resource. */
  public readonly agentSpace: cdk.CfnResource;

  /**
   * L1 primary-account monitor Association (`ServiceId: "aws"`,
   * `Configuration.Aws.AccountType: "monitor"`). Satisfies the DevOps Agent
   * requirement that the Agent Space have a primary-account association before any
   * SigV4 MCP Association can be created.
   */
  public readonly monitorAssociation: cdk.CfnResource;

  /** L1 PrivateConnection into the obs-stack VPC for the OpenSearch MCP endpoint. */
  public readonly openSearchPrivateConnection: cdk.CfnResource;

  /** L1 MCP Service for the OpenSearch maintained server (ServiceType=mcpserver). Optional — gated by props. */
  public readonly openSearchService?: cdk.CfnResource;

  /** L1 Association wiring the OpenSearch MCP Service into the AgentSpace. */
  public readonly openSearchAssociation?: cdk.CfnResource;

  /** L1 runbook Asset (inline runbook content). Optional — gated by props. */
  public readonly runbookAsset?: cdk.CfnResource;

  constructor(scope: Construct, id: string, props: DevOpsAgentConfigProps) {
    super(scope, id);

    const agentSpaceName = props.agentSpaceName ?? DEFAULT_AGENT_SPACE_NAME;

    // -----------------------------------------------------------------------
    // IAM roles (AUTHORITATIVE onboarding model).
    // -----------------------------------------------------------------------
    // Both roles are assumed by the DevOps Agent service principal
    // (`aidevops.amazonaws.com`), scoped with `aws:SourceAccount` +
    // `aws:SourceArn` (any agentspace in this account/region) to prevent the
    // confused-deputy problem.
    const agentSpaceSourceArn = `arn:aws:${AGENTSPACE_ARN_NAMESPACE}:${REGION}:${ACCOUNT}:agentspace/*`;

    // (1) Monitoring role — the "primary account" role. This is what the
    // primary-account monitor Association assumes (Configuration.Aws.AssumableRoleArn).
    // A fixed roleName is intentionally NOT set to avoid deploy-time collisions;
    // downstream references use `.roleArn`.
    this.agentSpaceRole = new iam.Role(this, "AgentSpaceRole", {
      assumedBy: new iam.ServicePrincipal(DEVOPS_AGENT_SERVICE_PRINCIPAL, {
        conditions: {
          StringEquals: { "aws:SourceAccount": ACCOUNT },
          ArnLike: { "aws:SourceArn": agentSpaceSourceArn },
        },
      }),
      description:
        "Primary-account monitoring role assumed by the DevOps Agent service to observe this account.",
    });
    this.agentSpaceRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AIDevOpsAgentAccessPolicy"),
    );
    // Allow the agent to create the Resource Explorer service-linked role, which
    // the monitoring flow provisions on first use.
    this.agentSpaceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:CreateServiceLinkedRole"],
        resources: [
          `arn:aws:iam::${ACCOUNT}:role/aws-service-role/resource-explorer-2.amazonaws.com/AWSServiceRoleForResourceExplorer`,
        ],
      }),
    );
    // The maintained MCP servers run on ECS Fargate and are reached over a
    // PrivateConnection into the obs-stack VPC (the real security boundary), so no
    // Bedrock AgentCore InvokeAgentRuntime grant is required. This grant is added
    // ONLY if AgentCore runtime ARNs are supplied (legacy AgentCore hosting path).
    if (props.openSearchRuntimeArn) {
      this.agentSpaceRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "InvokeMcpRuntimes",
          actions: ["bedrock-agentcore:InvokeAgentRuntime"],
          resources: [
            props.openSearchRuntimeArn,
            `${props.openSearchRuntimeArn}/*`,
          ],
        }),
      );
    }

    // (2) Operator app role — referenced by AgentSpace OperatorApp.Iam.
    // The DevOps Agent service assumes this role AND tags the session, so the
    // trust policy must allow both sts:AssumeRole (default via ServicePrincipal)
    // and sts:TagSession for the same principal + conditions.
    this.operatorRole = new iam.Role(this, "OperatorAppRole", {
      assumedBy: new iam.ServicePrincipal(DEVOPS_AGENT_SERVICE_PRINCIPAL, {
        conditions: {
          StringEquals: { "aws:SourceAccount": ACCOUNT },
          ArnLike: { "aws:SourceArn": agentSpaceSourceArn },
        },
      }),
      description:
        "Operator app role assumed (with session tagging) by the DevOps Agent service.",
    });
    this.operatorRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AIDevOpsOperatorAppAccessPolicy",
      ),
    );
    // Append a second assume-role statement granting sts:TagSession to the same
    // DevOps Agent service principal under the same confused-deputy conditions.
    this.operatorRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ["sts:TagSession"],
        principals: [
          new iam.ServicePrincipal(DEVOPS_AGENT_SERVICE_PRINCIPAL),
        ],
        conditions: {
          StringEquals: { "aws:SourceAccount": ACCOUNT },
          ArnLike: { "aws:SourceArn": agentSpaceSourceArn },
        },
      }),
    );

    // -----------------------------------------------------------------------
    // Agent Space (L1) — the workspace the Associations + runbook Asset bind to.
    // -----------------------------------------------------------------------
    // Real AWS::DevOpsAgent::AgentSpace schema: Name (required), Description
    // (optional), KmsKeyArn (optional). No Account/Region. OperatorApp.Iam wires
    // the operator app role in per the AUTHORITATIVE onboarding model.
    this.agentSpace = new cdk.CfnResource(this, "AgentSpace", {
      type: "AWS::DevOpsAgent::AgentSpace",
      properties: {
        Name: agentSpaceName,
        Description:
          "Autonomous incident-response Agent Space for the observability-stack demo.",
        OperatorApp: {
          Iam: {
            OperatorAppRoleArn: this.operatorRole.roleArn,
          },
        },
      },
    });
    this.agentSpace.node.addDependency(this.agentSpaceRole);
    this.agentSpace.node.addDependency(this.operatorRole);

    const agentSpaceId = this.agentSpace.getAtt("AgentSpaceId");

    // -----------------------------------------------------------------------
    // Primary-account monitor Association — REQUIRED before any SigV4 MCP
    // Association. DevOps Agent rejects MCP Associations with "requires a primary
    // account association in the Agent Space" until this exists. ServiceId is the
    // literal string "aws"; Configuration.Aws points at the monitoring role.
    // -----------------------------------------------------------------------
    this.monitorAssociation = new cdk.CfnResource(this, "MonitorAssociation", {
      type: "AWS::DevOpsAgent::Association",
      properties: {
        AgentSpaceId: agentSpaceId,
        ServiceId: "aws",
        Configuration: {
          Aws: {
            AssumableRoleArn: this.agentSpaceRole.roleArn,
            AccountId: ACCOUNT,
            AccountType: "monitor",
          },
        },
      },
    });
    this.monitorAssociation.node.addDependency(this.agentSpace);
    this.monitorAssociation.node.addDependency(this.agentSpaceRole);

    // Phase 2b: the Services address the PRIVATE MCP endpoints (TLS via the
    // internal NLBs), reached through a PrivateConnection into the obs-stack VPC.
    const openSearchEndpoint =
      props.openSearchPrivateEndpoint ?? OPENSEARCH_PRIVATE_ENDPOINT;

    // Read the self-signed cert PEM the internal NLB TLS listener presents so the
    // PrivateConnection trusts the private endpoint. Same committed PEM the
    // Fargate stack imports into ACM (CN/SAN == the mcp.internal DNS name).
    const openSearchCertPem = fs.readFileSync(
      path.join(TLS_DIR, "opensearch-mcp-cert.pem"),
      "utf8",
    );

    // VPC coordinates the PrivateConnection dials into. Prefer the deploy-time
    // context values (the obs-stack VPC that hosts the MCP NLB + mcp.internal
    // hosted zone); fall back to the committed placeholders only if unset.
    const pcVpcId = props.privateConnectionVpcId ?? PRIVATE_CONNECTION_VPC_ID;
    const pcSubnetIds =
      props.privateConnectionSubnetIds ?? PRIVATE_CONNECTION_SUBNET_IDS;
    const pcSecurityGroupIds =
      props.privateConnectionSecurityGroupIds ??
      PRIVATE_CONNECTION_SECURITY_GROUP_IDS;

    // -----------------------------------------------------------------------
    // PrivateConnection — private path from the DevOps Agent into the VPC.
    // -----------------------------------------------------------------------
    // AWS::DevOpsAgent::PrivateConnection with a ServiceManaged connection: the
    // agent resolves the private DNS host IN_VPC and dials it over TLS:8443. The
    // self-signed cert PEM is supplied so the agent trusts the endpoint.
    this.openSearchPrivateConnection = new cdk.CfnResource(
      this,
      "OpenSearchPrivateConnection",
      {
        type: "AWS::DevOpsAgent::PrivateConnection",
        properties: {
          Name: OPENSEARCH_PRIVATE_CONNECTION_NAME,
          ConnectionConfiguration: {
            ServiceManaged: {
              HostAddress: OPENSEARCH_MCP_HOST_ADDRESS,
              VpcId: pcVpcId,
              SubnetIds: pcSubnetIds,
              SecurityGroupIds: pcSecurityGroupIds,
              PortRanges: [MCP_TLS_PORT],
              DnsResolution: "IN_VPC",
            },
          },
          Certificate: openSearchCertPem,
        },
      },
    );

    if (props.createMcpServices ?? true) {
    // -----------------------------------------------------------------------
    // MCP Service #1 — OpenSearch maintained server (mcpserver, private).
    // -----------------------------------------------------------------------
    // AWS::DevOpsAgent::Service (ServiceType=mcpserver): ServiceDetails.MCPServer
    // { Name, Endpoint, Description?, AuthorizationConfig.ApiKey {...} } plus the
    // TOP-LEVEL PrivateConnectionName. Auth is NOMINAL (the PrivateConnection is the
    // real boundary); the Endpoint is the private TLS endpoint reached via the PC.
    this.openSearchService = new cdk.CfnResource(this, "OpenSearchMcpService", {
      type: "AWS::DevOpsAgent::Service",
      properties: {
        ServiceType: MCP_SERVICE_TYPE,
        // PrivateConnectionName is a TOP-LEVEL Service property (confirmed via the
        // resource schema): the private connection used for VPC connectivity. It is
        // NOT nested inside ServiceDetails.MCPServer.
        PrivateConnectionName: OPENSEARCH_PRIVATE_CONNECTION_NAME,
        ServiceDetails: {
          MCPServer: {
            Name: OPENSEARCH_MCP_SERVICE_NAME,
            Endpoint: openSearchEndpoint,
            Description:
              "Read-only OpenSearch MCP evidence server (opensearch-mcp-server-py), private.",
            AuthorizationConfig: {
              ApiKey: {
                ApiKeyName: `${OPENSEARCH_MCP_SERVICE_NAME}_apikey`,
                ApiKeyValue: NOMINAL_API_KEY_VALUE,
                ApiKeyHeader: NOMINAL_API_KEY_HEADER,
              },
            },
          },
        },
      },
    });
    this.openSearchService.node.addDependency(this.openSearchPrivateConnection);
    }

    // -----------------------------------------------------------------------
    // Association — wire the OpenSearch MCP Service into the AgentSpace with its tools.
    // -----------------------------------------------------------------------
    // Real AWS::DevOpsAgent::Association schema: AgentSpaceId (required), ServiceId
    // (required), Configuration (required) = { MCPServer: { Tools: [...] } }.
    // Requires the Services to exist (gated together with createMcpServices).
    const createAssociations = props.createMcpAssociations ?? true;
    const openSearchService = this.openSearchService;
    if (createAssociations && openSearchService) {
    this.openSearchAssociation = new cdk.CfnResource(
      this,
      "OpenSearchAssociation",
      {
        type: "AWS::DevOpsAgent::Association",
        properties: {
          AgentSpaceId: agentSpaceId,
          ServiceId: openSearchService.getAtt("ServiceId"),
          Configuration: {
            MCPServer: {
              Tools: OPENSEARCH_MCP_TOOLS,
            },
          },
        },
      },
    );
    this.openSearchAssociation.node.addDependency(this.agentSpace);
    this.openSearchAssociation.node.addDependency(openSearchService);
    // The primary-account association must exist before any MCP Association.
    this.openSearchAssociation.node.addDependency(this.monitorAssociation);
    }

    // -----------------------------------------------------------------------
    // Runbook knowledge source — inline Asset bound directly to the AgentSpace.
    // -----------------------------------------------------------------------
    // Real AWS::DevOpsAgent::Asset schema: AgentSpaceId (required, createOnly),
    // AssetType (required, createOnly), Files [{ Path, ContentText }], Metadata.
    // The runbook is embedded inline via Files[].ContentText (read at synth time).
    // There is NO separate Association for the Asset — it binds via AgentSpaceId.
    if (props.createRunbookAsset ?? true) {
    const runbookSourceDir =
      props.runbookSourceDir ?? path.join(__dirname, "..", "runbooks");
    // Read the lean, principles-based guidance markdown (already valid text/markdown,
    // well under the 25 KiB agents_md cap). The agent gets an accurate map of the
    // environment + data sources + MCP tools and decides how to investigate — no
    // embedded step-by-step query flowchart.
    const agentsMdContent = fs.readFileSync(
      path.join(runbookSourceDir, AGENT_GUIDANCE_FILE_NAME),
      "utf8",
    );

    // AssetType "agents_md": a markdown file of standing agent instructions that
    // the DevOps Agent loads as context at the START OF EVERY TASK — the right
    // vehicle for a runbook the agent must have in-context and resolve by
    // reference. Creatable Asset types are skill / agents_md / attachment (the
    // earlier "memory_store" was rejected on live deploy, and a bare memory_store
    // is only useful with child `memory` assets). Per the Asset API, `agents_md`
    // requires exactly ONE metadata key — `agent_type` (a SINGLE string, NOT the
    // `agent_types[]` array the memory_store/skill types use); `GENERIC` makes the
    // instructions apply to all agent types (triage/RCA/mitigation). The file MUST
    // be the canonical `AGENTS.md` path with text/markdown content <=25 KiB (the
    // runbook is ~20 KiB, so it fits).
    this.runbookAsset = new cdk.CfnResource(this, "RunbookAsset", {
      type: "AWS::DevOpsAgent::Asset",
      properties: {
        AgentSpaceId: agentSpaceId,
        AssetType: "agents_md",
        // Scope to the INCIDENT_RCA agent (the one that correlates telemetry via
        // the MCP tools to find root cause) rather than GENERIC — this guidance is
        // only relevant to incident investigation, so loading it into the CHAT /
        // PREVENTION / RELEASE agents would be wasted context. `agent_type` is a
        // SINGLE value (one AGENTS.md per type); valid values: GENERIC, CHAT,
        // INCIDENT_TRIAGE, INCIDENT_RCA, INCIDENT_MITIGATION, INCIDENT_UI,
        // PREVENTION, RELEASE_READINESS_REVIEW, RELEASE_TESTING.
        Metadata: {
          agent_type: "INCIDENT_RCA",
        },
        Files: [
          {
            Path: AGENTS_MD_FILE_NAME,
            ContentText: agentsMdContent,
          },
        ],
      },
    });
    this.runbookAsset.node.addDependency(this.agentSpace);
    }
  }
}
