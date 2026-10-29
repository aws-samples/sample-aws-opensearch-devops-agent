/**
 * Fargate MCP hosting stack (Phase 1 + Phase 2a — RUNNING servers + private front door).
 *
 * Hosts the OpenSearch-project-maintained MCP server container on **Amazon ECS
 * Fargate** in the imported obs-stack VPC.
 *
 * PHASE 1 (baseline): get the tasks RUNNING and LOGGING to CloudWatch, and able to
 * reach the VPC-private `obs-stack` OpenSearch domain (and the regional AMP endpoint).
 *
 * PHASE 2a (private MCP endpoint front door — this extension): put an **internal
 * Network Load Balancer with a TLS listener** in front of each Fargate service, and
 * publish **stable private DNS names** for them via a Route53 **private hosted zone**
 * (`mcp.internal`). This is the plumbing the DevOps Agent PrivateConnection/Service
 * (Phase 2b) will later dial. Phase 2b is intentionally NOT built here.
 *
 * WHY EXTEND THIS STACK (rather than a separate front-door stack)
 * ---------------------------------------------------------------
 * Registering an ECS service to an NLB target group sets the service's `loadBalancers`
 * to the target-group ARN, and ECS `CreateService` requires that target group to
 * already be associated with a listener. CDK therefore adds a dependency from the
 * service to the listener. If the NLB/listener lived in a separate stack, that
 * service->listener dependency PLUS the target-group-ARN cross-stack import would form
 * a dependency cycle between the two stacks. Keeping the NLB, listener, target group
 * and service in one stack avoids the cycle entirely, so Phase 2a is an extension of
 * this stack (deployable id `DevOpsAgent-FargateMcp`).
 *
 * NETWORKING (confirmed obs-stack coordinates)
 * --------------------------------------------
 * Secure-by-default, the tasks run in PRIVATE subnets with no public IP
 * (`assignPublicIp` defaults to false); egress to ECR / CloudWatch Logs / STS / AMP
 * is provided by a NAT gateway or (preferred) VPC interface/gateway endpoints.
 * They reach the VPC-private OpenSearch domain intra-VPC by sharing the domain's
 * security group (which allows intra-SG traffic).
 *
 * For a zero-NAT quickstart you may instead pass an IGW-routed PUBLIC subnet AND
 * set `assignPublicIp: true` explicitly — an opt-in, not the default.
 * The internal NLBs and the target ENIs all sit in the same subnet/SG, so the
 * TLS(8443) -> TCP(8000) path and the health checks stay intra-SG.
 *
 * TLS CERTS (self-signed, file-based, imported to ACM)
 * ----------------------------------------------------
 * The NLB TLS listener presents a self-signed cert whose CN/SAN equals the private
 * DNS name it fronts (`opensearch-mcp.mcp.internal`, ~10-year validity). The cert+key PEMs are generated OUT OF BAND (deterministically,
 * once) by `mcp-servers/tls/generate.sh`. They are git-ignored (a private key must
 * not be committed), so `generate.sh` MUST be run before the first `cdk synth` (CI
 * does this as a step). They are read at `cdk synth` time and imported into ACM via an `AwsCustomResource` calling
 * `acm:ImportCertificate`. File-based (rather than generating a fresh cert inside
 * synth) keeps synth deterministic — no per-synth cert churn / re-import on every
 * deploy. See `mcp-servers/tls/README.md`.
 *
 * IMAGES / PLATFORM
 * -----------------
 * The container image is **arm64** in ECR, so the task definition sets
 * `runtimePlatform` to `{ cpuArchitecture: ARM64, operatingSystemFamily: LINUX }`.
 * The container serves MCP (streamable-HTTP) on `0.0.0.0:8000`.
 *
 * IAM
 * ---
 * One shared execution role (managed `AmazonECSTaskExecutionRolePolicy` — ECR pull +
 * logs). One least-privilege task role built from the shared pure policy builder in
 * `lib/iam/policies.ts`:
 *   - OpenSearch task role: read-only `es:ESHttpGet`/`es:ESHttpPost` on the domain.
 *
 * _Requirements: 5.2, 6.1, 6.4_
 */

import * as fs from "fs";
import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53targets from "aws-cdk-lib/aws-route53-targets";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

import { REGION } from "../types";
import { buildOpenSearchMcpRolePolicy } from "../iam/policies";

/** CloudWatch log group name for the MCP service. */
const OPENSEARCH_LOG_GROUP = "/ecs/devops-agent-opensearch-mcp";

/** Port both maintained MCP servers listen on (streamable-HTTP). */
const MCP_PORT = 8000;

/** TLS listener port on each internal NLB (Phase 2a private front door). */
const NLB_TLS_PORT = 8443;

/** Container id/name (ECS uses the construct id as the container name). */
const OPENSEARCH_CONTAINER_NAME = "OpenSearchMcpContainer";

/** Private hosted zone + stable per-service DNS name (Phase 2a). */
const PRIVATE_ZONE_NAME = "mcp.internal";
const OPENSEARCH_DNS_NAME = `opensearch-mcp.${PRIVATE_ZONE_NAME}`;

/** Directory holding the self-signed TLS PEMs (generated by generate.sh). */
const TLS_DIR = path.join(__dirname, "..", "..", "mcp-servers", "tls");

/**
 * Props for {@link FargateMcpStack}.
 *
 * The VPC, networking (`subnetIds` + `securityGroupId`) and the OpenSearch/AMP
 * coordinates reference the ALREADY-DEPLOYED observability stack and are supplied by
 * the caller (the CDK app entry point).
 */
export interface FargateMcpStackProps extends cdk.StackProps {
  /** The imported obs-stack VPC in which the Fargate cluster + services run. */
  readonly vpc: ec2.IVpc;

  /**
   * Subnet ID(s) the Fargate tasks are placed in. At least one is required.
   *
   * Secure-by-default is PRIVATE subnets (`assignPublicIp` unset/false): tasks then
   * egress to ECR / CloudWatch Logs / STS / AMP via a NAT gateway or (preferred)
   * VPC interface/gateway endpoints, with no public IP. Only supply PUBLIC
   * (IGW-routed) subnets when you also set `assignPublicIp: true` for a quickstart.
   */
  readonly subnetIds: string[];

  /**
   * Assign a public IP to the task ENIs. Defaults to `false` (secure-by-default:
   * no public IP; private subnets + NAT/VPC endpoints provide egress).
   *
   * Set `true` ONLY as an explicit opt-in to reuse an existing IGW-routed PUBLIC
   * subnet without provisioning NAT/VPC endpoints (e.g. the bundled single-subnet
   * demo). The task security group still restricts all ingress.
   */
  readonly assignPublicIp?: boolean;

  /**
   * Security group ID applied to the task ENIs. Shared with the OpenSearch domain so
   * intra-SG traffic reaches the VPC-private domain endpoint.
   */
  readonly securityGroupId: string;

  /**
   * HTTPS endpoint of the VPC-private `obs-stack` OpenSearch domain (with scheme),
   * e.g. `https://vpc-obs-stack-....us-east-1.es.amazonaws.com`. Passed to the
   * OpenSearch MCP container as `OPENSEARCH_URL`.
   */
  readonly opensearchEndpoint: string;

  /** Container image URI (arm64) for the OpenSearch MCP server. */
  readonly openSearchImageUri: string;
}

/**
 * Stack that hosts the two maintained MCP evidence servers on ECS Fargate (Phase 1:
 * RUNNING + LOGGING + able to reach the VPC-private OpenSearch domain).
 */
export class FargateMcpStack extends cdk.Stack {
  /** The ECS Fargate cluster hosting both services. */
  public readonly cluster: ecs.Cluster;

  /** The OpenSearch MCP Fargate service. */
  public readonly openSearchService: ecs.FargateService;

  /** Phase 2a: the Route53 private hosted zone (`mcp.internal`). */
  public readonly privateHostedZone: route53.PrivateHostedZone;

  /** Phase 2a: internal NLB fronting the OpenSearch MCP service (TLS 8443). */
  public readonly openSearchNlb: elbv2.NetworkLoadBalancer;

  /** Phase 2a: stable private HTTPS MCP endpoint for OpenSearch. */
  public readonly openSearchPrivateEndpoint: string = `https://${OPENSEARCH_DNS_NAME}:${NLB_TLS_PORT}/mcp`;

  constructor(scope: Construct, id: string, props: FargateMcpStackProps) {
    super(scope, id, props);

    if (props.subnetIds.length === 0) {
      throw new Error(
        "FargateMcpStack requires at least one subnet ID for the Fargate services.",
      );
    }

    // -----------------------------------------------------------------------
    // Cluster (in the imported obs-stack VPC).
    // -----------------------------------------------------------------------
    this.cluster = new ecs.Cluster(this, "McpCluster", {
      clusterName: "devops-agent-mcp",
      vpc: props.vpc,
    });

    // -----------------------------------------------------------------------
    // Shared execution role — ECR pull + CloudWatch Logs.
    // -----------------------------------------------------------------------
    const executionRole = new iam.Role(this, "McpTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description:
        "Shared ECS task execution role for the maintained MCP services (ECR pull + CloudWatch Logs).",
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy",
        ),
      ],
    });

    // -----------------------------------------------------------------------
    // Import the shared security group + resolve the target subnets.
    // -----------------------------------------------------------------------
    const securityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "McpSecurityGroup",
      props.securityGroupId,
      // Import mutable so this stack can GUARANTEE the intra-SG mesh the private
      // front door depends on (see the self-referencing rule below). CDK emits a
      // standalone AWS::EC2::SecurityGroupIngress resource rather than editing the
      // SG inline, so it does not disturb rules the observability stack owns.
      { mutable: true },
    );

    // The NLB (TLS 8443), the Fargate task (TCP 8000), the DevOps Agent
    // PrivateConnection, and the OpenSearch domain all sit in this shared SG, so
    // the front door only works if its members can reach each other. A clean
    // observability-stack SG ships an allow-all-from-self rule that provides this;
    // a reused or rule-stripped SG may not — which breaks the NLB health check on
    // 8000 and the agent's TLS handshake to .../mcp on 8443. Ensure it explicitly
    // rather than assuming the imported SG already has it.
    securityGroup.addIngressRule(
      securityGroup,
      ec2.Port.allTraffic(),
      // NOTE: EC2 SG rule descriptions reject '>' (allowed set: a-zA-Z0-9. _-:/()#,@[]+=&;{}!$*),
      // so this is worded without arrows.
      "MCP intra-SG mesh: agent to NLB 8443, NLB to task 8000, task to domain 443",
    );

    const vpcSubnets: ec2.SubnetSelection = {
      subnets: props.subnetIds.map((subnetId, index) =>
        ec2.Subnet.fromSubnetId(this, `McpSubnet${index}`, subnetId),
      ),
    };

    const runtimePlatform: ecs.RuntimePlatform = {
      cpuArchitecture: ecs.CpuArchitecture.ARM64,
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    };

    // -----------------------------------------------------------------------
    // OpenSearch MCP — task role, log group, task definition, service.
    // -----------------------------------------------------------------------
    // NOTE: intentionally NOT setting a fixed roleName. The CDK-generated physical
    // name is stable across stack updates, and it is the role you have already
    // FGAC-mapped to `readall_and_monitor` on the domain
    // (DevOpsAgent-FargateMcp-OpenSearchMcpTaskRoleE62E5B7-i0tTUhFWJDW7). Renaming
    // it would REPLACE the role and break that mapping, so it is left auto-named.
    const openSearchTaskRole = new iam.Role(this, "OpenSearchMcpTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description:
        "Read-only task role for the OpenSearch MCP service (es:ESHttpGet/ESHttpPost on the domain).",
    });
    openSearchTaskRole.attachInlinePolicy(
      new iam.Policy(this, "OpenSearchMcpTaskPolicy", {
        document: iam.PolicyDocument.fromJson(buildOpenSearchMcpRolePolicy()),
      }),
    );

    const openSearchLogGroup = new logs.LogGroup(this, "OpenSearchMcpLogGroup", {
      logGroupName: OPENSEARCH_LOG_GROUP,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const openSearchTaskDef = new ecs.FargateTaskDefinition(
      this,
      "OpenSearchMcpTaskDef",
      {
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform,
        executionRole,
        taskRole: openSearchTaskRole,
      },
    );
    openSearchTaskDef.addContainer(OPENSEARCH_CONTAINER_NAME, {
      image: ecs.ContainerImage.fromRegistry(props.openSearchImageUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "opensearch",
        logGroup: openSearchLogGroup,
      }),
      portMappings: [{ containerPort: MCP_PORT }],
      environment: {
        OPENSEARCH_URL: props.opensearchEndpoint,
        AWS_REGION: REGION,
        MCP_TRANSPORT: "stream",
        MCP_HOST: "0.0.0.0",
        MCP_PORT: String(MCP_PORT),
        OPENSEARCH_ENABLED_CATEGORIES: "observability",
        OPENSEARCH_SSL_VERIFY: "true",
      },
    });

    this.openSearchService = new ecs.FargateService(this, "OpenSearchMcpService", {
      cluster: this.cluster,
      taskDefinition: openSearchTaskDef,
      desiredCount: 1,
      // Secure-by-default: no public IP unless explicitly opted in.
      assignPublicIp: props.assignPublicIp ?? false,
      vpcSubnets,
      securityGroups: [securityGroup],
    });

    // =======================================================================
    // PHASE 2a — private MCP endpoint front door.
    //
    // For each Fargate service: an internal NLB with a TLS listener on 8443 that
    // forwards to a TCP:8000 target group registered with the service, plus a
    // stable Route53 alias record in the `mcp.internal` private hosted zone. The
    // TLS listener presents a self-signed cert (CN/SAN = the private DNS name)
    // imported into ACM at deploy time.
    // =======================================================================

    // Route53 private hosted zone associated with the imported obs VPC.
    this.privateHostedZone = new route53.PrivateHostedZone(this, "McpPrivateZone", {
      zoneName: PRIVATE_ZONE_NAME,
      vpc: props.vpc,
      comment: "Private DNS for the internal MCP endpoints (Phase 2a front door).",
    });

    // Import the self-signed cert+key PEMs (generated out-of-band) into ACM.
    const openSearchCertArn = this.importSelfSignedCert(
      "OpenSearchMcp",
      "opensearch-mcp",
    );

    // Build the front door (NLB + TLS listener + target group + DNS record).
    this.openSearchNlb = this.buildServiceFrontDoor({
      idPrefix: "OpenSearchMcp",
      service: this.openSearchService,
      containerName: OPENSEARCH_CONTAINER_NAME,
      certificateArn: openSearchCertArn,
      recordName: "opensearch-mcp",
      vpc: props.vpc,
      vpcSubnets,
      securityGroup,
    });

    // -----------------------------------------------------------------------
    // Outputs — cluster name, service names, and log group names.
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, "ClusterName", {
      value: this.cluster.clusterName,
      description: "ECS Fargate cluster hosting the maintained MCP services.",
    });
    new cdk.CfnOutput(this, "OpenSearchServiceName", {
      value: this.openSearchService.serviceName,
      description: "OpenSearch MCP Fargate service name.",
    });
    new cdk.CfnOutput(this, "OpenSearchLogGroupName", {
      value: openSearchLogGroup.logGroupName,
      description: "CloudWatch log group for the OpenSearch MCP service.",
    });

    // ---- Phase 2a front-door outputs -------------------------------------
    new cdk.CfnOutput(this, "OpenSearchMcpPrivateEndpoint", {
      value: this.openSearchPrivateEndpoint,
      description:
        "Private HTTPS MCP endpoint for the OpenSearch server (TLS via internal NLB).",
    });
    new cdk.CfnOutput(this, "OpenSearchNlbDnsName", {
      value: this.openSearchNlb.loadBalancerDnsName,
      description: "DNS name of the internal NLB fronting the OpenSearch MCP service.",
    });
    new cdk.CfnOutput(this, "McpPrivateHostedZoneId", {
      value: this.privateHostedZone.hostedZoneId,
      description: "Route53 private hosted zone id for mcp.internal.",
    });
    new cdk.CfnOutput(this, "OpenSearchMcpCertificateArn", {
      value: openSearchCertArn,
      description: "ACM ARN of the imported OpenSearch MCP TLS certificate.",
    });
  }

  /**
   * Import a committed self-signed cert+key (PEM) into ACM via an
   * `AwsCustomResource` calling `acm:ImportCertificate`. Returns the imported
   * certificate ARN (resolved from the API response). The certificate is deleted
   * on stack removal; because the NLB listener references this ARN, CloudFormation
   * tears the listener down first, so `acm:DeleteCertificate` does not fail with
   * "in use".
   *
   * @param idPrefix  Construct-id prefix (e.g. `OpenSearchMcp`).
   * @param baseName  PEM file basename under `mcp-servers/tls/` (e.g. `opensearch-mcp`).
   */
  private importSelfSignedCert(idPrefix: string, baseName: string): string {
    const certPem = fs.readFileSync(
      path.join(TLS_DIR, `${baseName}-cert.pem`),
      "utf8",
    );
    const keyPem = fs.readFileSync(
      path.join(TLS_DIR, `${baseName}-key.pem`),
      "utf8",
    );

    const importer = new cr.AwsCustomResource(this, `${idPrefix}CertImport`, {
      resourceType: "Custom::AcmImportedCertificate",
      installLatestAwsSdk: false,
      onCreate: {
        service: "ACM",
        action: "importCertificate",
        parameters: { Certificate: certPem, PrivateKey: keyPem },
        physicalResourceId: cr.PhysicalResourceId.fromResponse("CertificateArn"),
      },
      // Re-import against the existing ARN when the PEM content changes (rotation).
      onUpdate: {
        service: "ACM",
        action: "importCertificate",
        parameters: {
          Certificate: certPem,
          PrivateKey: keyPem,
          CertificateArn: new cr.PhysicalResourceIdReference(),
        },
        physicalResourceId: cr.PhysicalResourceId.fromResponse("CertificateArn"),
      },
      onDelete: {
        service: "ACM",
        action: "deleteCertificate",
        parameters: { CertificateArn: new cr.PhysicalResourceIdReference() },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        // ImportCertificate mints a NEW ARN, so it cannot be resource-scoped ahead
        // of the call — "*" is required by the API.
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["acm:ImportCertificate"],
          resources: ["*"],
        }),
        // Delete/AddTags act on an already-known certificate — scope them to this
        // account/region's ACM certificates (the specific cert id is only known at
        // runtime, but this bounds the blast radius to ACM certs we could have made).
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["acm:DeleteCertificate", "acm:AddTagsToCertificate"],
          resources: [`arn:aws:acm:${this.region}:${this.account}:certificate/*`],
        }),
      ]),
    });

    return importer.getResponseField("CertificateArn");
  }

  /**
   * Build the internal front door for one Fargate service: an internal NLB with a
   * TLS listener on {@link NLB_TLS_PORT} forwarding to a TCP:{@link MCP_PORT} target
   * group registered with the service, plus a Route53 alias A record. Returns the NLB.
   */
  private buildServiceFrontDoor(opts: {
    idPrefix: string;
    service: ecs.FargateService;
    containerName: string;
    certificateArn: string;
    recordName: string;
    vpc: ec2.IVpc;
    vpcSubnets: ec2.SubnetSelection;
    securityGroup: ec2.ISecurityGroup;
  }): elbv2.NetworkLoadBalancer {
    // Internal NLB in the obs subnet/SG.
    const nlb = new elbv2.NetworkLoadBalancer(this, `${opts.idPrefix}Nlb`, {
      vpc: opts.vpc,
      internetFacing: false,
      vpcSubnets: opts.vpcSubnets,
      securityGroups: [opts.securityGroup],
    });

    // TCP:8000 target group; register the Fargate service as an IP target.
    const targetGroup = new elbv2.NetworkTargetGroup(
      this,
      `${opts.idPrefix}TargetGroup`,
      {
        vpc: opts.vpc,
        port: MCP_PORT,
        protocol: elbv2.Protocol.TCP,
        targetType: elbv2.TargetType.IP,
        targets: [
          opts.service.loadBalancerTarget({
            containerName: opts.containerName,
            containerPort: MCP_PORT,
          }),
        ],
        // Plain TCP health check on the MCP port (container serves HTTP, but a TCP
        // connect is the least-assuming liveness signal for the NLB).
        healthCheck: {
          protocol: elbv2.Protocol.TCP,
        },
      },
    );

    // TLS listener on 8443 presenting the imported ACM cert, forwarding to 8000.
    nlb.addListener(`${opts.idPrefix}TlsListener`, {
      port: NLB_TLS_PORT,
      protocol: elbv2.Protocol.TLS,
      certificates: [elbv2.ListenerCertificate.fromArn(opts.certificateArn)],
      defaultTargetGroups: [targetGroup],
    });

    // Stable private DNS: alias A record -> the internal NLB.
    new route53.ARecord(this, `${opts.idPrefix}AliasRecord`, {
      zone: this.privateHostedZone,
      recordName: opts.recordName,
      target: route53.RecordTarget.fromAlias(
        new route53targets.LoadBalancerTarget(nlb),
      ),
    });

    return nlb;
  }
}
