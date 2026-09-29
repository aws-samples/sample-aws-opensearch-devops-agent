# Self-signed TLS certs — internal MCP NLB front door (Phase 2a)

These PEM files back the **TLS listener (port 8443)** on the internal Network Load
Balancer that fronts the OpenSearch MCP Fargate service
(`lib/stacks/fargate-mcp-stack.ts`, stack `DevOpsAgent-FargateMcp`).

| File | Fronts DNS name | CN / SAN |
|------|-----------------|----------|
| `opensearch-mcp-cert.pem` / `opensearch-mcp-key.pem` | `opensearch-mcp.mcp.internal` | `opensearch-mcp.mcp.internal` |

The cert **CN and SAN equal the private DNS name** the listener fronts, so a client
(the DevOps Agent PrivateConnection in Phase 2b) that dials the `mcp.internal` name
can verify the certificate against that hostname. Validity is ~10 years (3650 days),
RSA 2048, key unencrypted.

## Generated at setup, never committed

The stack reads these PEMs at `cdk synth` time and imports the cert into ACM via an
`AwsCustomResource` (`acm:ImportCertificate`). The PEMs are **git-ignored** — a private
key must never be committed — so you **generate them once locally** (they are stable
thereafter, so a given deployment's synth stays deterministic across runs):

```bash
bash generate.sh   # run once before your first `cdk` command; re-run to rotate
```

These are throwaway self-signed **internal** certs for a demo. Do **not** use this
pattern for anything production-grade — use ACM-managed / private-CA certs there.

## Regenerate / rotate manually

Or generate one manually (matches what `generate.sh` does):

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout opensearch-mcp-key.pem \
  -out opensearch-mcp-cert.pem \
  -days 3650 \
  -subj "/CN=opensearch-mcp.mcp.internal" \
  -addext "subjectAltName=DNS:opensearch-mcp.mcp.internal"
```

After regenerating, `cdk deploy DevOpsAgent-FargateMcp` re-imports the changed cert
against the existing ACM ARN (the custom resource's `onUpdate` passes the current
`CertificateArn`).
