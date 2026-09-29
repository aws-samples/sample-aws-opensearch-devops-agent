# Security

## Reporting a vulnerability

If you discover a potential security issue in this project, please notify AWS/Amazon
Security via the [vulnerability reporting page](https://aws.amazon.com/security/vulnerability-reporting/).
**Do not create a public GitHub issue.**

## Secure-by-default posture

This sample is built to be secure-by-default. Key controls:

- **Encryption in transit** — TLS 1.2+ on every hop: OTel export to OSIS, the OpenSearch
  domain (`enforceHttps`), the internal NLBs fronting the MCP servers, and the outbound
  HMAC webhook call.
- **Encryption at rest** — KMS on the OpenSearch domain; SSE on the runbook S3 object and SNS.
- **Authentication** — OpenSearch fine-grained access control (FGAC) with IAM principals
  (no local master password); the webhook uses HMAC-SHA256 with replay protection.
- **Secrets management** — the webhook HMAC secret lives in AWS Secrets Manager and is read
  at runtime via the Lambda execution role. No static credentials are committed; container
  images and Lambdas use task/execution role credentials only.
- **Network isolation** — the OpenSearch domain and AMP workspace are VPC-private. The MCP
  evidence servers are reached over `AWS::DevOpsAgent::PrivateConnection` via internal
  (non–internet-facing) NLBs. There is no inbound path into the VPC. Fargate tasks default
  to **no public IP** (see [docs/security-hardening.md](docs/security-hardening.md)).
- **Least privilege** — IAM policies enumerate explicit actions and resource ARNs and are
  Region-conditioned; there are no `Action: "*"` / `Resource: "*"` grants on data paths.

## Before you deploy

This is sample code. Review [docs/security-hardening.md](docs/security-hardening.md) for the
static-analysis (cdk-nag) findings, their justifications/suppressions, and the recommended
hardening steps (private-subnet networking, retention, WAF/logging) before any non-demo use.
