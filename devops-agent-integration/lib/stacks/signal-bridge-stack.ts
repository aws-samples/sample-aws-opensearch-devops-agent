/**
 * Signal_Bridge CDK stack (Component 2).
 *
 * Provisions the selected webhook Integration_Pattern that delivers a fired
 * Alert_Monitor to the DevOps Agent within 120 s, records delivery failures, and
 * retains undelivered alerts for redelivery (R1.4/R1.5). Per the design
 * ("Component 2: Signal_Bridge"), the sub-resources are:
 *
 *   - SNS topic `devops-agent-alerts` — the fan-in point the OpenSearch Alerting
 *     monitors and the AMP Alertmanager notify when they transition to triggered.
 *   - In-VPC translator Lambda (Node.js 20) fronted by the SNS topic. It parses the
 *     envelope, normalizes it into the DevOps Agent incident payload, HMAC-signs it,
 *     and POSTs it to the webhook. The handler lives at `lib/signal-bridge/handler.ts`.
 *   - SQS DLQ `devops-agent-alerts-dlq`. It is wired **both** as the Lambda's
 *     asynchronous dead-letter destination (failed invocations land here — the
 *     `sqs:SendMessage` grant) **and** as a redrive event source back into the same
 *     Lambda (`sqs:ReceiveMessage`/`DeleteMessage`) so undelivered alerts are
 *     retained and re-attempted (R1.5).
 *   - Secrets Manager secret `devops-agent/webhook-hmac` holding the webhook HMAC
 *     key. This secret is **owned by the operator** (created out-of-band with the
 *     HMAC value the DevOps Agent issues for the generic webhook — see the Quick
 *     Start) and is **imported by name** here, never created by this stack. That
 *     keeps the stack from generating a random key the DevOps Agent would reject,
 *     and avoids a name collision with the operator-created secret. Only the ARN is
 *     exposed; the Lambda reads the value at runtime via its execution role.
 *
 * The Lambda runs with the least-privilege execution role from task 9.1
 * ({@link buildSignalBridgeLambdaPolicy}): scoped Secrets read on the webhook secret,
 * DLQ consume/produce, region-conditioned VPC ENI lifecycle, and log-stream writes.
 * Because that policy grants `logs:CreateLogStream`/`PutLogEvents` but **not**
 * `logs:CreateLogGroup`, this stack pre-creates the Lambda's log group with the exact
 * name the policy scopes to, keeping the role's permissions an exact mirror of the
 * design's least-privilege document (no wildcards beyond service resource-path
 * scoping). All identifiers are pinned to the demo account/region via the
 * {@link ACCOUNT}/{@link REGION} containment constants (R1.7, R6.7).
 *
 * NOTE ON BUNDLING: the translator Lambda is provisioned with
 * {@link NodejsFunction} pointing directly at the TypeScript handler. NodejsFunction
 * transpiles/bundles the handler with esbuild at synth time (falling back to Docker
 * when esbuild is not installed locally). The handler's only runtime dependency,
 * `@aws-sdk/client-secrets-manager`, is provided by the Node.js 20 Lambda runtime and
 * is therefore marked external so it is not bundled.
 *
 * _Requirements: 1.4, 1.5, 6.1, 6.2, 6.4_
 */

import * as path from "path";

import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";

import { ACCOUNT, REGION } from "../types";
import { buildSignalBridgeLambdaPolicy } from "../iam/policies";

/** Stable resource names, matched exactly by the least-privilege IAM policy (9.1). */
const TOPIC_NAME = "devops-agent-alerts";
const DLQ_NAME = "devops-agent-alerts-dlq";
const FUNCTION_NAME = "devops-agent-signal-bridge";
const SECRET_NAME = "devops-agent/webhook-hmac";
const LOG_GROUP_NAME = `/aws/lambda/${FUNCTION_NAME}`;

/**
 * Props for {@link SignalBridgeStack}.
 *
 * The VPC coordinates (`vpc` + `securityGroupId` + `subnetIds`) reference the
 * already-deployed observability stack's network so the translator Lambda's ENIs sit
 * where they can reach the DevOps Agent webhook egress path; they are supplied by the
 * CDK app entry point (task 11.4) rather than created here.
 */
export interface SignalBridgeStackProps extends cdk.StackProps {
  /** The DevOps Agent generic-webhook URL (must be `https://`); becomes `WEBHOOK_URL`. */
  readonly webhookUrl: string;

  /** VPC in which the in-VPC translator Lambda's ENIs are placed. */
  readonly vpc: ec2.IVpc;

  /** Security group ID applied to the Lambda's ENIs (egress to the webhook). */
  readonly securityGroupId: string;

  /** Subnet ID(s) in which the Lambda runs. At least one is required. */
  readonly subnetIds: string[];

  /**
   * Name of the operator-owned Secrets Manager secret holding the webhook HMAC
   * key. Imported (not created) so the value stays the DevOps-Agent-issued key.
   * Defaults to `devops-agent/webhook-hmac`.
   */
  readonly webhookSecretName?: string;
}

/**
 * Stack that provisions the SNS topic, in-VPC translator Lambda, SQS DLQ, and the
 * webhook HMAC secret that implement the Signal_Bridge.
 */
export class SignalBridgeStack extends cdk.Stack {
  /** The SNS topic fired monitors notify. */
  public readonly topic: sns.Topic;

  /** ARN of the SNS topic (consumed by the monitor-deploy custom resource, 11.1). */
  public readonly topicArn: string;

  /** The SQS dead-letter / redrive queue for undelivered alerts. */
  public readonly deadLetterQueue: sqs.Queue;

  /** The webhook HMAC secret (imported by name). Only its ARN is exposed. */
  public readonly webhookSecret: secretsmanager.ISecret;

  /** ARN of the webhook HMAC secret (consumed by the agent config, 11.3). */
  public readonly webhookSecretArn: string;

  /** The in-VPC translator Lambda. */
  public readonly translatorFunction: NodejsFunction;

  /** The Lambda's least-privilege execution role. */
  public readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: SignalBridgeStackProps) {
    // Pin the stack to the demo account/region (R1.7, R6.7) unless overridden.
    super(scope, id, {
      ...props,
      env: props.env ?? { account: ACCOUNT, region: REGION },
    });

    if (props.subnetIds.length === 0) {
      throw new Error(
        "SignalBridgeStack requires at least one subnet ID for the in-VPC translator Lambda.",
      );
    }

    // -----------------------------------------------------------------------
    // SNS topic — fan-in for fired Alert_Monitor notifications.
    // -----------------------------------------------------------------------
    this.topic = new sns.Topic(this, "AlertsTopic", {
      topicName: TOPIC_NAME,
      displayName: "DevOps Agent fired-alert notifications",
    });
    this.topicArn = this.topic.topicArn;

    // -----------------------------------------------------------------------
    // SQS DLQ — retention + redrive for undelivered alerts (R1.5).
    // -----------------------------------------------------------------------
    // Long retention so undelivered alerts survive transient webhook outages; the
    // Lambda both writes here (async failure destination) and reads here (redrive).
    this.deadLetterQueue = new sqs.Queue(this, "AlertsDlq", {
      queueName: DLQ_NAME,
      retentionPeriod: cdk.Duration.days(14),
      visibilityTimeout: cdk.Duration.minutes(5),
      enforceSSL: true,
    });

    // -----------------------------------------------------------------------
    // Webhook HMAC secret — IMPORTED by name (operator-owned), never created here.
    // The operator stores the DevOps-Agent-issued HMAC value in this secret before
    // deploy (Quick Start). Importing avoids (a) generating a random key the DevOps
    // Agent would reject and (b) a create-time name collision with that secret.
    // -----------------------------------------------------------------------
    this.webhookSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      "WebhookHmacSecret",
      props.webhookSecretName ?? SECRET_NAME,
    );
    this.webhookSecretArn = this.webhookSecret.secretArn;

    // -----------------------------------------------------------------------
    // Least-privilege execution role (task 9.1 policy, attached verbatim).
    // -----------------------------------------------------------------------
    // NOTE: no explicit `roleName` — CloudFormation auto-generates a unique name.
    // The least-privilege policy (buildSignalBridgeLambdaPolicy) references the DLQ,
    // log group, and secret by name, but NOT this role, so auto-naming is safe and
    // avoids collisions on re-deploy or in a shared/dirty account.
    this.executionRole = new iam.Role(this, "SignalBridgeExecutionRole", {
      description:
        "Least-privilege execution role for the Signal_Bridge translator Lambda (Secrets read, DLQ consume, VPC ENI, logs).",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });

    // Attach the exact least-privilege document from task 9.1. This is the single
    // authoritative grant: it scopes `secretsmanager:GetSecretValue` to the webhook
    // secret (Lambda read-on-secret), DLQ consume/produce, region-conditioned VPC
    // ENI lifecycle, and log-stream writes — no wildcard action or resource.
    this.executionRole.attachInlinePolicy(
      new iam.Policy(this, "SignalBridgeExecutionPolicy", {
        document: iam.PolicyDocument.fromJson(buildSignalBridgeLambdaPolicy()),
      }),
    );

    // NOTE: the translator Lambda is intentionally NOT placed in the obs-stack
    // VPC. Its only dependencies are the SNS trigger, reading the webhook HMAC
    // secret from Secrets Manager, and POSTing to the (public) DevOps Agent
    // webhook — none of which touch the VPC-private OpenSearch domain (that is the
    // MCP server's job, on AgentCore Runtime). Running outside the VPC gives the
    // Lambda normal egress to Secrets Manager + the webhook without requiring a
    // NAT gateway in the domain's egress-less private subnet. Hence no VPC config
    // and no AWSLambdaVPCAccessExecutionRole managed policy are attached.

    // Pre-create the Lambda log group with the exact name the policy scopes to, so
    // the role needs no `logs:CreateLogGroup` (the policy intentionally omits it).
    const logGroup = new logs.LogGroup(this, "SignalBridgeLogGroup", {
      logGroupName: LOG_GROUP_NAME,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -----------------------------------------------------------------------
    // In-VPC translator Lambda (Node.js 20), entry = lib/signal-bridge/handler.ts.
    // -----------------------------------------------------------------------
    this.translatorFunction = new NodejsFunction(this, "TranslatorFunction", {
      functionName: FUNCTION_NAME,
      description:
        "Signal_Bridge translator: normalize + HMAC-sign + deliver fired alerts to the DevOps Agent webhook (runs outside the VPC for Secrets Manager + webhook egress).",
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, "..", "signal-bridge", "handler.ts"),
      handler: "handler",
      role: this.executionRole,
      // No VPC placement — see note above.
      timeout: cdk.Duration.seconds(130), // > the handler's 120 s delivery deadline
      memorySize: 256,
      logGroup,
      // Async failure destination: failed invocations are retained in the DLQ.
      deadLetterQueue: this.deadLetterQueue,
      deadLetterQueueEnabled: true,
      retryAttempts: 2,
      environment: {
        WEBHOOK_URL: props.webhookUrl,
        WEBHOOK_SECRET_ARN: this.webhookSecret.secretArn,
      },
      bundling: {
        // The AWS SDK v3 is on the Lambda runtime image — do not bundle it.
        externalModules: ["@aws-sdk/client-secrets-manager"],
        target: "node20",
        minify: false,
        sourceMap: true,
      },
    });

    // Subscribe the Lambda to the SNS topic (SNS -> Lambda async invocation).
    this.topic.addSubscription(
      new subscriptions.LambdaSubscription(this.translatorFunction),
    );

    // Redrive: the same Lambda consumes the DLQ to re-attempt undelivered alerts,
    // completing the R1.5 retention + redelivery loop. The IAM policy already grants
    // the required `sqs:ReceiveMessage`/`DeleteMessage`/`GetQueueAttributes`.
    this.translatorFunction.addEventSource(
      new SqsEventSource(this.deadLetterQueue, {
        batchSize: 1,
        enabled: true,
      }),
    );

    // -----------------------------------------------------------------------
    // Outputs — topic ARN + secret ARN only. The secret VALUE is never output.
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, "AlertsTopicArn", {
      value: this.topicArn,
      description:
        "SNS topic ARN the OpenSearch/AMP monitors notify (wired by task 11.1).",
      exportName: "DevOpsAgentAlertsTopicArn",
    });

    new cdk.CfnOutput(this, "WebhookSecretArn", {
      value: this.webhookSecretArn,
      description:
        "ARN (not value) of the webhook HMAC secret, consumed by the agent config (task 11.3).",
      exportName: "DevOpsAgentWebhookSecretArn",
    });

    new cdk.CfnOutput(this, "DlqArn", {
      value: this.deadLetterQueue.queueArn,
      description: "ARN of the undelivered-alert DLQ (retention + redrive).",
    });
  }
}
