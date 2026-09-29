# Security Hardening & Static Analysis

This document records the secure-by-default posture, the static-analysis process,
and the known findings with their justifications — the material an open-source
security review (Talos / PCSR) will expect.

## Static analysis (cdk-nag)

The CDK app is intended to be synthesized with **cdk-nag** (`AwsSolutionsChecks`)
enabled so that CloudFormation-level findings are surfaced at synth time.

Enable it in `devops-agent-integration/bin/app.ts`:

```ts
import { Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks, NagSuppressions } from "cdk-nag";

// After creating the App:
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
```

Add `cdk-nag` to `devDependencies`, then:

```bash
cd devops-agent-integration
npm install
npx cdk synth 2>&1 | tee cdk-nag-report.txt
```

> Note: automated scanners in the AWS open-source review run on **GitFarm** repos,
> so porting/cloning the package to GitFarm lets the reviewer's tooling run cdk-nag,
> cfn-nag, and dependency/secret scanners automatically.

## Known findings and dispositions

Each finding below is either **fixed** or **suppressed with justification**. Suppress
in code with `NagSuppressions.addResourceSuppressions(...)` referencing the rule id.

| Rule (example) | Resource | Disposition |
|---|---|---|
| AwsSolutions-ECS* (public IP) | Fargate MCP services | **Fixed / opt-in.** `assignPublicIp` defaults to `false` (private subnets + NAT/VPC endpoints). The public-subnet quickstart is an explicit opt-in via `-c assignPublicIpForFargate=true`. |
| AwsSolutions-EC23 (SG ingress) | MCP task SG / NLB | Suppress: the security group is shared with the VPC-private OpenSearch domain and only permits intra-SG traffic; NLBs are internal (not internet-facing). |
| AwsSolutions-IAM5 (wildcards) | Lambda / MCP roles | Fixed where possible: policies use explicit ARNs and Region conditions. Any residual `es:ESHttp*`-style action wildcard is scoped to a single domain ARN and justified inline. |
| AwsSolutions-SNS2/SNS3 (encryption/SSL) | `devops-agent-alerts` topic | Fix: enable SSE (KMS) and enforce TLS on the topic policy. |
| AwsSolutions-L1 (Lambda runtime) | Signal Bridge Lambda | Keep on a current, supported Node.js runtime. |
| CloudWatch log retention | Lambda / Fargate logs | Set an explicit retention (e.g. 30–90 days) rather than never-expire. |

> This table is a template. Regenerate `cdk-nag-report.txt` and reconcile every
> finding (fix or suppress-with-justification) before submitting for review.

## Networking hardening (Fargate MCP servers)

- **Default (secure):** tasks run in **private** subnets with **no public IP**
  (`assignPublicIp: false`). Provide egress to ECR, CloudWatch Logs, STS, and AMP via a
  **NAT gateway** or, preferred, **VPC interface/gateway endpoints**
  (`com.amazonaws.<region>.ecr.api`, `.ecr.dkr`, `.logs`, `.sts`, `.aps-workspaces`, and
  the S3 gateway endpoint for ECR layer pulls).
- **Quickstart (opt-in):** reuse an existing IGW-routed **public** subnet and set
  `-c assignPublicIpForFargate=true`. The task security group still restricts ingress and
  the NLBs remain internal, but the task ENIs receive a public IP for egress. Use this only
  for evaluation.

## Secrets & credentials

- The webhook HMAC secret is stored in AWS Secrets Manager and read via the Lambda
  execution role at runtime. It is never committed, logged, or baked into an image.
- No static access keys anywhere: OTel Collector, Lambdas, and MCP tasks all use
  instance/task/execution role credentials (SigV4).
- `.gitignore` blocks `.env`, `*.pem`, `*.key`, and `secrets.json`.

## Data protection

- OpenSearch domain: `enforceHttps`, node-to-node + at-rest KMS encryption, FGAC.
- AMP: encryption at rest; SigV4-authenticated access.
- Consider Index State Management (ISM) retention on OpenSearch indices and a retention
  policy on any S3 log-lake bucket to bound data lifetime and cost.
