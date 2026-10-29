# Prerequisites & Deployment

This guide walks Part 2 (detection + autonomous agent). Part 1 (the observability
platform) is a prerequisite — see [`../observability-stack/README.md`](../observability-stack/README.md).

## Prerequisites

- An AWS account and a Region where **AWS DevOps Agent** is available, plus: Amazon
  OpenSearch Service, Amazon OpenSearch Ingestion, Amazon Managed Service for
  Prometheus, Amazon ECS Fargate, AWS Lambda, Amazon SNS, and AWS Secrets Manager.
  Developed and tested in `us-east-1`.
- **AWS DevOps Agent enabled**, with a **generic webhook** integration created in the
  DevOps Agent console. Copy the **webhook URL** and the **HMAC signing secret** it
  issues — you supply both below. (This is a manual, one-time console step; nothing in
  this repo can create it for you.)
- A **deployed Part 1 platform**: a VPC-private OpenSearch domain, an AMP workspace, an
  OSIS pipeline, and the OpenTelemetry demo on an SSM-managed EC2 host.
- Node.js 18+, AWS CDK v2 (pin the CLI to the tested version:
  `npm install -g aws-cdk@2.1141.0`), AWS CLI v2, python3.
- **No local Docker needed** — the OpenSearch MCP image is built as **arm64** in-account
  by an AWS CodeBuild project on native ARM compute (the `DevOpsAgent-Build` stack).
- AWS credentials for the target account (admin), including permission to create the
  OpenSearch→SNS notification role (`iam:CreateRole`/`PutRolePolicy`).

> **Account/Region come from the environment.** `devops-agent-integration/lib/types.ts`
> resolves `ACCOUNT`/`REGION` from `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION` (falling back
> to `AWS_REGION`, then the docs placeholders). **Export those two variables before
> `cdk synth`/`deploy`** — no code edit needed.

## Configuration inputs

The CDK app reads all obs-stack coordinates and the webhook URL from **context**
(`-c key=value`) or environment variables. Each has a placeholder default so `cdk synth`
succeeds out of the box — but the placeholders are **not real**, so `cdk deploy` will
fail or mis-wire unless you override them. No secrets are committed.

| Context key | What it is |
|---|---|
| `obsVpcId` | VPC id of the OpenSearch domain's VPC |
| `obsSubnetIds` | Comma-separated subnet id(s) in that VPC |
| `obsAvailabilityZones` | Comma-separated AZs for those subnets |
| `obsSecurityGroupId` | SG that allows egress to the domain/AMP (443) |
| `opensearchEndpoint` | VPC-private domain endpoint **host** (no scheme) |
| `domainArn` | OpenSearch domain ARN |
| `ampWorkspaceId` | AMP workspace id |
| `ampEndpoint` | AMP query endpoint URL |
| `ampWorkspaceArn` | AMP workspace ARN |
| `openSearchMcpImageUri` | Optional. ECR URI of the OpenSearch MCP image. Defaults to the `:latest` the `DevOpsAgent-Build` CodeBuild project pushes, so usually omit it |
| `devopsAgentWebhookUrl` | The DevOps Agent generic-webhook URL (https) |
| `fgacMasterRoleArn` | The domain's FGAC master role ARN |
| `assignPublicIpForFargate` | `true` (public-subnet quickstart) or `false` (private, secure-by-default) |

### Discover the coordinates from your Part 1 deployment

```bash
# OpenSearch domain: endpoint host, ARN, VPC, subnets, SG
aws opensearch describe-domain --domain-name <your-domain> \
  --query 'DomainStatus.{host:Endpoints.vpc,arn:ARN,vpc:VPCOptions.VPCId,subnets:VPCOptions.SubnetIds,sg:VPCOptions.SecurityGroupIds,azs:VPCOptions.AvailabilityZones}'

# AMP workspace: id + ARN (endpoint is https://aps-workspaces.<region>.amazonaws.com/workspaces/<id>)
aws amp list-workspaces --query 'workspaces[].{id:workspaceId,arn:arn,alias:alias}'
```

## Step 1 — Bootstrap CDK

```bash
cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
```

## Step 2 — Deploy the observability platform (Part 1)

Deploy the upstream OpenSearch **observability-stack** as AWS managed services (OpenSearch
domain, AMP workspace, OSIS pipeline, OpenSearch UI, and the OTel demo host), into a VPC:

- Start here: https://observability.opensearch.org/docs/deploy/aws/
- CLI installer: https://github.com/opensearch-project/observability-stack/blob/main/aws/cli-installer/README.md
- CDK: https://github.com/opensearch-project/observability-stack/blob/main/aws/cdk/README.md

> **Pick "Standard create" (advanced), not "Easy create", for the OpenSearch domain.** Easy
> create makes a public-access domain with no VPC option; Part 2 requires a **VPC-private**
> domain (FGAC/TLS/KMS over private networking). Standard create is the path that lets you
> enable **VPC access** and choose the subnets + security group. You cannot migrate an
> Easy-create (public) domain into a VPC afterward — recreate it with Standard create.

Then capture the coordinates from the [configuration table](#configuration-inputs) above.
See [`../observability-stack/README.md`](../observability-stack/README.md) for the contract
Part 2 depends on.

## Step 3 — Build the MCP image (in-account CodeBuild, no local Docker)

First generate the internal TLS cert (read at synth time; git-ignored, so run once):

```bash
cd devops-agent-integration
npm install
bash mcp-servers/tls/generate.sh
```

Then build the OpenSearch MCP image on native-ARM CodeBuild:

```bash
cdk deploy DevOpsAgent-Build --require-approval never
aws codebuild start-build --project-name devops-agent-mcp-build --region <REGION>
# wait for SUCCEEDED
BID=$(aws codebuild list-builds-for-project --project-name devops-agent-mcp-build --region <REGION> --query "ids[0]" --output text)
aws codebuild batch-get-builds --ids "$BID" --region <REGION> --query "builds[0].buildStatus" --output text
```

The project pushes `…/devops-agent-opensearch-mcp:latest`, which is the CDK app default —
so no `-c openSearchMcpImageUri` override is needed in Step 5.

## Step 4 — Store the webhook HMAC secret

```bash
aws secretsmanager create-secret \
  --name devops-agent/webhook-hmac \
  --region <REGION> \
  --secret-string "<YOUR_WEBHOOK_HMAC_SECRET>"
```

The name must match what the stack reads (`devops-agent/webhook-hmac`, overridable via
`SECRET_NAME`) and be in the deployment Region.

## Step 5 — Deploy detection + agent integration (Part 2)

Pass **all** the coordinates (placeholders will otherwise mis-target a fake VPC/domain):

```bash
cdk deploy --all \
  -c obsVpcId=<vpc-id> \
  -c obsSubnetIds=<subnet-a,subnet-b> \
  -c obsAvailabilityZones=<az-a,az-b> \
  -c obsSecurityGroupId=<sg-id> \
  -c opensearchEndpoint=<domain-host-no-scheme> \
  -c domainArn=<domain-arn> \
  -c ampWorkspaceId=<ws-id> \
  -c ampEndpoint=https://aps-workspaces.<region>.amazonaws.com/workspaces/<ws-id> \
  -c ampWorkspaceArn=<ws-arn> \
  -c devopsAgentWebhookUrl=<https-webhook-url> \
  -c fgacMasterRoleArn=<domain-fgac-master-role-arn> \
  -c assignPublicIpForFargate=true \
  --require-approval never
```

Stacks deploy in order: **Build → Shared → FargateMcp → SignalBridge → Integration**
(the last provisions the SNS topic, Signal Bridge Lambda, and the DevOps Agent
AgentSpace/Service/Association/PrivateConnection + runbook Asset). The OpenSearch MCP
evidence server runs on ECS Fargate; the OpenSearch monitors and AMP rules are applied
separately in Step 5b. The webhook itself was created
out-of-band in the prerequisites; no CloudFormation resource references it.

> For the hardened network posture, set `-c assignPublicIpForFargate=false` and supply
> **private** subnets with a NAT gateway or VPC endpoints (ECR, CloudWatch Logs, STS,
> AMP). See [security-hardening.md](security-hardening.md).

## Step 5b — Register detection (monitors, FGAC, notification role)

The OpenSearch monitors and AMP rules live on the VPC-private data plane, so they're
applied out-of-band by a one-time helper run from your workstation:

```bash
cd devops-agent-integration
DEMO_INSTANCE_ID=<otel-demo-instance-id> REGION=<REGION> DOMAIN_HOST=<domain-host-no-scheme> \
SNS_TOPIC_ARN=<signal-bridge-topic-arn> MCP_TASK_ROLE_ARN=<opensearch-mcp-task-role-arn> \
AMP_WORKSPACE_ID=<ws-id> FGAC_MASTER_ROLE_ARN=<domain-fgac-master-role-arn> \
  bash ./scenarios/register-from-host.sh
```

Besides upserting the monitors, mapping the read-only FGAC role, and applying the AMP
rule group + Alertmanager (routed to your topic), this **provisions the IAM role that
Amazon OpenSearch Service assumes to publish notifications to SNS** — `devops-agent-osnotify-role`
(trusts `es.amazonaws.com`, `sns:Publish` on the Signal Bridge topic) — and wires it into
the `devops-agent-sns` notification channel as its `role_arn`. **This role is required:**
without it a fired monitor's notify action fails and no alert reaches the Signal Bridge
Lambda. The step needs `iam:CreateRole`/`PutRolePolicy` (or pass a pre-made
`SNS_NOTIFY_ROLE_ARN`). Metric-based alerts additionally require the SNS topic policy to
allow `aps.amazonaws.com` to publish.

## Step 6 — Verify

Run the read-only control-plane check:

```bash
cd devops-agent-integration
AWS_REGION=<REGION> bash ./scenarios/verify.sh
```

It reports PASS/FAIL for the stacks, the Fargate services, NLB target health, the
DevOps Agent wiring, the SNS→Lambda subscription, the Lambda webhook URL, and the
secret. Because the OpenSearch monitors and AMP rules live on the **VPC-private** domain,
verify those from inside the VPC (via SSM on the demo host) — see
[demo-scenarios.md](demo-scenarios.md).

Then induce a fault and confirm the loop:
1. Trigger a scenario ([demo-scenarios.md](demo-scenarios.md)).
2. Watch the Signal Bridge Lambda logs for `"event":"delivered","httpStatus":200`.
3. Confirm an investigation appears in AWS DevOps Agent.

## Notes on network access

The OpenSearch domain and the MCP servers are VPC-private. Administrative queries and the
demo UIs (flagd, fault-panel) are reached from inside the VPC via AWS Systems Manager
(Session Manager port-forwarding / Run Command), not public endpoints.
