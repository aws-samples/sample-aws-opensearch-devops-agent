#!/usr/bin/env bash
#
# Generate the self-signed TLS cert used by the internal NLB TLS listener
# (Phase 2a "private MCP endpoint" front door). The cert CN and SAN MUST equal the
# private DNS name it fronts so the DevOps Agent (2b) can verify the cert against
# the hostname it dials.
#
# Validity: ~10 years (3650 days). Key: RSA 2048, unencrypted (-nodes).
#
# The PEM files are read at `cdk synth` time by lib/stacks/fargate-mcp-stack.ts
# (imported into ACM) and agent-config/agent.ts (trusted by the PrivateConnection).
# They are git-ignored (a private key must not be committed), so RUN THIS ONCE as a
# setup step before your first `cdk` command, and re-run to rotate.
#
# Usage:  bash mcp-servers/tls/generate.sh
set -euo pipefail
cd "$(dirname "$0")"

gen() {
  local name="$1" dns="$2"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "${name}-key.pem" \
    -out "${name}-cert.pem" \
    -days 3650 \
    -subj "/CN=${dns}" \
    -addext "subjectAltName=DNS:${dns}"
  echo "generated ${name}-cert.pem / ${name}-key.pem for ${dns}"
}

gen "opensearch-mcp" "opensearch-mcp.mcp.internal"
