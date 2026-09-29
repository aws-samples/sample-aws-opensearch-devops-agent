#!/usr/bin/env bash
#
# verify.sh — read-only post-deploy health check for the Autonomous Monitoring
# sample. It answers "did the whole detection -> agent loop actually come up?"
# by polling the AWS control plane. It makes NO changes to any resource.
#
# What it checks (all via the AWS CLI, control plane only):
#   1. The CloudFormation stacks are in a *_COMPLETE state.
#   2. The Fargate MCP ECS services have running tasks.
#   3. The internal NLB target groups are healthy.
#   4. The DevOps Agent Service / Association / PrivateConnection CFN resources
#      created successfully (proxy for "the agent can reach the MCP servers").
#   5. The SNS topic has the Signal Bridge Lambda subscribed.
#   6. The Signal Bridge Lambda has a real (non-placeholder) webhook URL.
#   7. The webhook HMAC secret exists in Secrets Manager.
#
# What it CANNOT check from here:
#   - OpenSearch Alerting monitors / AMP rules live on the VPC-private domain and
#     workspace, so their state must be verified from inside the VPC (e.g. over
#     AWS Systems Manager from the demo host). See docs/demo-scenarios.md.
#
# Config (all optional; overridable via environment):
#   AWS_PROFILE   named profile (default: default credential chain)
#   AWS_REGION    region (default: CLI default, else us-east-1)
#   *_STACK       stack names (defaults match bin/app.ts)
#   SECRET_NAME   webhook secret name (default: devops-agent/webhook-hmac)
#
set -uo pipefail

AWS_PROFILE="${AWS_PROFILE:-}"
AWS_REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
PROFILE_ARG=(); [ -n "${AWS_PROFILE}" ] && PROFILE_ARG=(--profile "${AWS_PROFILE}")
aws_() { aws "${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}" --region "${AWS_REGION}" "$@"; }

SHARED_STACK="${SHARED_STACK:-DevOpsAgent-Shared}"
FARGATE_STACK="${FARGATE_STACK:-DevOpsAgent-FargateMcp}"
SIGNAL_STACK="${SIGNAL_STACK:-DevOpsAgent-SignalBridge}"
INTEG_STACK="${INTEG_STACK:-DevOpsAgent-Integration}"
SECRET_NAME="${SECRET_NAME:-devops-agent/webhook-hmac}"

PASS=0; FAIL=0; WARN=0
ok()   { printf '  [ PASS ] %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  [ FAIL ] %s\n' "$1"; FAIL=$((FAIL+1)); }
warn() { printf '  [ WARN ] %s\n' "$1"; WARN=$((WARN+1)); }
hdr()  { printf '\n== %s ==\n' "$1"; }

echo "Region: ${AWS_REGION}   Profile: ${AWS_PROFILE:-<default chain>}"

# Physical id of the first resource of a given type in a stack.
res_id() {
  aws_ cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='$2'].PhysicalResourceId | [0]" \
    --output text 2>/dev/null
}
res_ids() {
  aws_ cloudformation describe-stack-resources --stack-name "$1" \
    --query "StackResources[?ResourceType=='$2'].PhysicalResourceId" \
    --output text 2>/dev/null
}

# ---- 1. CloudFormation stacks ---------------------------------------------
hdr "CloudFormation stacks"
for S in "$SHARED_STACK" "$FARGATE_STACK" "$SIGNAL_STACK" "$INTEG_STACK"; do
  ST="$(aws_ cloudformation describe-stacks --stack-name "$S" \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null)"
  case "$ST" in
    CREATE_COMPLETE|UPDATE_COMPLETE|IMPORT_COMPLETE) ok "$S ($ST)";;
    "" ) warn "$S not found (skip if you renamed/omitted it)";;
    * )  bad "$S is $ST";;
  esac
done

# ---- 2. Fargate MCP ECS services ------------------------------------------
hdr "Fargate MCP services"
CLUSTER="$(res_id "$FARGATE_STACK" "AWS::ECS::Cluster")"
SERVICES="$(res_ids "$FARGATE_STACK" "AWS::ECS::Service")"
if [ -n "$CLUSTER" ] && [ "$CLUSTER" != "None" ] && [ -n "$SERVICES" ]; then
  # shellcheck disable=SC2086
  aws_ ecs describe-services --cluster "$CLUSTER" --services $SERVICES \
    --query "services[].[serviceName,desiredCount,runningCount]" --output text 2>/dev/null \
  | while read -r NAME DESIRED RUNNING; do
      [ -z "$NAME" ] && continue
      if [ "${RUNNING:-0}" -ge "${DESIRED:-1}" ] && [ "${RUNNING:-0}" -gt 0 ]; then
        ok "ECS $NAME running $RUNNING/$DESIRED"
      else
        bad "ECS $NAME running $RUNNING/$DESIRED"
      fi
    done
else
  warn "No ECS cluster/services found in $FARGATE_STACK"
fi

# ---- 3. NLB target group health -------------------------------------------
hdr "MCP NLB target health"
TGS="$(res_ids "$FARGATE_STACK" "AWS::ElasticLoadBalancingV2::TargetGroup")"
if [ -n "$TGS" ]; then
  for TG in $TGS; do
    STATES="$(aws_ elbv2 describe-target-health --target-group-arn "$TG" \
      --query "TargetHealthDescriptions[].TargetHealth.State" --output text 2>/dev/null)"
    NAME="${TG##*/}"; NAME="${NAME%/*}"
    if echo "$STATES" | grep -q "healthy"; then ok "TargetGroup ${TG##*:} healthy [$STATES]"
    else bad "TargetGroup ${TG##*:} not healthy [${STATES:-none}]"; fi
  done
else
  warn "No target groups found in $FARGATE_STACK"
fi

# ---- 4. DevOps Agent resources (Service / Association / PrivateConnection) --
hdr "DevOps Agent wiring"
DOA="$(aws_ cloudformation describe-stack-resources --stack-name "$INTEG_STACK" \
  --query "StackResources[?starts_with(ResourceType, 'AWS::DevOpsAgent')].[ResourceType,ResourceStatus]" \
  --output text 2>/dev/null)"
if [ -n "$DOA" ]; then
  echo "$DOA" | while read -r RTYPE RSTATUS; do
    [ -z "$RTYPE" ] && continue
    case "$RSTATUS" in
      *COMPLETE) ok "${RTYPE#AWS::DevOpsAgent::} ($RSTATUS)";;
      *)         bad "${RTYPE#AWS::DevOpsAgent::} ($RSTATUS)";;
    esac
  done
  warn "CFN status confirms creation; association readiness may still settle — re-run if just deployed."
else
  warn "No AWS::DevOpsAgent::* resources found in $INTEG_STACK"
fi

# ---- 5. SNS topic subscription --------------------------------------------
hdr "SNS -> Lambda subscription"
TOPIC="$(res_id "$SIGNAL_STACK" "AWS::SNS::Topic")"
if [ -n "$TOPIC" ] && [ "$TOPIC" != "None" ]; then
  PROTOS="$(aws_ sns list-subscriptions-by-topic --topic-arn "$TOPIC" \
    --query "Subscriptions[].Protocol" --output text 2>/dev/null)"
  if echo "$PROTOS" | grep -q "lambda"; then ok "SNS topic has a lambda subscription"
  else bad "SNS topic has no lambda subscription [${PROTOS:-none}]"; fi
else
  warn "No SNS topic found in $SIGNAL_STACK"
fi

# ---- 6. Signal Bridge Lambda webhook config -------------------------------
hdr "Signal Bridge Lambda config"
FN="$(res_id "$SIGNAL_STACK" "AWS::Lambda::Function")"
if [ -n "$FN" ] && [ "$FN" != "None" ]; then
  URL="$(aws_ lambda get-function-configuration --function-name "$FN" \
    --query "Environment.Variables.WEBHOOK_URL" --output text 2>/dev/null)"
  case "$URL" in
    ""|None)                         bad "Lambda has no WEBHOOK_URL set";;
    *REPLACE-WITH-YOUR*|*REPLACE*)   bad "Lambda WEBHOOK_URL is still a placeholder";;
    https://*)                       ok "Lambda WEBHOOK_URL configured (https)";;
    *)                               warn "Lambda WEBHOOK_URL set but not https: $URL";;
  esac
else
  warn "No Lambda function found in $SIGNAL_STACK"
fi

# ---- 7. Webhook HMAC secret ------------------------------------------------
hdr "Webhook HMAC secret"
if aws_ secretsmanager describe-secret --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
  ok "Secrets Manager secret '$SECRET_NAME' exists"
else
  bad "Secrets Manager secret '$SECRET_NAME' not found"
fi

# ---- Reminder: in-VPC checks ----------------------------------------------
hdr "Not checked here (VPC-private data plane)"
warn "OpenSearch monitors + AMP rules live on the VPC-private domain/workspace."
warn "Verify them from inside the VPC (e.g. via SSM on the demo host) — see docs/demo-scenarios.md."

# ---- Summary ---------------------------------------------------------------
printf '\n== Summary ==\n  PASS=%d  FAIL=%d  WARN=%d\n' "$PASS" "$FAIL" "$WARN"
[ "$FAIL" -eq 0 ] && { echo "Control-plane checks passed."; exit 0; } || { echo "Some checks failed — see [ FAIL ] lines above."; exit 1; }
