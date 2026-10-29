# Autonomous Monitoring using Amazon OpenSearch Service and AWS DevOps Agent

[![CI](https://github.com/aws-samples/sample-aws-opensearch-devops-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/aws-samples/sample-aws-opensearch-devops-agent/actions/workflows/ci.yml)

Turn an Amazon OpenSearch Service observability stack into a self-driving incident-response loop. Amazon OpenSearch Service and Amazon Managed Service for Prometheus detect the incident, a secure webhook bridge hands it to **AWS DevOps Agent**, and the agent pulls evidence on demand from an OpenSearch MCP (Model Context Protocol) server to perform root-cause analysis and recommend remediation, with no human opening a dashboard.

> Sample code for demonstration and learning. Review the [Security](#security) and [Cost](#cost) sections before deploying into any account.

## Start here

Follow the **[Quick Start Guide](docs/quick-start-guide.md)**, a copy-paste checklist from clone to a working autonomous investigation (~60-90 min).

## Architecture

![Architecture: Amazon EC2 telemetry flows through Amazon OpenSearch Ingestion into Amazon OpenSearch Service and Amazon Managed Service for Prometheus; detections fan into Amazon SNS and an AWS Lambda signal bridge that calls AWS DevOps Agent, which queries an OpenSearch MCP server on Amazon ECS on AWS Fargate](docs/images/architecture.svg)

1. **Amazon EC2** runs the OpenTelemetry demo workloads and a local **OpenTelemetry Collector**.
2. The Collector exports logs and traces (SigV4) to **Amazon OpenSearch Ingestion** and metrics to **Amazon Managed Service for Prometheus**.
3. Amazon OpenSearch Ingestion (Data Prepper) writes logs, traces, and a service map into **Amazon OpenSearch Service**.
4. **Amazon OpenSearch Service** alerting monitors and **Amazon Managed Service for Prometheus** rules evaluate the telemetry and, on breach, publish to **Amazon SNS**.
5. An **AWS Lambda** signal bridge translates the message into the DevOps Agent incident schema, signs it with HMAC-SHA256, and POSTs it to the **AWS DevOps Agent** webhook.
6. **AWS DevOps Agent** investigates, calling the OpenSearch MCP server on **Amazon ECS on AWS Fargate** over an `AWS::DevOpsAgent::PrivateConnection` to gather logs, traces, service map, and PPL evidence, then returns RCA and remediation guidance.

Source for the diagram: [`docs/images/architecture.svg`](docs/images/architecture.svg) (regenerate with `python3 docs/images/gen-architecture.py`) and the Mermaid version at [`docs/images/architecture.mmd`](docs/images/architecture.mmd). Full component detail, data model, and decision records are in [docs/architecture.md](docs/architecture.md).

## Key features

- **Closed detection to investigation loop.** Amazon OpenSearch Service alerting and Amazon Managed Service for Prometheus rules trigger AWS DevOps Agent with no human in the path.
- **Secure signal bridge.** Alerts converge on Amazon SNS; an AWS Lambda HMAC-SHA256-signs each payload (replay-protected) before POSTing to the DevOps Agent webhook, with no inbound path into the VPC.
- **On-demand evidence via MCP.** The OpenSearch MCP server (`opensearch-mcp-server-py`) lets the agent pull correlated logs, traces, service map, and PPL during an investigation.
- **VPC-private by design.** The MCP server runs on Amazon ECS on AWS Fargate behind an internal TLS Network Load Balancer, reached via `AWS::DevOpsAgent::PrivateConnection`. The Amazon OpenSearch Service domain and Amazon Managed Service for Prometheus workspace are never exposed publicly.
- **Fault-injectable workloads.** Toggle faults in the [OpenTelemetry Astronomy Shop](https://github.com/open-telemetry/opentelemetry-demo) (via `flagd`) and a GenAI travel-planner (via a fault panel) to reproduce incidents deterministically.
- **Infrastructure as code.** AWS CDK (TypeScript), composable stacks, property-based tests (`fast-check`).

## Prerequisites

- An AWS account with Amazon OpenSearch Service, Amazon OpenSearch Ingestion, Amazon Managed Service for Prometheus, Amazon ECS on AWS Fargate, AWS Lambda, Amazon SNS, and **AWS DevOps Agent** available in your Region (for example, `us-east-1`).
- AWS DevOps Agent enabled, with a **generic webhook** integration created (gives you a webhook URL and an HMAC signing secret).
- Node.js 18+ and AWS CDK v2 (`npm install -g aws-cdk`).
- The AWS CLI configured for the target account.

All account-specific values (ARNs, endpoints, the webhook URL and HMAC secret, instance ids) are supplied as CDK context / environment parameters or AWS Secrets Manager entries, none are hard-coded.

## Deployment

See the **[Quick Start Guide](docs/quick-start-guide.md)** for the full walkthrough and [prerequisites-and-deployment.md](docs/prerequisites-and-deployment.md) for the complete input reference. In summary:

```bash
# 1. Deploy the observability platform (Part 1) from the upstream OpenSearch project
#    into a VPC: https://observability.opensearch.org/docs/deploy/aws/
#    See observability-stack/README.md for the coordinates Part 2 needs.

# 2. Build the OpenSearch MCP image in-account with AWS CodeBuild (no local Docker)
cd devops-agent-integration && npm install
bash mcp-servers/tls/generate.sh          # internal TLS cert (git-ignored; read at synth)
cdk deploy DevOpsAgent-Build --require-approval never
aws codebuild start-build --project-name devops-agent-mcp-build   # wait for SUCCEEDED

# 3. Store the DevOps Agent webhook secret in AWS Secrets Manager
aws secretsmanager create-secret \
  --name devops-agent/webhook-hmac \
  --secret-string "<YOUR_WEBHOOK_HMAC_SECRET>"

# 4. Deploy detection + agent integration (supply ALL obs-stack coordinates)
cdk deploy --all \
  -c obsVpcId=... -c obsSubnetIds=... -c obsSecurityGroupId=... \
  -c opensearchEndpoint=... -c domainArn=... \
  -c ampWorkspaceId=... -c ampEndpoint=... -c ampWorkspaceArn=... \
  -c fgacMasterRoleArn=... \
  -c devopsAgentWebhookUrl="<YOUR_WEBHOOK_URL>" \
  -c assignPublicIpForFargate=true \   # public-subnet quickstart; omit for private (needs NAT/VPC endpoints)
  --require-approval never

# 5. Install monitors/rules + the OpenSearch->SNS role, then verify the loop (read-only)
bash ./scenarios/verify.sh
```

Export `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION` for your target account/Region before deploying. The CDK app splits into **Build** (Amazon ECR + AWS CodeBuild for the arm64 MCP image), **Shared** (networking/IAM), **FargateMcp** (the OpenSearch MCP server on Amazon ECS on AWS Fargate), **SignalBridge** (Amazon SNS + AWS Lambda), and **Integration** (AWS DevOps Agent Service / Association / PrivateConnection / Asset), so you can deploy incrementally.

## Running the demo

Reproduce incidents deterministically; full catalog in [docs/demo-scenarios.md](docs/demo-scenarios.md).

```bash
# OpenTelemetry Astronomy Shop: induce a payment failure
# (trips the log error-rate and Amazon Managed Service for Prometheus PromQL monitors)
./scenarios/induce-flag.sh          # FLAG=paymentFailure VARIANT=100%
./scenarios/reset-flag.sh

# GenAI travel-planner: drive weather-agent latency + errors (trips the two GenAI monitors)
curl -s -X POST http://<fault-panel>:8085/config \
  -H 'content-type: application/json' -d '{"preset":"chaos"}'
curl -s -X POST http://<fault-panel>:8085/config \
  -H 'content-type: application/json' -d '{"preset":"all_clean"}'
```

Within ~1-5 minutes the monitor breaches, the signal bridge delivers the incident to AWS DevOps Agent, and an investigation begins. Watch delivery in the AWS Lambda logs (`"event":"delivered","httpStatus":200`).

## Detection monitors

| Monitor | Signal | Fires when |
|---|---|---|
| `M-logs-error-rate` | Amazon OpenSearch Service logs | payment/checkout WARN+ log error rate ≥ 5% |
| `M-trace-latency-slo` | Amazon OpenSearch Service traces | purchase-path services p95 > 250 ms |
| `M-servicemap-anomaly` | Amazon OpenSearch Service traces | per-service error rate from spans ≥ 5% |
| `M-amp-promql` | Amazon Managed Service for Prometheus | checkout 5xx ratio > 20% (PromQL rule) |
| `M-travelagent-error-rate` | Amazon OpenSearch Service traces (GenAI) | travel-planner/weather/events agent error rate ≥ 10% |
| `M-travelagent-latency-slo` | Amazon OpenSearch Service traces (GenAI) | weather-agent slow-call (>5 s) ratio ≥ 20% |

Each monitor publishes to the shared Amazon SNS channel and carries a `runbook://` reference the agent resolves during investigation. Thresholds are grounded in observed baseline telemetry.

## Cost

Indicative only; actual cost depends on Region, retention, and traffic.

- **Amazon OpenSearch Service** domain, the dominant cost; sized by instance type/count and EBS.
- **Amazon OpenSearch Ingestion**: per OCU-hour, floored at the configured minimum (e.g. 1 OCU).
- **Amazon Managed Service for Prometheus**: per-sample ingestion + query.
- **Amazon ECS on AWS Fargate** (2 MCP tasks) + internal Network Load Balancers: small always-on cost.
- **AWS Lambda / Amazon SNS / AWS Secrets Manager**: negligible at demo volumes.

Use AWS Cost Explorer / AWS Cost Anomaly Detection and tear the stack down when idle.

## Cleanup

```bash
cd devops-agent-integration && cdk destroy --all
cd ../observability-stack && cdk destroy --all
```

## Security

- TLS 1.2+ everywhere; the Amazon OpenSearch Service domain enforces HTTPS with fine-grained access control (FGAC) and IAM principals.
- The webhook uses **HMAC-SHA256** with replay protection; the secret lives in **AWS Secrets Manager**, never in code.
- The MCP server runs VPC-private behind an internal TLS Network Load Balancer, reached via `AWS::DevOpsAgent::PrivateConnection`; no inbound path into the VPC.
- IAM roles are least-privilege with explicit resource ARNs (no `Action: "*"` / `Resource: "*"` for data paths).
- Sample code: review and harden (retention, AWS KMS, network, quotas) before any non-demo use.

See [SECURITY.md](SECURITY.md), [docs/security-hardening.md](docs/security-hardening.md), and the [threat model](threat-modeling/README.md). Report vulnerabilities via the [AWS vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/); do not open a public issue.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT-0. See [LICENSE](LICENSE). Third-party components are listed in [THIRD-PARTY-LICENSES.txt](THIRD-PARTY-LICENSES.txt); see also [NOTICE](NOTICE).
