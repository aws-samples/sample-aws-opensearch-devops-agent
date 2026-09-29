#!/usr/bin/env bash
#
# register-from-host.sh — one-shot registration of the detection layer against the
# VPC-private OpenSearch domain + AMP workspace. Run this ONCE from your workstation
# after `cdk deploy` (Option B in the Quick Start). It deploys NOTHING and leaves no
# standing cost.
#
# What it does:
#   1. On the in-VPC demo EC2 host (via SSM Run Command), signing SigV4 as the domain's
#      FGAC master, it:
#        a. creates/reuses an OpenSearch Notifications SNS channel at the Signal Bridge topic,
#        b. upserts every monitor in ../monitors/*.json (substituting the channel id),
#        c. creates a read-only FGAC role and maps the OpenSearch MCP Fargate task role to it.
#   2. From your workstation (AMP is a public API), applies the AMP rule group +
#      Alertmanager definition in ../monitors/amp/.
#
# Requirements: aws CLI v2, python3 locally; the demo host is SSM-managed; your caller
# can assume the FGAC master role (or already is FGAC admin); and IAM permissions to
# create the OpenSearch->SNS notification role (iam:CreateRole/PutRolePolicy/GetRole)
# unless you supply SNS_NOTIFY_ROLE_ARN.
#
# Config (env; required unless noted):
#   DEMO_INSTANCE_ID     EC2 instance id of the OTel demo host (SSM target)
#   REGION               AWS region (default: CLI default)
#   DOMAIN_HOST          OpenSearch domain endpoint host, no scheme
#   SNS_TOPIC_ARN        Signal Bridge SNS topic ARN
#   MCP_TASK_ROLE_ARN    OpenSearch MCP Fargate task role ARN (FGAC backend role)
#   AMP_WORKSPACE_ID     AMP workspace id
#   FGAC_MASTER_ROLE_ARN optional: role to assume for domain admin (else current creds)
#   SNS_NOTIFY_ROLE_ARN  optional: IAM role_arn OpenSearch assumes to publish to SNS.
#                        If unset, an idempotent role (devops-agent-osnotify-role,
#                        trusts es.amazonaws.com, sns:Publish on the topic) is created.
#   OSNOTIFY_ROLE_NAME   optional: name for that auto-created role
#   AWS_PROFILE          optional: named profile
#   FGAC_ROLE_NAME       optional: FGAC role name (default devops-agent-mcp-read)
#
set -euo pipefail

REGION="${REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}"
AWS_PROFILE="${AWS_PROFILE:-}"
FGAC_ROLE_NAME="${FGAC_ROLE_NAME:-devops-agent-mcp-read}"
PA=(); [ -n "$AWS_PROFILE" ] && PA=(--profile "$AWS_PROFILE")
MON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../monitors" && pwd)"

# A value is "present" only if it is non-empty AND not the literal "None"
# (the AWS CLI prints "None" for a missing query result, which must not pass).
req() {
  local v="${!1:-}"
  { [ -n "$v" ] && [ "$v" != "None" ]; } \
    || { echo "ERROR: env $1 is required (got '$v')" >&2; exit 2; }
}
for v in DEMO_INSTANCE_ID DOMAIN_HOST SNS_TOPIC_ARN MCP_TASK_ROLE_ARN AMP_WORKSPACE_ID; do req "$v"; done

echo "== Resolving domain-admin credentials =="
use_current_creds() {
  eval "$(aws configure export-credentials "${PA[@]+"${PA[@]}"}" --format env)"
  AKID="$AWS_ACCESS_KEY_ID"; SECRET="$AWS_SECRET_ACCESS_KEY"; STOKEN="${AWS_SESSION_TOKEN:-}"
}
# Best-effort assume of the FGAC master. If the caller already IS the FGAC master
# (a role cannot sts:AssumeRole itself), the assume is denied — fall back to the
# current credentials rather than failing.
if [ -n "${FGAC_MASTER_ROLE_ARN:-}" ]; then
  C="$(aws sts assume-role --role-arn "$FGAC_MASTER_ROLE_ARN" \
        --role-session-name register-monitors "${PA[@]+"${PA[@]}"}" --region "$REGION" \
        --query Credentials --output json 2>/dev/null || true)"
  if [ -n "$C" ] && [ "$C" != "None" ]; then
    AKID="$(echo "$C" | python3 -c 'import json,sys;print(json.load(sys.stdin)["AccessKeyId"])')"
    SECRET="$(echo "$C" | python3 -c 'import json,sys;print(json.load(sys.stdin)["SecretAccessKey"])')"
    STOKEN="$(echo "$C" | python3 -c 'import json,sys;print(json.load(sys.stdin)["SessionToken"])')"
    echo "   assumed $FGAC_MASTER_ROLE_ARN"
  else
    echo "   WARN: could not assume $FGAC_MASTER_ROLE_ARN; using current credentials" >&2
    echo "         (assuming the caller is already the FGAC master role)." >&2
    use_current_creds
  fi
else
  use_current_creds
fi

# ---------------------------------------------------------------------------
# Ensure the OpenSearch -> SNS notification IAM role exists (the channel role_arn).
# Amazon OpenSearch Service cannot publish to SNS without an IAM role it assumes:
# the role trusts es.amazonaws.com and holds sns:Publish on the Signal Bridge topic.
# Without it, every fired monitor's notify action fails and no alert reaches the
# Signal Bridge Lambda. Auto-provisioned here (idempotent) unless you pass your own
# SNS_NOTIFY_ROLE_ARN.
# ---------------------------------------------------------------------------
OSNOTIFY_ROLE_NAME="${OSNOTIFY_ROLE_NAME:-devops-agent-osnotify-role}"
if [ -z "${SNS_NOTIFY_ROLE_ARN:-}" ]; then
  echo "== Ensuring OpenSearch->SNS notification role ($OSNOTIFY_ROLE_NAME) =="
  SNS_NOTIFY_ROLE_ARN="$(aws iam get-role "${PA[@]+"${PA[@]}"}" --role-name "$OSNOTIFY_ROLE_NAME" \
    --query Role.Arn --output text 2>/dev/null || true)"
  if [ -z "$SNS_NOTIFY_ROLE_ARN" ] || [ "$SNS_NOTIFY_ROLE_ARN" = "None" ]; then
    TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"es.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
    SNS_NOTIFY_ROLE_ARN="$(aws iam create-role "${PA[@]+"${PA[@]}"}" --role-name "$OSNOTIFY_ROLE_NAME" \
      --assume-role-policy-document "$TRUST" \
      --description "Assumed by Amazon OpenSearch Service to publish Alerting notifications to the Signal Bridge SNS topic." \
      --query Role.Arn --output text)"
    sleep 10  # IAM eventual consistency before the domain can assume the new role
  fi
  # Grant sns:Publish on THIS deployment's topic. The inline policy is named per
  # region so re-running in another region ADDS a grant rather than clobbering an
  # existing one (the role is global/account-wide).
  POL="$(TA="$SNS_TOPIC_ARN" python3 -c 'import json,os;print(json.dumps({"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"sns:Publish","Resource":os.environ["TA"]}]}))')"
  aws iam put-role-policy "${PA[@]+"${PA[@]}"}" --role-name "$OSNOTIFY_ROLE_NAME" \
    --policy-name "sns-publish-${REGION}" --policy-document "$POL" >/dev/null
  echo "   role: $SNS_NOTIFY_ROLE_ARN"
fi

echo "== Building host registration script =="
HS="$(mktemp "${TMPDIR:-/tmp}/reg-host.XXXXXX.sh")"
trap 'rm -f "$HS"' EXIT
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  # Injected (non-secret config + short-lived creds), expanded now:
  cat <<EOF
ES="https://${DOMAIN_HOST}"
REGION="${REGION}"
AKID="${AKID}"
SECRET="${SECRET}"
STOKEN="${STOKEN}"
SNS_TOPIC_ARN="${SNS_TOPIC_ARN}"
SNS_NOTIFY_ROLE_ARN="${SNS_NOTIFY_ROLE_ARN:-}"
FGAC_ROLE_NAME="${FGAC_ROLE_NAME}"
MCP_TASK_ROLE_ARN="${MCP_TASK_ROLE_ARN}"
CHANNEL_NAME="devops-agent-sns"
EOF
  # Static helpers + logic (do NOT expand locally):
  cat <<'HELPER'
sig() {
  local m="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -s --aws-sigv4 "aws:amz:$REGION:es" --user "$AKID:$SECRET" \
      -H "x-amz-security-token: $STOKEN" -H "content-type: application/json" \
      -X "$m" "$ES$path" -d "$body"
  else
    curl -s --aws-sigv4 "aws:amz:$REGION:es" --user "$AKID:$SECRET" \
      -H "x-amz-security-token: $STOKEN" -X "$m" "$ES$path"
  fi
}

echo "-- notifications channel"
CID="$(sig GET "/_plugins/_notifications/configs?config_type=sns" \
  | CH="$CHANNEL_NAME" python3 -c 'import json,sys,os
d=json.load(sys.stdin)
for it in d.get("config_list",[]):
    if it.get("config",{}).get("name")==os.environ["CH"]:
        print(it.get("config_id","")); break' 2>/dev/null || true)"
BODY="$(TA="$SNS_TOPIC_ARN" RA="$SNS_NOTIFY_ROLE_ARN" CH="$CHANNEL_NAME" python3 -c 'import json,os
sns={"topic_arn":os.environ["TA"]}
if os.environ.get("RA"): sns["role_arn"]=os.environ["RA"]
print(json.dumps({"config":{"name":os.environ["CH"],"description":"Signal Bridge SNS channel","config_type":"sns","is_enabled":True,"sns":sns}}))')"
if [ -z "$CID" ]; then
  # Create the channel.
  CID="$(sig POST "/_plugins/_notifications/configs" "$BODY" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("config_id",""))')"
  [ -n "$CID" ] && echo "   channel created id=$CID (role_arn=${SNS_NOTIFY_ROLE_ARN:-none})"
else
  # Update the existing channel so a previously role-less channel gains role_arn.
  sig PUT "/_plugins/_notifications/configs/$CID" "$BODY" >/dev/null \
    && echo "   channel updated id=$CID (role_arn=${SNS_NOTIFY_ROLE_ARN:-none})"
fi
[ -n "$CID" ] || { echo "   ERROR: no channel id"; exit 1; }

upsert_monitor() {
  local body mname eid
  body="$(echo "$1" | base64 -d | CID="$CID" python3 -c 'import sys,os;print(sys.stdin.read().replace("<sns-notification-channel-id>",os.environ["CID"]))')"
  mname="$(echo "$body" | python3 -c 'import json,sys;print(json.load(sys.stdin)["name"])')"
  # Exact-name lookup. List all monitors and match the name EXACTLY client-side.
  # (An analyzed `match` query tokenizes hyphenated names and matches every monitor
  # sharing a token -- e.g. all share "m" -- which collapses every upsert onto one
  # id and overwrites the monitors into a single document. Client-side exact match
  # avoids that and does not depend on a monitor.name.keyword subfield existing.)
  eid="$(sig POST "/_plugins/_alerting/monitors/_search" '{"size":200,"query":{"match_all":{}}}' \
        | MN="$mname" python3 -c 'import json,sys,os
d=json.load(sys.stdin);h=d.get("hits",{}).get("hits",[])
mn=os.environ["MN"]
print(next((x["_id"] for x in h if x.get("_source",{}).get("monitor",{}).get("name")==mn), ""))' 2>/dev/null || true)"
  if [ -n "$eid" ]; then
    sig PUT "/_plugins/_alerting/monitors/$eid" "$body" >/dev/null && echo "   updated $mname ($eid)"
  else
    sig POST "/_plugins/_alerting/monitors" "$body" >/dev/null && echo "   created $mname"
  fi
}

echo "-- monitors"
HELPER
  # One upsert call per OpenSearch monitor JSON, content embedded as base64.
  for f in "$MON_DIR"/*.json; do
    [ -e "$f" ] || continue
    b64="$(base64 < "$f" | tr -d '\n')"
    echo "upsert_monitor \"$b64\""
  done
  # FGAC role + mapping.
  cat <<'FGAC'

echo "-- FGAC role + mapping"
sig PUT "/_plugins/_security/api/roles/$FGAC_ROLE_NAME" '{"cluster_permissions":["cluster_composite_ops_ro","cluster:monitor/*"],"index_permissions":[{"index_patterns":["logs-otel-v1*","otel-v1-apm-span*","otel-v2-apm-service-map*"],"allowed_actions":["read","search","indices:data/read/*"]}]}' >/dev/null && echo "   role $FGAC_ROLE_NAME"
MAP="$(RA="$MCP_TASK_ROLE_ARN" python3 -c 'import json,os;print(json.dumps({"backend_roles":[os.environ["RA"]],"hosts":[],"users":[]}))')"
sig PUT "/_plugins/_security/api/rolesmapping/$FGAC_ROLE_NAME" "$MAP" >/dev/null && echo "   mapped $MCP_TASK_ROLE_ARN"
echo "-- done on host"
FGAC
} > "$HS"

echo "== Running registration on $DEMO_INSTANCE_ID via SSM =="
B64="$(base64 < "$HS" | tr -d '\n')"
PARAMS="$(mktemp)"; trap 'rm -f "$HS" "$PARAMS"' EXIT
printf '{"commands":["echo %s | base64 -d > /tmp/reg.sh","bash /tmp/reg.sh","rm -f /tmp/reg.sh"]}' "$B64" > "$PARAMS"
CID="$(aws ssm send-command "${PA[@]+"${PA[@]}"}" --region "$REGION" \
  --document-name AWS-RunShellScript --targets "Key=InstanceIds,Values=$DEMO_INSTANCE_ID" \
  --comment "register-monitors-fgac" --parameters "file://$PARAMS" \
  --query "Command.CommandId" --output text)"
echo "   CommandId=$CID"
for i in $(seq 1 60); do
  ST="$(aws ssm get-command-invocation "${PA[@]+"${PA[@]}"}" --region "$REGION" \
    --command-id "$CID" --instance-id "$DEMO_INSTANCE_ID" --query Status --output text 2>/dev/null || echo Pending)"
  case "$ST" in Success|Failed|Cancelled|TimedOut) break;; esac
  sleep 3
done
echo "   Status=$ST"
aws ssm get-command-invocation "${PA[@]+"${PA[@]}"}" --region "$REGION" \
  --command-id "$CID" --instance-id "$DEMO_INSTANCE_ID" \
  --query "{Out:StandardOutputContent,Err:StandardErrorContent}" --output text
[ "$ST" = "Success" ] || { echo "Host registration failed — see output above."; exit 1; }

echo "== Applying AMP rules (from workstation; AMP is a public API) =="
aws amp create-rule-groups-namespace "${PA[@]+"${PA[@]}"}" --region "$REGION" \
  --workspace-id "$AMP_WORKSPACE_ID" --name devops-agent \
  --data "fileb://$MON_DIR/amp/rule-group.yaml" >/dev/null 2>&1 \
  || aws amp put-rule-groups-namespace "${PA[@]+"${PA[@]}"}" --region "$REGION" \
       --workspace-id "$AMP_WORKSPACE_ID" --name devops-agent \
       --data "fileb://$MON_DIR/amp/rule-group.yaml" >/dev/null
echo "   AMP rule group applied"

# Render the Alertmanager definition with THIS deployment's SNS topic ARN + region.
# The committed alertmanager.yaml ships a placeholder topic ARN; substitute the
# discovered Signal Bridge topic (and its region) so AMP routes alerts correctly.
AM_RENDERED="$(mktemp "${TMPDIR:-/tmp}/alertmanager.XXXXXX.yaml")"
trap 'rm -f "$HS" "$PARAMS" "$AM_RENDERED"' EXIT
sed -e "s#arn:aws:sns:[a-z0-9-]*:[0-9]*:devops-agent-alerts#${SNS_TOPIC_ARN}#g" \
    -e "s#region: ap-southeast-2#region: ${REGION}#g" \
    "$MON_DIR/amp/alertmanager.yaml" > "$AM_RENDERED"

aws amp create-alert-manager-definition "${PA[@]+"${PA[@]}"}" --region "$REGION" \
  --workspace-id "$AMP_WORKSPACE_ID" \
  --data "fileb://$AM_RENDERED" >/dev/null 2>&1 \
  || aws amp put-alert-manager-definition "${PA[@]+"${PA[@]}"}" --region "$REGION" \
       --workspace-id "$AMP_WORKSPACE_ID" \
       --data "fileb://$AM_RENDERED" >/dev/null
echo "   AMP Alertmanager applied (routed to $SNS_TOPIC_ARN)"

echo
echo "Done. Verify with:  ./scenarios/verify.sh"
