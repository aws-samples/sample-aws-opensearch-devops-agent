# Threat Model (lightweight)

This is a starter threat model for the autonomous-monitoring sample, intended to
seed a formal review (for example a Talos / PCSR open-source security review). It
is not exhaustive.

## Assets
- Telemetry (logs, traces, metrics) in Amazon OpenSearch Service and AMP.
- The DevOps Agent webhook HMAC secret (AWS Secrets Manager).
- IAM roles: Signal Bridge Lambda role, MCP task execution/task roles, OSIS pipeline role.
- The incident-response control path (SNS → Lambda → webhook → agent → MCP).

## Trust boundaries
1. Public internet ↔ AWS DevOps Agent webhook endpoint (outbound only from the Lambda).
2. AWS account ↔ VPC (the OpenSearch domain, AMP, and MCP servers are VPC-private).
3. DevOps Agent ↔ MCP servers (via `AWS::DevOpsAgent::PrivateConnection` over internal TLS).

## Data flows and threats (STRIDE-oriented)

| Flow | Threat | Mitigation |
|---|---|---|
| SNS → Signal Bridge Lambda → webhook | Spoofed/forged incident to the agent | HMAC-SHA256 signing over `"<timestamp>:<payload>"`, replay protection, TLS 1.2+; secret in Secrets Manager |
| Signal Bridge Lambda → webhook | Secret disclosure | Secret never logged or committed; read via execution role; rotatable |
| DevOps Agent → MCP servers | Unauthorized evidence access / lateral movement | Internal (non-internet-facing) NLBs; `PrivateConnection`; task SG restricts ingress; MCP roles are read-only (OpenSearch) / query-only (AMP) |
| MCP servers → OpenSearch / AMP | Over-privileged data access | Least-privilege IAM with explicit ARNs; FGAC read-only mapping for the OpenSearch MCP role |
| OTel Collector → OSIS / AMP | Tampering / unauthorized ingest | SigV4 auth; TLS; least-privilege source role scoped to the pipeline/workspace ARNs |
| Fargate tasks → egress | Data exfiltration via public IP | Secure-by-default: no public IP; private subnets + NAT/VPC endpoints (see docs/security-hardening.md) |
| Detection monitors | Alert flooding / cost abuse | Per-monitor throttling; minimum request counts; scoped service filters |

## Assumptions
- The reader deploys into an account they control, with AWS DevOps Agent enabled.
- The OpenSearch domain, AMP workspace, and OSIS pipeline are provisioned by Part 1
  and are VPC-private.
- The webhook URL and HMAC secret are provisioned by the reader (not shipped).

## Out of scope
- Hardening of the bundled OpenTelemetry demo application itself.
- Multi-account / cross-Region deployment.
- The optional real-LLM mode of the demo GenAI agents (incurs Bedrock cost; disabled by default).
