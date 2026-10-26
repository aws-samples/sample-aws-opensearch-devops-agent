#!/usr/bin/env node
/**
 * CDK app entry point for the DevOps Agent Integration demo (task 11.4).
 *
 * Wires the whole autonomous incident-response topology together in dependency
 * order, pinned to the demo account/region `111122223333` / `us-east-1`
 * (R1.7, R6.7). The build follows the design's "High-Level Topology":
 *
 *   Shared refs ──► Signal_Bridge stack ─┐
 *                └► FargateMcp stack ─────┼─► Integration stack
 *                                        │   (monitors + FGAC + agent config)
 *
 * STACK SPLIT (design "High-Level Topology")
 * ------------------------------------------
 *   - {@link SignalBridgeStack}: SNS topic + in-VPC translator Lambda + SQS DLQ +
 *     webhook HMAC secret (delivers a fired alert to the agent within 120 s).
 *   - {@link FargateMcpStack}: the two read-only MCP evidence servers hosted on
 *     ECS Fargate, fronted by internal TLS NLBs and reached by the agent over an
 *     AWS::DevOpsAgent::PrivateConnection into the obs-stack VPC.
 * They are separate stacks so the detection/delivery path and the
 * evidence-serving path have independent lifecycles and blast radius.
 *
 * A small {@link SharedResourcesStack} owns the things both stacks reference:
 *   - the imported obs-stack VPC (an existing, VPC-private network — imported by
 *     attributes so `cdk synth` needs no environment lookups), and
 *   - a DEDICATED agent-auth secret (see "SECRET WIRING" below).
 *
 * A single {@link IntegrationStack} hosts the deploy-time wiring constructs
 * (monitors deployment, FGAC role mapping, DevOps Agent configuration) because
 * they all depend on outputs of BOTH the Signal_Bridge and FargateMcp stacks.
 *
 * SECRET WIRING (Path 2 — single HMAC trust boundary)
 * ----------------------------------------------------
 * Under the Path 2 change there is now only ONE HMAC trust boundary in the flow:
 *   - Signal_Bridge → Agent: the bridge signs its webhook POSTs; the agent
 *     verifies them. This is the {@link SignalBridgeStack.webhookSecret}. The
 *     generic HMAC webhook itself is configured OUT-OF-BAND in the DevOps Agent
 *     console (not via CloudFormation), so no CloudFormation resource references
 *     the webhook secret ARN — it is wired manually post-deploy.
 * The former Agent → MCP HMAC boundary is gone: the two maintained MCP servers
 * authenticate to their backing stores with SigV4 via their ECS Fargate task
 * roles, and inbound agent→MCP access is secured by the AWS::DevOpsAgent::Private-
 * Connection into the obs-stack VPC (the internal TLS NLB is the boundary). The
 * previously-provisioned dedicated agent-auth secret in {@link SharedResourcesStack}
 * has therefore been removed (fully unused).
 *
 * CONFIGURATION (context keys)
 * ----------------------------
 * All coordinates that reference the ALREADY-DEPLOYED observability stack (its
 * VPC-private OpenSearch domain, its AMP workspace) and the DevOps Agent webhook
 * created out-of-band are sourced from CDK context (`-c key=value` or the
 * `context` block in cdk.json) or environment variables, with sensible defaults
 * so `cdk synth` succeeds out of the box. Required keys (default in parentheses):
 *
 *   obsVpcId               VPC id of the obs-stack domain's VPC
 *                          (placeholder `vpc-REPLACE_ME`)
 *   obsSubnetIds           Comma-separated private subnet id(s) in that VPC
 *                          (placeholder `subnet-REPLACE_ME_A,subnet-REPLACE_ME_B`)
 *   obsAvailabilityZones   Comma-separated AZs for those subnets
 *                          (default `${REGION}a,${REGION}b`)
 *   obsSecurityGroupId     Security group id allowing egress to the domain/AMP (443)
 *                          (placeholder `sg-REPLACE_ME`)
 *   opensearchEndpoint     VPC-private domain endpoint host, no scheme
 *                          (default: the deployed obs-stack domain endpoint)
 *   domainArn              OpenSearch domain ARN
 *                          (default `arn:aws:es:${REGION}:${ACCOUNT}:domain/obs-stack`)
 *   ampEndpoint            AMP query endpoint URL for the workspace
 *                          (default derived from the workspace id below)
 *   ampWorkspaceId         AMP workspace id
 *                          (default `ws-11111111-2222-3333-4444-555555555555`)
 *   ampWorkspaceArn        AMP workspace ARN
 *                          (default derived from account/region/workspace id)
 *   devopsAgentWebhookUrl  The DevOps Agent generic-webhook URL (must be https)
 *                          (placeholder `https://devops-agent.${REGION}.amazonaws.com/webhooks/REPLACE_ME`)
 *   fgacMasterRoleArn      The domain's FGAC master role to assume for the
 *                          security API (default `arn:aws:iam::${ACCOUNT}:role/Admin`)
 *
 * Placeholder defaults (the `REPLACE_ME` values) let the app synthesize but MUST
 * be overridden with the real obs-stack coordinates before `cdk deploy`.
 *
 * _Requirements: 1.7, 6.7_
 */

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { Construct } from "constructs";

import { ACCOUNT, REGION } from "../lib/types";
import { SignalBridgeStack } from "../lib/stacks/signal-bridge-stack";
import { FargateMcpStack } from "../lib/stacks/fargate-mcp-stack";
import { BuildStack } from "../lib/stacks/build-stack";
import { MonitorsDeployment } from "../lib/deploy/monitors-deploy";
import { FgacRoleMapping } from "../lib/deploy/fgac-mapping";
import { DevOpsAgentConfig } from "../agent-config/agent";

const app = new cdk.App();

/** Environment shared by every stack; enforces account/region containment (R1.7, R6.7). */
export const env: cdk.Environment = { account: ACCOUNT, region: REGION };

// ---------------------------------------------------------------------------
// Configuration helpers — context first, then env var, then a safe default.
// ---------------------------------------------------------------------------

/** Read a string config value from CDK context or process env, falling back to a default. */
function cfg(key: string, fallback: string): string {
  const fromContext = app.node.tryGetContext(key);
  if (typeof fromContext === "string" && fromContext.length > 0) {
    return fromContext;
  }
  const fromEnv = process.env[key];
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv;
  }
  return fallback;
}

/** Read a comma-separated list config value. */
function cfgList(key: string, fallback: string[]): string[] {
  const raw = cfg(key, "");
  if (raw.length === 0) {
    return fallback;
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const AMP_WORKSPACE_ID_DEFAULT = "ws-11111111-2222-3333-4444-555555555555";

// obs-stack VPC (existing, VPC-private) — imported by attributes.
// Defaults are the CONFIRMED coordinates of the deployed obs-stack domain's VPC
// (from `aws opensearch describe-domain --domain-name obs-stack`). The domain
// lives in a single subnet/AZ; the demo EC2 host shares this VPC.
const obsVpcId = cfg("obsVpcId", "vpc-0123456789abcdef0");
const obsSubnetIds = cfgList("obsSubnetIds", ["subnet-0123456789abcdef0"]);
const obsAvailabilityZones = cfgList("obsAvailabilityZones", [`${REGION}a`]);
const obsSecurityGroupId = cfg("obsSecurityGroupId", "sg-0123456789abcdef0");

// OpenSearch domain coordinates.
const opensearchEndpoint = cfg(
  "opensearchEndpoint",
  "vpc-obs-stack-xxxxxxxxxxxxxxxxxxxxxxxxxx.us-east-1.es.amazonaws.com",
);
const domainArn = cfg(
  "domainArn",
  `arn:aws:es:${REGION}:${ACCOUNT}:domain/obs-stack`,
);

// AMP workspace coordinates.
const ampWorkspaceId = cfg("ampWorkspaceId", AMP_WORKSPACE_ID_DEFAULT);
const ampEndpoint = cfg(
  "ampEndpoint",
  `https://aps-workspaces.${REGION}.amazonaws.com/workspaces/${ampWorkspaceId}`,
);
const ampWorkspaceArn = cfg(
  "ampWorkspaceArn",
  `arn:aws:aps:${REGION}:${ACCOUNT}:workspace/${ampWorkspaceId}`,
);

// DevOps Agent webhook (created out-of-band) + FGAC master role.
const devopsAgentWebhookUrl = cfg(
  "devopsAgentWebhookUrl",
  `https://devops-agent.${REGION}.amazonaws.com/webhooks/REPLACE_ME`,
);
const fgacMasterRoleArn = cfg(
  "fgacMasterRoleArn",
  `arn:aws:iam::${ACCOUNT}:role/Admin`,
);

// Container image URI for the OpenSearch MCP runtime (ECR). Default to :latest;
// override via context to force a fresh pull (e.g. after rebuilding for arm64).
const openSearchMcpImageUri = cfg(
  "openSearchMcpImageUri",
  // Default matches what the BuildStack CodeBuild project pushes (:latest).
  `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/devops-agent-opensearch-mcp:latest`,
);

// ---------------------------------------------------------------------------
// Shared resources stack — imported obs-stack VPC + dedicated agent-auth secret.
// ---------------------------------------------------------------------------

interface SharedResourcesStackProps extends cdk.StackProps {
  readonly vpcId: string;
  readonly availabilityZones: string[];
  readonly privateSubnetIds: string[];
}

/**
 * Owns cross-cutting references both the Signal_Bridge and MCP stacks need:
 *   - the imported (existing) obs-stack VPC, and
 *   - the dedicated agent→MCP HMAC/API-key secret (the MCP server verifies the
 *     agent's HMAC with this; it is intentionally separate from the bridge→agent
 *     webhook secret so the two trust directions rotate independently).
 */
class SharedResourcesStack extends cdk.Stack {
  public readonly obsVpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props: SharedResourcesStackProps) {
    super(scope, id, props);

    // Import the existing VPC-private obs-stack VPC by attributes (no lookup, so
    // synth works without AWS credentials / cached context).
    this.obsVpc = ec2.Vpc.fromVpcAttributes(this, "ObsVpc", {
      vpcId: props.vpcId,
      availabilityZones: props.availabilityZones,
      privateSubnetIds: props.privateSubnetIds,
    });

    // NOTE (Path 2, task 11.3): the previously-provisioned dedicated agent->MCP
    // auth secret has been REMOVED because it is now fully unused. Under Path 2 the
    // two maintained MCP servers authenticate to their backing stores with SigV4
    // via their AgentCore Runtime execution roles, and inbound agent->MCP auth is
    // handled by the AgentCore Runtime MCP contract (not an in-container HMAC
    // secret), so no agent-auth secret is threaded into the MCP stack. The only
    // remaining HMAC trust boundary is Signal_Bridge -> Agent (the webhook secret
    // owned by the Signal_Bridge stack), and that webhook is configured out-of-band
    // in the DevOps Agent console.
  }
}

// ---------------------------------------------------------------------------
// Integration stack — deploy-time wiring that depends on BOTH core stacks.
// ---------------------------------------------------------------------------

interface IntegrationStackProps extends cdk.StackProps {
  // Network (obs-stack VPC-private domain reachability).
  readonly vpc: ec2.IVpc;
  readonly securityGroupId: string;
  readonly subnetIds: string[];

  // OpenSearch / AMP coordinates.
  readonly domainEndpoint: string;
  readonly domainArn: string;
  readonly ampWorkspaceId: string;
  readonly ampWorkspaceArn: string;

  // From the Signal_Bridge stack.
  readonly snsTopicArn: string;

  // From the Fargate MCP stack (the OpenSearch MCP server).
  // This role ARN is the one FGAC-mapped read-only on the domain (11.2) AND is used
  // as the SigV4 McpRoleArn for the OpenSearch MCP Service (11.3).
  readonly mcpExecutionRoleArn: string;

  // Phase 2b: stable PRIVATE HTTPS MCP endpoint (TLS via the Fargate internal
  // NLB) used as the `mcpserver` Service's Endpoint, reached via the
  // PrivateConnection. Deterministic string (no CFN tokens), so passing it from the
  // Fargate stack creates no cross-stack dependency cycle.
  readonly openSearchPrivateEndpoint: string;

  // Optional LEGACY AgentCore Runtime coordinates. Only set these if you host the
  // MCP server on Bedrock AgentCore Runtime instead of ECS Fargate; when omitted,
  // the AgentCore invoke endpoint and the InvokeAgentRuntime grant are skipped.
  readonly openSearchMcpEndpoint?: string;
  readonly openSearchRuntimeArn?: string;

  // FGAC master identity (domain security API).
  readonly fgacMasterRoleArn: string;

  /**
   * Whether to deploy the in-VPC custom resources (monitors registration + FGAC
   * role mapping). Defaults false: the domain's private subnet has no egress to
   * public AWS APIs (STS/SNS/APS), so these are applied out-of-band (FGAC + OpenSearch
   * monitors from the in-VPC EC2 via SSM; AMP rules from an admin workstation).
   */
  readonly deployVpcCustomResources: boolean;
}

/**
 * Hosts the deploy-time wiring constructs:
 *   - {@link MonitorsDeployment}: registers the OpenSearch monitors + AMP rule and
 *     points every notification action at the Signal_Bridge SNS topic (R2.5/R3.5).
 *   - {@link FgacRoleMapping}: maps the OpenSearch MCP task role into a read-only
 *     FGAC role on the domain, authenticating as the FGAC master (assume
 *     `role/Admin`).
 *   - {@link DevOpsAgentConfig}: the Agent Space + the OpenSearch MCP Service
 *     (`mcpserver`, reached via a PrivateConnection into the obs-stack VPC) + its
 *     Association + the inline runbook Asset. The generic HMAC webhook is
 *     configured out-of-band in the DevOps Agent console (not via CloudFormation).
 */
class IntegrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: IntegrationStackProps) {
    super(scope, id, props);

    // In-VPC custom resources (monitors registration + FGAC role mapping) are
    // gated: the domain's private subnet has no egress to STS/SNS/APS, so by
    // default these are applied out-of-band (EC2 via SSM + admin workstation) and
    // NOT deployed here. Enable only once the subnet has egress (NAT / VPC endpoints).
    if (props.deployVpcCustomResources) {
      // Monitors deployment — notifications wired to the Signal_Bridge SNS topic.
      new MonitorsDeployment(this, "MonitorsDeployment", {
        domainEndpoint: props.domainEndpoint,
        domainArn: props.domainArn,
        ampWorkspaceId: props.ampWorkspaceId,
        ampWorkspaceArn: props.ampWorkspaceArn,
        snsTopicArn: props.snsTopicArn,
        vpc: props.vpc,
        securityGroupId: props.securityGroupId,
        subnetIds: props.subnetIds,
      });

      // FGAC role mapping — MCP execution role -> read-only FGAC role on the domain.
      // The domain security API only accepts the FGAC master; assume `role/Admin`.
      new FgacRoleMapping(this, "FgacRoleMapping", {
        domainEndpoint: props.domainEndpoint,
        domainArn: props.domainArn,
        mcpExecutionRoleArn: props.mcpExecutionRoleArn,
        master: { mode: "assume", roleArn: props.fgacMasterRoleArn },
        vpc: props.vpc,
        securityGroupId: props.securityGroupId,
        subnetIds: props.subnetIds,
      });
    }

    // DevOps Agent configuration — AgentSpace + one AWS::DevOpsAgent::Service
    // (ServiceType=mcpserver) + its Association + the inline runbook Asset, plus
    // the PrivateConnection into the obs-stack VPC. The OpenSearch MCP task role is
    // the SigV4 McpRoleArn for the Service. The MCP server is reached over the
    // PrivateConnection (private TLS), and the generic HMAC webhook is configured
    // OUT-OF-BAND in the DevOps Agent console (not via CloudFormation), so no
    // webhook secret ARN is referenced. The MCP invoke
    // endpoints are only fully known post-deploy, so they default to a placeholder
    // (see agent-config/agent.ts) and can be overridden later.
    new DevOpsAgentConfig(this, "DevOpsAgentConfig", {
      // Phase 2b: the two Services are `mcpserver` (private), addressing the stable
      // private TLS endpoints and reached via PrivateConnections into the obs-stack
      // VPC. Auth is nominal (the PrivateConnection is the real security boundary).
      openSearchPrivateEndpoint: props.openSearchPrivateEndpoint,
      // The PrivateConnection dials into the obs-stack VPC (where the MCP NLB and
      // the mcp.internal hosted zone live) — the same VPC coordinates threaded to
      // this stack from the deploy-time context, NOT the committed placeholders.
      privateConnectionVpcId: props.vpc.vpcId,
      privateConnectionSubnetIds: props.subnetIds,
      privateConnectionSecurityGroupIds: [props.securityGroupId],
      // Legacy AgentCore SigV4 coordinates (superseded; still threaded for the
      // monitor-role InvokeAgentRuntime grant scoping).
      openSearchMcpEndpoint: props.openSearchMcpEndpoint,
      openSearchRuntimeArn: props.openSearchRuntimeArn,
      // The runbook Asset is an `agents_md` Asset (creatable types are
      // skill/agents_md/attachment), loaded as standing context at the start of
      // every task, so the embedded runbook is in-context and resolvable via
      // `runbook://<monitorId>` (R4.5).
      // Two-phase deploy support: `-c createMcpServices=false` creates the
      // AgentSpace + PrivateConnection (no MCP Service handshake) so the
      // PrivateConnection can become routable; a second deploy with the default
      // `true` then adds the Service + Association against the warmed-up PC. This
      // avoids the create-time race where the Service handshake fires before the
      // freshly-created PrivateConnection is reachable.
      createMcpServices: cfg("createMcpServices", "true") === "true",
      createMcpAssociations: true,
      createRunbookAsset: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Instantiate the topology in dependency order.
// ---------------------------------------------------------------------------

// 0. Build stack — ECR repo + a native-ARM CodeBuild project that builds & pushes
//    the OpenSearch MCP image. Deploy this FIRST, run `aws codebuild start-build
//    --project-name devops-agent-mcp-build`, and wait for SUCCEEDED before deploying
//    the rest (the Fargate service references the pushed image). No local Docker.
new BuildStack(app, "DevOpsAgent-Build", { env });

// 1. Shared refs (imported VPC + dedicated agent-auth secret).
const shared = new SharedResourcesStack(app, "DevOpsAgent-Shared", {
  env,
  description:
    "Shared obs-stack references (imported VPC) and the dedicated agent->MCP auth secret.",
  vpcId: obsVpcId,
  availabilityZones: obsAvailabilityZones,
  privateSubnetIds: obsSubnetIds,
});

// 2. Signal_Bridge stack (SNS topic + in-VPC translator Lambda + DLQ + webhook secret).
const signalBridge = new SignalBridgeStack(app, "DevOpsAgent-SignalBridge", {
  env,
  description:
    "Signal_Bridge: SNS topic, in-VPC translator Lambda, SQS DLQ, and webhook HMAC secret.",
  webhookUrl: devopsAgentWebhookUrl,
  vpc: shared.obsVpc,
  securityGroupId: obsSecurityGroupId,
  subnetIds: obsSubnetIds,
});

// 3. Fargate MCP hosting stack (Phase 1 + Phase 2a) — hosts the two maintained MCP
//     server containers on ECS Fargate in the obs-stack VPC (RUNNING + LOGGING +
//     reaching the VPC-private OpenSearch domain), and (Phase 2a) puts an internal
//     NLB with a TLS listener on 8443 in front of each service plus a Route53 private
//     hosted zone (`mcp.internal`) with stable DNS names. The DevOps Agent
//     PrivateConnection/Service wiring (Phase 2b) is intentionally NOT built yet.
//     The tasks share the domain's security group to reach the private domain
//     intra-VPC. The images are arm64, so the task definitions use an arm64
//     runtimePlatform.
//
//     NETWORKING: secure-by-default is PRIVATE subnets with no public IP, which
//     requires a NAT gateway or VPC endpoints for ECR/CloudWatch/STS/AMP egress.
//     `assignPublicIpForFargate` context therefore DEFAULTS TO FALSE. The bundled
//     single-subnet demo reuses an IGW-routed PUBLIC subnet with no NAT, so the
//     Quick Start explicitly passes `-c assignPublicIpForFargate=true` to opt in.
const fargate = new FargateMcpStack(app, "DevOpsAgent-FargateMcp", {
  env,
  description:
    "Phase 1 + 2a: the OpenSearch MCP server on ECS Fargate, fronted by an internal TLS NLB with stable private DNS (mcp.internal).",
  vpc: shared.obsVpc,
  subnetIds: obsSubnetIds,
  // Secure-by-default: private (no public IP) unless the operator opts in with
  // `-c assignPublicIpForFargate=true` (the public-subnet quickstart path).
  assignPublicIp: cfg("assignPublicIpForFargate", "false") === "true",
  securityGroupId: obsSecurityGroupId,
  // OPENSEARCH_URL needs an https scheme; the context var is the bare host.
  opensearchEndpoint: `https://${opensearchEndpoint}`,
  openSearchImageUri: openSearchMcpImageUri,
});

// 4. Integration stack (monitors + FGAC mapping + agent config) — depends on both
//    core stacks' outputs (topic/secret ARNs and MCP role/runtime ARNs).
const integration = new IntegrationStack(app, "DevOpsAgent-Integration", {
  env,
  description:
    "Deploy-time wiring: OpenSearch/AMP monitors, FGAC role mapping, and DevOps Agent configuration.",
  vpc: shared.obsVpc,
  securityGroupId: obsSecurityGroupId,
  subnetIds: obsSubnetIds,
  domainEndpoint: opensearchEndpoint,
  domainArn,
  ampWorkspaceId,
  ampWorkspaceArn,
  snsTopicArn: signalBridge.topicArn,
  // The OpenSearch MCP server runs on ECS Fargate. FGAC (11.2) maps that MCP
  // Fargate TASK role read-only on the domain (the identity signing SigV4 to the
  // domain), and it is also the SigV4 McpRoleArn for the MCP Service (11.3).
  mcpExecutionRoleArn: fargate.openSearchService.taskDefinition.taskRole.roleArn,
  // Phase 2b: stable private TLS MCP endpoint from the Fargate front door (Phase
  // 2a). Deterministic string, so no cross-stack dependency cycle is introduced.
  openSearchPrivateEndpoint: fargate.openSearchPrivateEndpoint,
  fgacMasterRoleArn,
  // Applied out-of-band (EC2/SSM + admin workstation) because the domain's private
  // subnet has no egress to STS/SNS/APS. Flip to true once egress exists.
  deployVpcCustomResources: false,
});
// Make the cross-stack ordering explicit (also enforced by the token references).
integration.addDependency(signalBridge);
integration.addDependency(fargate);

app.synth();
