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

## Bundled demo workloads (third-party)

The quickstart deploys the upstream **OpenTelemetry Astronomy Shop** demo (plus a GenAI
travel-planner and a fault-injection panel) as the fault-injectable workload. These are
**third-party, demonstration-only** components — they are **not hardened by this project** and
include software that carries its own vulnerabilities. For example, the demo's **PHP `quote`
service** runs the PHP engine and is therefore subject to PHP-engine CVEs such as **PHP2Shell
(CVE-2026-109618 / CVE-2026-109619, pre-auth RCE)**.

This project's **own** components — the detection monitors, Signal Bridge, MCP servers, and
agent wiring — contain **no PHP** and are VPC-private by design. The demo is the only
third-party runtime in the stack. Treat it accordingly:

- **Keep it private.** Reach the demo UIs over AWS Systems Manager port-forwarding (as the docs
  describe), not a public endpoint. The upstream observability-stack installer may launch the
  demo EC2 host **with a public IP** — do not rely on the demo being private by default:
  restrict or remove that public IP and keep the host's security group closed to the internet.
  PHP2Shell and similar flaws are only practically exploitable against an internet-reachable
  PHP worker.
- **Keep it ephemeral.** Tear the demo down when you are finished (it carries standing cost and
  attack surface). It is a demonstration workload, not production software.
- **Patch via upstream.** The demo's component versions (including PHP) are set by the upstream
  OpenTelemetry demo images, not this repo — pull current images if you keep the demo running.

## Before you deploy

This is sample code. Review [docs/security-hardening.md](docs/security-hardening.md) for the
static-analysis (cdk-nag) findings, their justifications/suppressions, and the recommended
hardening steps (private-subnet networking, retention, WAF/logging) before any non-demo use.
