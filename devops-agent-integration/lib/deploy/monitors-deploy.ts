/**
 * Monitors deployment custom resource (Component 1 deployment wiring).
 *
 * At `cdk deploy` time this construct registers the incident-detection monitors
 * against the already-deployed observability stack, wiring every monitor's
 * notification action to the Signal_Bridge SNS topic from task 10.1:
 *
 *   1. OpenSearch Alerting monitors — the three JSON monitor definitions in
 *      `monitors/` (`M-logs-error-rate`, `M-trace-latency-slo`,
 *      `M-servicemap-anomaly`) are POSTed to the domain's
 *      `_plugins/_alerting/monitors` API over TLS with SigV4. Before posting, the
 *      handler creates (or references) an OpenSearch **Notifications channel** of
 *      type SNS pointing at `snsTopicArn`, then substitutes the
 *      `<sns-notification-channel-id>` placeholder in each monitor's
 *      `destination_id` with the real channel id (R2.5).
 *   2. AMP alerting — the rule group YAML (`monitors/amp/rule-group.yaml`) is applied
 *      via the AMP `PutRuleGroupsNamespace` control-plane API and the Alertmanager
 *      config (`monitors/amp/alertmanager.yaml`) via `PutAlertManagerDefinition`,
 *      with the Alertmanager receiver's `topic_arn` rewritten to `snsTopicArn` so the
 *      firing AMP alert notifies the same Signal_Bridge topic (R3.5).
 *
 * Implementation notes:
 *   - The work runs in a Lambda-backed {@link cr.Provider} custom resource. The
 *     handler (`monitors-deploy.handler.ts`) is intentionally dependency-free: it
 *     signs OpenSearch (`es`) and AMP (`aps`) requests with a hand-rolled SigV4
 *     signer built only on node `https` + `crypto`, using the Lambda execution
 *     role's credentials from the standard `AWS_*` environment variables. This
 *     mirrors the repo convention (see `lib/signal-bridge/handler.ts`) of avoiding a
 *     hard `@aws-sdk/*` build/type dependency.
 *   - The `obs-stack` OpenSearch domain is VPC-private, so when VPC coordinates are
 *     supplied the handler Lambda's ENIs are placed in the domain's VPC. The
 *     {@link cr.Provider} framework Lambda stays outside the VPC (it only invokes the
 *     handler via the Lambda service), so only the handler needs ENI permissions.
 *   - Monitor/rule/Alertmanager bodies are read at synth time and passed as custom
 *     resource properties, so any edit to a definition file re-triggers the resource.
 *
 * Least-privilege: when this construct creates the handler role it attaches only the
 * scoped actions required — `es:ESHttpGet/Post/Put/Delete` on the domain,
 * `aps:*RuleGroupsNamespace`/`*AlertManagerDefinition`/`Describe*` on the workspace,
 * `sns:CreateTopic/Subscribe/GetTopicAttributes` on the topic, region-conditioned VPC
 * ENI lifecycle, and log-stream writes — all pinned to `111122223333` /
 * `ap-southeast-2`. A caller may instead pass a pre-built `role`.
 *
 * _Requirements: 2.5, 3.5_
 */

import * as fs from "fs";
import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

import { ACCOUNT, REGION } from "../types";

/** Default AMP rule-group namespace name (matches `monitors/amp/rule-group.yaml`). */
const DEFAULT_RULE_GROUP_NAMESPACE = "devops-agent-integration";

/** Stable name for the OpenSearch Notifications SNS channel this resource creates. */
const DEFAULT_NOTIFICATION_CHANNEL_NAME = "devops-agent-alerts-sns";

/** Handler Lambda function name (also scopes its log-group ARN in the role policy). */
const HANDLER_FUNCTION_NAME = "devops-agent-monitors-deploy";

/** The three OpenSearch Alerting monitor definition files, in `monitors/`. */
const OPENSEARCH_MONITOR_FILES = [
  "M-logs-error-rate.json",
  "M-trace-latency-slo.json",
  "M-servicemap-anomaly.json",
] as const;

/**
 * Props for {@link MonitorsDeployment}.
 */
export interface MonitorsDeploymentProps {
  /**
   * HTTPS endpoint of the VPC-private `obs-stack` OpenSearch domain, without a
   * scheme, e.g. `vpc-obs-stack-....ap-southeast-2.es.amazonaws.com`.
   */
  readonly domainEndpoint: string;

  /**
   * ARN of the OpenSearch domain, e.g.
   * `arn:aws:es:ap-southeast-2:111122223333:domain/obs-stack`. Used to scope the
   * handler's `es:ESHttp*` grants.
   */
  readonly domainArn: string;

  /** AMP workspace id, e.g. `ws-11111111-2222-3333-4444-555555555555`. */
  readonly ampWorkspaceId: string;

  /**
   * AMP workspace ARN, e.g.
   * `arn:aws:aps:ap-southeast-2:111122223333:workspace/ws-...`. Used to scope the
   * handler's `aps:*` grants.
   */
  readonly ampWorkspaceArn: string;

  /**
   * ARN of the Signal_Bridge SNS topic (from task 10.1). Wired into both the
   * OpenSearch Notifications channel and the AMP Alertmanager receiver.
   */
  readonly snsTopicArn: string;

  /**
   * Optional IAM role assumed by OpenSearch Notifications to publish to the SNS
   * topic. When supplied it is referenced by the created Notifications channel and
   * the handler is granted `iam:PassRole` on it.
   */
  readonly snsNotificationRoleArn?: string;

  /** AMP rule-group namespace name. Defaults to `devops-agent-integration`. */
  readonly ruleGroupNamespaceName?: string;

  /**
   * VPC in which to place the handler Lambda's ENIs so it can reach the VPC-private
   * OpenSearch domain. Required in practice for the private `obs-stack` domain; if
   * omitted the handler runs outside any VPC (only works for a public domain).
   */
  readonly vpc?: ec2.IVpc;

  /** Security group id applied to the handler Lambda's ENIs (needs egress to 443). */
  readonly securityGroupId?: string;

  /** Subnet id(s) in which the handler Lambda runs. */
  readonly subnetIds?: string[];

  /**
   * Optional pre-built execution role for the handler Lambda. When omitted, a
   * least-privilege role is created and scoped to the domain/workspace/topic ARNs.
   */
  readonly role?: iam.IRole;
}

/**
 * CDK construct that deploys the OpenSearch Alerting monitors, the AMP rule group,
 * and the AMP Alertmanager definition, wiring all notifications to the Signal_Bridge
 * SNS topic.
 */
export class MonitorsDeployment extends Construct {
  /** The custom resource that performs the deployment on create/update. */
  public readonly resource: cdk.CustomResource;

  /** The Lambda-backed provider handler execution role (created or supplied). */
  public readonly handlerRole: iam.IRole;

  constructor(scope: Construct, id: string, props: MonitorsDeploymentProps) {
    super(scope, id);

    const inVpc = props.vpc !== undefined;
    if (inVpc && (!props.securityGroupId || (props.subnetIds ?? []).length === 0)) {
      throw new Error(
        "MonitorsDeployment: when `vpc` is set, `securityGroupId` and at least one `subnetIds` entry are required.",
      );
    }

    const ruleGroupNamespaceName =
      props.ruleGroupNamespaceName ?? DEFAULT_RULE_GROUP_NAMESPACE;

    // -----------------------------------------------------------------------
    // Read the monitor / rule / Alertmanager definitions at synth time. Passing
    // them as resource properties re-triggers the resource whenever a file changes.
    // -----------------------------------------------------------------------
    const monitorsDir = path.join(__dirname, "..", "..", "monitors");
    const openSearchMonitors = OPENSEARCH_MONITOR_FILES.map((file) => ({
      name: file.replace(/\.json$/, ""),
      body: fs.readFileSync(path.join(monitorsDir, file), "utf8"),
    }));
    const ruleGroupYaml = fs.readFileSync(
      path.join(monitorsDir, "amp", "rule-group.yaml"),
      "utf8",
    );
    const alertManagerYaml = fs.readFileSync(
      path.join(monitorsDir, "amp", "alertmanager.yaml"),
      "utf8",
    );

    // -----------------------------------------------------------------------
    // Execution role — least-privilege unless the caller supplies one.
    // -----------------------------------------------------------------------
    this.handlerRole = props.role ?? this.createLeastPrivilegeRole(props, inVpc);

    // -----------------------------------------------------------------------
    // Handler Lambda (Node.js 24). Runs in the domain's VPC when configured.
    // -----------------------------------------------------------------------
    const securityGroups =
      inVpc && props.securityGroupId
        ? [
            ec2.SecurityGroup.fromSecurityGroupId(
              this,
              "HandlerSg",
              props.securityGroupId,
            ),
          ]
        : undefined;
    const vpcSubnets =
      inVpc && props.subnetIds
        ? {
            subnets: props.subnetIds.map((subnetId, index) =>
              ec2.Subnet.fromSubnetId(this, `HandlerSubnet${index}`, subnetId),
            ),
          }
        : undefined;

    const onEventHandler = new NodejsFunction(this, "OnEventHandler", {
      functionName: HANDLER_FUNCTION_NAME,
      description:
        "Registers the OpenSearch Alerting monitors + AMP rule group / Alertmanager and wires them to the Signal_Bridge SNS topic (SigV4 over TLS).",
      runtime: lambda.Runtime.NODEJS_24_X,
      entry: path.join(__dirname, "monitors-deploy.handler.ts"),
      handler: "onEvent",
      role: this.handlerRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
      vpc: props.vpc,
      securityGroups,
      vpcSubnets,
      bundling: {
        target: "node24",
        minify: false,
        sourceMap: true,
      },
    });

    // -----------------------------------------------------------------------
    // Provider + custom resource.
    // -----------------------------------------------------------------------
    const provider = new cr.Provider(this, "Provider", {
      onEventHandler,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    this.resource = new cdk.CustomResource(this, "Resource", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::DevOpsAgentMonitorsDeployment",
      properties: {
        DomainEndpoint: props.domainEndpoint,
        Region: REGION,
        Account: ACCOUNT,
        SnsTopicArn: props.snsTopicArn,
        SnsNotificationRoleArn: props.snsNotificationRoleArn ?? "",
        NotificationChannelName: DEFAULT_NOTIFICATION_CHANNEL_NAME,
        OpenSearchMonitors: JSON.stringify(openSearchMonitors),
        AmpWorkspaceId: props.ampWorkspaceId,
        RuleGroupNamespaceName: ruleGroupNamespaceName,
        RuleGroupYaml: ruleGroupYaml,
        AlertManagerYaml: alertManagerYaml,
      },
    });
  }

  /**
   * Build the least-privilege execution role for the handler Lambda, scoped to the
   * specific domain, AMP workspace, and SNS topic ARNs (no wildcard actions/ARNs
   * beyond service resource-path scoping). All ARNs are pinned to the demo
   * account/region.
   */
  private createLeastPrivilegeRole(
    props: MonitorsDeploymentProps,
    inVpc: boolean,
  ): iam.Role {
    const role = new iam.Role(this, "HandlerRole", {
      roleName: "devops-agent-monitors-deploy-role",
      description:
        "Least-privilege role for the monitors deployment custom resource (OpenSearch alerting + AMP rules + SNS channel wiring).",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // OpenSearch data-plane: create/read/update (and delete on stack teardown) the
    // alerting monitors and the notifications channel via the `_plugins/*` APIs.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "OpenSearchAlertingAndNotifications",
        effect: iam.Effect.ALLOW,
        actions: [
          "es:ESHttpGet",
          "es:ESHttpPost",
          "es:ESHttpPut",
          "es:ESHttpDelete",
        ],
        resources: [`${props.domainArn}/*`],
      }),
    );

    // AMP control-plane: apply / update the rule group namespace and the
    // Alertmanager definition (with describe/create/delete for idempotency + teardown).
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "AmpRulesAndAlertmanager",
        effect: iam.Effect.ALLOW,
        actions: [
          "aps:CreateRuleGroupsNamespace",
          "aps:PutRuleGroupsNamespace",
          "aps:DescribeRuleGroupsNamespace",
          "aps:DeleteRuleGroupsNamespace",
          "aps:CreateAlertManagerDefinition",
          "aps:PutAlertManagerDefinition",
          "aps:DescribeAlertManagerDefinition",
          "aps:DeleteAlertManagerDefinition",
        ],
        resources: [props.ampWorkspaceArn],
      }),
    );

    // SNS: reference/create the topic the Notifications channel targets and allow
    // subscribing the delivery path. Scoped to the specific topic ARN.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "SnsTopicWiring",
        effect: iam.Effect.ALLOW,
        actions: [
          "sns:CreateTopic",
          "sns:Subscribe",
          "sns:GetTopicAttributes",
        ],
        resources: [props.snsTopicArn],
      }),
    );

    // If the Notifications channel references an SNS-publish role, allow passing it.
    if (props.snsNotificationRoleArn) {
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: "PassSnsNotificationRole",
          effect: iam.Effect.ALLOW,
          actions: ["iam:PassRole"],
          resources: [props.snsNotificationRoleArn],
        }),
      );
    }

    // Log-stream writes scoped to the handler's own log group.
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: "Logs",
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [
          `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/${HANDLER_FUNCTION_NAME}:*`,
        ],
      }),
    );

    // VPC ENI lifecycle (region-conditioned) when the handler runs in the domain VPC.
    if (inVpc) {
      role.addToPolicy(
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
        }),
      );
      // This construct supplies a custom `role:` to the in-VPC handler Lambda, so CDK
      // does NOT auto-attach the managed VPC-access policy. The narrow inline `VpcEni`
      // statement is insufficient: `ec2:CreateNetworkInterface` authorizes against the
      // subnet AND security-group ARNs (not just `network-interface/*`), and
      // `ec2:DescribeNetworkInterfaces` only supports `Resource: "*"`. Attach the
      // AWS-managed VPC access policy as the authoritative ENI grant.
      role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaVPCAccessExecutionRole",
        ),
      );
    }

    return role;
  }
}
