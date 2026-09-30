# syntax=docker/dockerfile:1
#
# OpenSearch MCP evidence server for the DevOps Agent (Path 2).
#
# This image installs ONLY the upstream, OpenSearch-project-maintained package
# `opensearch-mcp-server-py` (PyPI). There is NO custom MCP tool code here — the
# image just installs and configures the maintained server.
#
# The server is launched in streaming mode, which serves the MCP protocol over
# streamable-HTTP (`POST /mcp`) and SSE (`GET /sse`). The container binds
# 0.0.0.0:8000; the ECS Fargate task fronts it with an internal TLS NLB that the
# DevOps Agent reaches via AWS::DevOpsAgent::PrivateConnection. (The same image
# also satisfies Bedrock AgentCore Runtime's 0.0.0.0:8000/mcp contract if hosted
# there instead.)
#
# Auth to the VPC-private obs-stack domain is IAM/SigV4 using AMBIENT credentials
# supplied by the ECS Fargate task execution/task role. NO static keys
# are baked into the image. The server signs each request against the `es`
# service using OPENSEARCH_URL + AWS_REGION and the role credentials it finds in
# the standard AWS credential chain.

# Base image pulled from ECR Public (the AWS-hosted mirror of the Docker official
# `python` images) rather than Docker Hub, per internal container guidelines.
FROM public.ecr.aws/docker/library/python:3.12-slim

# ---- Build metadata -------------------------------------------------------
LABEL org.opencontainers.image.title="devops-agent-opensearch-mcp" \
      org.opencontainers.image.description="Upstream opensearch-mcp-server-py packaged for Bedrock AgentCore Runtime (MCP over streamable-HTTP/SSE), IAM/SigV4 to the VPC-private obs-stack domain." \
      org.opencontainers.image.source="https://github.com/opensearch-project/opensearch-mcp-server-py" \
      org.opencontainers.image.licenses="Apache-2.0"

# Pinned upstream package version (latest at authoring time). Override at build
# time with `--build-arg OPENSEARCH_MCP_VERSION=x.y.z`.
ARG OPENSEARCH_MCP_VERSION=0.11.0

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ---- Install the upstream maintained MCP server (no custom code) ----------
RUN pip install --no-cache-dir "opensearch-mcp-server-py==${OPENSEARCH_MCP_VERSION}"

# ---- Runtime configuration (non-secret) -----------------------------------
# OPENSEARCH_URL and AWS_REGION are the two connection env vars the server reads.
# OPENSEARCH_URL is intentionally left unset here — it is injected at deploy time
# (the VPC-private obs-stack domain HTTPS endpoint) so no environment-specific
# value is baked into the image. It MUST be an https:// URL (SigV4 + TLS).
ENV AWS_REGION=ap-southeast-2 \
    MCP_TRANSPORT=stream \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8000 \
    # Enable the `observability` category so PPLQueryTool (the design's "PPLTool")
    # is advertised alongside the default core tools
    # (ListIndexTool / SearchIndexTool / IndexMappingTool / GetShardsTool).
    OPENSEARCH_ENABLED_CATEGORIES=observability \
    # Defense-in-depth: disable write operations at the tool layer. Read-only is
    # primarily enforced by the scoped execution-role IAM + FGAC mapping (task 11.2).
    OPENSEARCH_SETTINGS_ALLOW_WRITE=false \
    # Require TLS certificate verification for the domain connection.
    OPENSEARCH_SSL_VERIFY=true

# ---- Least-privilege container user ---------------------------------------
RUN useradd --create-home --uid 10001 mcp
USER mcp
WORKDIR /home/mcp

# AgentCore MCP protocol contract port.
EXPOSE 8000

# Launch the maintained server in streaming mode bound to the AgentCore MCP
# contract address (0.0.0.0:8000, endpoint /mcp + /sse). Uses the shell form so
# the MCP_* env vars are expanded; they can be overridden at deploy time.
CMD python -m mcp_server_opensearch \
      --transport "${MCP_TRANSPORT}" \
      --host "${MCP_HOST}" \
      --port "${MCP_PORT}"
