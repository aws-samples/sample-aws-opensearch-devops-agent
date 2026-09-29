/**
 * FGAC role-mapping custom resource (Component: IAM & Security — task 11.2).
 *
 * This construct maps the MCP AgentCore Runtime execution role ARN into a
 * **read-only FGAC role** on the `obs-stack` OpenSearch domain at deploy time, so
 * the MCP evidence server's SigV4 requests are authorized inside OpenSearch
 * security. It realizes the design's "FGAC role mapping on the domain" section:
 *
 *   - Creates a scoped read-only FGAC role via
 *     `PUT _plugins/_security/api/roles/<name>` restricted to the three index
 *     patterns (`logs-otel-v1*`, `otel-v1-apm-span*`, `otel-v2-apm-service-map*`)
 *     with `read`/`search` + `indices:data/read/*` and cluster monitor permissions.
 *   - Maps that role's `backend_roles` to the MCP execution role ARN via
 *     `PUT _plugins/_security/api/rolesmapping/<name>`.
 *
 * Both calls are `PUT` (create-or-update), so the custom resource is **idempotent**
 * across stack updates. All work happens in a Lambda-backed custom resource
 * ({@link fgac-mapping.handler}) that signs the security-API calls with SigV4 over
 * TLS.
 *
 * AUTHENTICATING AS THE FGAC MASTER (`role/Admin`)
 * ------------------------------------------------
 * The domain security API only accepts calls from a security-admin identity. The
 * `obs-stack` domain's FGAC master is IAM `role/Admin`. This construct supports the
 * master-role approach two ways via {@link FgacRoleMappingProps.master}:
 *
 *   - `{ mode: "runAs", role }` (recommended when `role/Admin` can be assumed by
 *     Lambda): the custom-resource Lambda **runs as** the provided master role, so
 *     its own SigV4 credentials are already the FGAC master. The master role must
 *     trust `lambda.amazonaws.com`.
 *   - `{ mode: "assume", roleArn }`: the Lambda runs with a dedicated
 *     least-privilege execution role and **assumes** the master role at runtime
 *     (STS) before signing. The CR role is granted only `sts:AssumeRole` on the
 *     master plus the least-privilege `es:ESHttp*` on the domain security path.
 *
 * In both cases the CR execution role is granted least-privilege domain access
 * (`es:ESHttpPut`/`es:ESHttpGet`/`es:ESHttpDelete` scoped to the domain security
 * API path only) so the deployed role mirrors the design's least-privilege intent
 * (R6.1/R6.3). No static keys are used; SigV4 credentials come from the role
 * (R6.2). The domain is VPC-private, so VPC placement is supported via
 * {@link FgacRoleMappingProps.vpc} and friends.
 *
 * _Requirements: 6.1, 6.3, 6.6_
 */

import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as customresources from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

import { ACCOUNT, REGION } from "../types";

/** Default read-only FGAC role name created/mapped on the domain. */
const DEFAULT_FGAC_ROLE_NAME = "devops_agent_mcp_readonly";

/** The three index patterns the read-only role is restricted to (design default). */
export const DEFAULT_INDEX_PATTERNS: readonly string[] = [
  "logs-otel-v1*",
  "otel-v1-apm-span*",
  "otel-v2-apm-service-map*",
];

/**
 * How the custom-resource Lambda authenticates as the domain's FGAC master.
 *
 * - `runAs`: use the provided master role directly as the Lambda execution role
 *   (it must trust `lambda.amazonaws.com` and be the FGAC master / a security-admin).
 * - `assume`: keep a dedicated least-privilege CR role and assume the master role
 *   ARN at runtime via STS before signing.
 */
export type MasterIdentity =
  | { readonly mode: "runAs"; readonly role: iam.IRole }
  | { readonly mode: "assume"; readonly roleArn: string };

/** Props for {@link FgacRoleMapping}. */
export interface FgacRoleMappingProps {
  /**
   * HTTPS endpoint (or bare host) of the VPC-private `obs-stack` domain, e.g.
   * `vpc-obs-stack-....ap-southeast-2.es.amazonaws.com`.
   */
  readonly domainEndpoint: string;

  /**
   * ARN of the OpenSearch domain. Used to scope the CR role's `es:ESHttp*` grant
   * to the domain's security API path.
   */
  readonly domainArn: string;

  /** The MCP AgentCore Runtime execution role ARN to map as a backend role. */
  readonly mcpExecutionRoleArn: string;

  /**
   * How the CR Lambda authenticates as the FGAC master (`role/Admin` or a role
   * mapped as security admin). See {@link MasterIdentity}.
   */
  readonly master: MasterIdentity;

  /** Index patterns the read-only role is restricted to. Defaults to the three. */
  readonly indexPatterns?: string[];

  /** Name of the FGAC role to create/map. Defaults to `devops_agent_mcp_readonly`. */
  readonly fgacRoleName?: string;

  /**
   * VPC to place the CR Lambda in so it can reach the VPC-private domain over TLS.
   * Required for a VPC-private domain; omit only if the domain is reachable
   * without VPC attachment.
   */
  readonly vpc?: ec2.IVpc;

  /** Security group ID for the CR Lambda's ENIs (egress to the domain, 443). */
  readonly securityGroupId?: string;

  /** Subnet ID(s) in which the CR Lambda runs. Required when {@link vpc} is set. */
  readonly subnetIds?: string[];
}

/**
 * Lambda-backed custom resource that maps the MCP execution role into a read-only
 * FGAC role on the domain.
 */
export class FgacRoleMapping extends Construct {
  /** The onEvent Lambda that drives the security API. */
  public readonly onEventFunction: NodejsFunction;

  /** The custom resource whose lifecycle applies/removes the mapping. */
  public readonly resource: cdk.CustomResource;

  /** The name of the FGAC role created/mapped on the domain. */
  public readonly fgacRoleName: string;

  constructor(scope: Construct, id: string, props: FgacRoleMappingProps) {
    super(scope, id);

    this.fgacRoleName = props.fgacRoleName ?? DEFAULT_FGAC_ROLE_NAME;
    const indexPatterns = props.indexPatterns ?? [...DEFAULT_INDEX_PATTERNS];

    if (props.vpc && (!props.subnetIds || props.subnetIds.length === 0)) {
      throw new Error(
        "FgacRoleMapping: subnetIds are required when a vpc is provided (VPC-private domain)."
      );
    }

    // -----------------------------------------------------------------------
    // Execution role selection (run-as-master vs least-privilege + assume).
    // -----------------------------------------------------------------------
    // Least-privilege domain grant: es:ESHttp{Put,Get,Delete} scoped to the domain
    // security API path only (no wildcard action; resource scoped to the domain).
    const securityApiResource = `${props.domainArn}/_plugins/_security/*`;
    const domainSecurityStatement = new iam.PolicyStatement({
      sid: "DomainSecurityApiReadWrite",
      effect: iam.Effect.ALLOW,
      actions: ["es:ESHttpPut", "es:ESHttpGet", "es:ESHttpDelete"],
      resources: [securityApiResource],
    });

    let executionRole: iam.IRole;
    let masterRoleArnEnv: string | undefined;

    if (props.master.mode === "runAs") {
      // The Lambda runs directly as the FGAC master role.
      executionRole = props.master.role;
      // Additively grant the least-privilege security-API access (harmless if the
      // master already permits it) so the deployed identity's domain access is
      // explicit and scoped.
      props.master.role.addToPrincipalPolicy(domainSecurityStatement);
    } else {
      // Dedicated least-privilege CR role that assumes the master at runtime.
      const crRole = new iam.Role(this, "FgacCrRole", {
        description:
          "Least-privilege execution role for the FGAC role-mapping custom resource (assumes the FGAC master to sign security-API calls).",
        assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      });
      crRole.addToPolicy(domainSecurityStatement);
      crRole.addToPolicy(
        new iam.PolicyStatement({
          sid: "AssumeFgacMaster",
          effect: iam.Effect.ALLOW,
          actions: ["sts:AssumeRole"],
          resources: [props.master.roleArn],
        })
      );
      executionRole = crRole;
      masterRoleArnEnv = props.master.roleArn;
    }

    // -----------------------------------------------------------------------
    // Optional VPC placement (VPC-private domain).
    // -----------------------------------------------------------------------
    const vpcConfig: {
      vpc?: ec2.IVpc;
      vpcSubnets?: ec2.SubnetSelection;
      securityGroups?: ec2.ISecurityGroup[];
    } = {};
    if (props.vpc) {
      const securityGroups = props.securityGroupId
        ? [
            ec2.SecurityGroup.fromSecurityGroupId(
              this,
              "FgacCrSg",
              props.securityGroupId
            ),
          ]
        : undefined;
      const subnets = (props.subnetIds ?? []).map((subnetId, index) =>
        ec2.Subnet.fromSubnetId(this, `FgacCrSubnet${index}`, subnetId)
      );
      vpcConfig.vpc = props.vpc;
      vpcConfig.vpcSubnets = { subnets };
      if (securityGroups) {
        vpcConfig.securityGroups = securityGroups;
      }
      // A VPC Lambda needs ENI lifecycle permissions on its execution role.
      executionRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: "VpcEni",
          effect: iam.Effect.ALLOW,
          actions: [
            "ec2:CreateNetworkInterface",
            "ec2:DescribeNetworkInterfaces",
            "ec2:DeleteNetworkInterface",
          ],
          resources: [`arn:aws:ec2:${REGION}:${ACCOUNT}:network-interface/*`],
          conditions: { StringEquals: { "aws:RequestedRegion": REGION } },
        })
      );
      // Because a custom `role:` is supplied, CDK does NOT auto-attach the managed
      // VPC-access policy. The narrow inline `VpcEni` statement is insufficient:
      // `ec2:CreateNetworkInterface` authorizes against the subnet AND security-group
      // ARNs (not just `network-interface/*`), and `ec2:DescribeNetworkInterfaces`
      // only supports `Resource: "*"`. Attach the AWS-managed VPC access policy as
      // the authoritative ENI grant for the in-VPC OnEvent Lambda.
      executionRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole"
        )
      );
    }

    // Ensure the execution role can write logs (CreateLogGroup/Stream/PutLogEvents).
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "Logs",
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [`arn:aws:logs:${REGION}:${ACCOUNT}:*`],
      })
    );

    // -----------------------------------------------------------------------
    // onEvent Lambda (Node.js 20), entry = lib/deploy/fgac-mapping.handler.ts.
    // -----------------------------------------------------------------------
    this.onEventFunction = new NodejsFunction(this, "OnEventFunction", {
      description:
        "FGAC role-mapping custom resource: create/update a read-only FGAC role and map the MCP execution role via the OpenSearch security API (SigV4/TLS).",
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "fgac-mapping.handler.ts"),
      handler: "handler",
      role: executionRole,
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      ...vpcConfig,
      environment: {
        ...(masterRoleArnEnv ? { MASTER_ROLE_ARN: masterRoleArnEnv } : {}),
      },
      bundling: {
        // AWS SDK v3 (only used lazily for the optional STS assume) is on the
        // Node.js 20 Lambda runtime image — do not bundle it.
        externalModules: ["@aws-sdk/client-sts"],
        target: "node20",
        minify: false,
        sourceMap: true,
      },
    });

    // -----------------------------------------------------------------------
    // Provider + custom resource. Properties are passed to the handler; changing
    // any of them re-runs the (idempotent) apply on the next update.
    // -----------------------------------------------------------------------
    const provider = new customresources.Provider(this, "FgacProvider", {
      onEventHandler: this.onEventFunction,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.resource = new cdk.CustomResource(this, "FgacMapping", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::FgacRoleMapping",
      properties: {
        DomainEndpoint: props.domainEndpoint,
        McpExecutionRoleArn: props.mcpExecutionRoleArn,
        FgacRoleName: this.fgacRoleName,
        IndexPatterns: indexPatterns.join(","),
        Region: REGION,
        ...(masterRoleArnEnv ? { MasterRoleArn: masterRoleArnEnv } : {}),
      },
    });
  }
}
