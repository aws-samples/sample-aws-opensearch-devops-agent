#!/usr/bin/env bash
#
# build-and-push.sh — build the OpenSearch MCP evidence server image and push it
# to Amazon ECR. This script is run MANUALLY by an operator during the deploy
# phase; it is NOT invoked by CDK or CI here.
#
# It is idempotent:
#   - creates the ECR repository only if it does not already exist
#   - (re)builds the image for linux/amd64
#   - tags with both `latest` and a UTC date tag (YYYYMMDD-HHMMSS)
#   - pushes both tags and prints the resulting image URI
#
# Requirements: docker (with buildx), aws CLI v2.
#
# All targets are derived from your AWS CLI credentials/config. Override any of
# AWS_PROFILE / AWS_REGION / AWS_ACCOUNT_ID / ECR_REPO via environment variables.

set -euo pipefail

# ---- Target configuration (derived; override via environment) -------------
# Optional named profile. Leave AWS_PROFILE unset to use the default chain.
AWS_PROFILE_NAME="${AWS_PROFILE:-}"
# Region from $AWS_REGION, else the CLI default, else a sensible fallback.
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
# Account derived from the caller identity unless explicitly overridden.
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws ${AWS_PROFILE_NAME:+--profile "$AWS_PROFILE_NAME"} sts get-caller-identity --query Account --output text)}"
ECR_REPO="${ECR_REPO:-devops-agent-opensearch-mcp}"

# Upstream package version to bake in (kept in sync with the Dockerfile ARG).
OPENSEARCH_MCP_VERSION="${OPENSEARCH_MCP_VERSION:-0.11.0}"

# The ECS Fargate task definition uses an ARM64 runtimePlatform, so the image
# MUST be arm64. Cross-building arm64 on an amd64 host needs QEMU/buildx:
#   docker run --privileged tonistiigi/binfmt --install arm64
PLATFORM="${PLATFORM:-linux/arm64}"

# ---- Derived values -------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
IMAGE_REPO_URI="${REGISTRY}/${ECR_REPO}"
DATE_TAG="$(date -u +%Y%m%d-%H%M%S)"

echo "==> Target registry : ${REGISTRY}"
echo "==> Repository      : ${ECR_REPO}"
echo "==> Tags            : latest, ${DATE_TAG}"
echo "==> Package version : opensearch-mcp-server-py==${OPENSEARCH_MCP_VERSION}"
echo "==> Build context   : ${SCRIPT_DIR}"
echo

# ---- 1. Ensure the ECR repository exists (idempotent) ---------------------
echo "==> Ensuring ECR repository '${ECR_REPO}' exists..."
if aws ecr describe-repositories \
      ${AWS_PROFILE_NAME:+--profile "$AWS_PROFILE_NAME"} \
      --region "${AWS_REGION}" \
      --repository-names "${ECR_REPO}" >/dev/null 2>&1; then
  echo "    Repository already exists."
else
  echo "    Repository not found — creating it."
  aws ecr create-repository \
      ${AWS_PROFILE_NAME:+--profile "$AWS_PROFILE_NAME"} \
      --region "${AWS_REGION}" \
      --repository-name "${ECR_REPO}" \
      --image-scanning-configuration scanOnPush=true \
      --image-tag-mutability MUTABLE >/dev/null
  echo "    Created."
fi

# ---- 2. Authenticate Docker to ECR ----------------------------------------
echo "==> Logging Docker in to ECR..."
aws ecr get-login-password \
    ${AWS_PROFILE_NAME:+--profile "$AWS_PROFILE_NAME"} \
    --region "${AWS_REGION}" \
  | docker login --username AWS --password-stdin "${REGISTRY}"

# ---- 3. Build the image for the target platform ---------------------------
echo "==> Building image (${PLATFORM})..."
docker buildx build \
    --platform "${PLATFORM}" \
    --build-arg "OPENSEARCH_MCP_VERSION=${OPENSEARCH_MCP_VERSION}" \
    --tag "${IMAGE_REPO_URI}:latest" \
    --tag "${IMAGE_REPO_URI}:${DATE_TAG}" \
    --load \
    "${SCRIPT_DIR}"

# ---- 4. Push both tags -----------------------------------------------------
echo "==> Pushing tags to ECR..."
docker push "${IMAGE_REPO_URI}:latest"
docker push "${IMAGE_REPO_URI}:${DATE_TAG}"

# ---- 5. Report -------------------------------------------------------------
echo
echo "==> Done. Pushed image URIs:"
echo "      ${IMAGE_REPO_URI}:latest"
echo "      ${IMAGE_REPO_URI}:${DATE_TAG}"
echo
echo "Pass the immutable date-tagged URI as -c openSearchImageUri=... to the CDK"
echo "app (DevOpsAgent-FargateMcp stack) for reproducible deploys."
