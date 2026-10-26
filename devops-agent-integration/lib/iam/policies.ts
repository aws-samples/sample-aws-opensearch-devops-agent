/**
 * Least-privilege IAM policy builders for the DevOps Agent Integration demo.
 *
 * These are PURE builders: each function returns a plain, JSON-serializable IAM
 * policy-document object. They make no AWS calls and construct no CDK constructs,
 * so they can be unit- and property-tested in isolation (see tasks 9.2-9.4) and
 * reused when the CDK stacks (tasks 10.1/10.2) attach the roles.
 *
 * The policy documents mirror the design's "IAM and Security Design" section
 * exactly:
 *   - {@link buildSignalBridgeLambdaPolicy} — the Signal_Bridge translator Lambda
 *     execution role (Secrets read, DLQ consume, VPC ENI region-conditioned, logs).
 *   - {@link buildOpenSearchMcpRolePolicy} — the `opensearch-mcp-server-py`
 *     MCP server (ECS Fargate task) execution role (read-only OpenSearch:
 *     `es:ESHttpGet`/`es:ESHttpPost` scoped to the domain).
 *
 * Every ARN is built from the {@link ACCOUNT} / {@link REGION} containment
 * constants (R6.7/R6.8). No statement uses a wildcard action or a wildcard
 * resource (`Resource: "*"`). The `network-interface/*` and `log-group:*`
 * suffixes are resource-path scoping within a specific service, account, and
 * region — not open-ended `"*"` resources — and are the least-privilege form
 * for those APIs.
 *
 * _Requirements: 6.1, 6.2, 6.3_
 */

import { ACCOUNT, REGION } from "../types";

/** A single statement within an IAM policy document. */
export interface IamPolicyStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string;
  Condition?: Record<string, Record<string, string>>;
}

/** A plain, JSON-serializable IAM policy document. */
export interface IamPolicyDocument {
  Version: "2012-10-17";
  Statement: IamPolicyStatement[];
}

/**
 * Build the Signal_Bridge translator Lambda execution role policy.
 *
 * Grants exactly four scoped capabilities, matching the design:
 *   1. `secretsmanager:GetSecretValue` on the webhook HMAC secret.
 *   2. DLQ consume/produce (`sqs:ReceiveMessage`, `DeleteMessage`,
 *      `GetQueueAttributes`, `SendMessage`) on the `devops-agent-alerts-dlq` queue.
 *   3. VPC ENI lifecycle (`ec2:CreateNetworkInterface`,
 *      `DescribeNetworkInterfaces`, `DeleteNetworkInterface`), region-conditioned
 *      to `us-east-1` via `aws:RequestedRegion`.
 *   4. Log-stream writes (`logs:CreateLogStream`, `logs:PutLogEvents`) on the
 *      Lambda's own log group.
 *
 * The DevOps_Agent webhook is authenticated by the HMAC secret, not IAM, so the
 * role grants no `devops-agent:*` action.
 *
 * @returns the Lambda execution role policy document
 */
export function buildSignalBridgeLambdaPolicy(): IamPolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadWebhookSecret",
        Effect: "Allow",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:devops-agent/webhook-hmac-*`,
      },
      {
        Sid: "ConsumeDlq",
        Effect: "Allow",
        Action: [
          "sqs:ReceiveMessage",
          "sqs:DeleteMessage",
          "sqs:GetQueueAttributes",
          "sqs:SendMessage",
        ],
        Resource: `arn:aws:sqs:${REGION}:${ACCOUNT}:devops-agent-alerts-dlq`,
      },
      {
        Sid: "VpcEni",
        Effect: "Allow",
        Action: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
        ],
        Resource: `arn:aws:ec2:${REGION}:${ACCOUNT}:network-interface/*`,
        Condition: { StringEquals: { "aws:RequestedRegion": REGION } },
      },
      {
        Sid: "Logs",
        Effect: "Allow",
        Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
        Resource: `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda/devops-agent-signal-bridge:*`,
      },
    ],
  };
}

/**
 * Build the OpenSearch MCP server (`opensearch-mcp-server-py`) AgentCore Runtime
 * execution role policy — read-only OpenSearch access.
 *
 * One statement (Sid `OpenSearchReadOnly`) granting `es:ESHttpGet` /
 * `es:ESHttpPost` scoped to the `obs-stack` domain. `ESHttpPost` is used only for
 * read APIs (`_search`/`_msearch`); **no `es:ESHttpPut`/`es:ESHttpDelete`** is
 * granted, so the OpenSearch evidence surface is read-only by IAM scope. This role
 * (`devops-agent-opensearch-mcp-role`) is additionally FGAC-mapped read-only on the
 * domain (task 11.2).
 *
 * @returns the OpenSearch MCP execution role policy document
 */
export function buildOpenSearchMcpRolePolicy(): IamPolicyDocument {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "OpenSearchReadOnly",
        Effect: "Allow",
        Action: ["es:ESHttpGet", "es:ESHttpPost"],
        Resource: `arn:aws:es:${REGION}:${ACCOUNT}:domain/obs-stack/*`,
      },
    ],
  };
}
