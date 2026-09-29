#!/usr/bin/env bash
#
# Generic OTel Demo fault reset — sets a flagd flag back to "off" and restarts flagd.
# Counterpart to induce-flag.sh. Returns the associated monitor(s) to baseline.
#
# Env vars (defaults target the deployed demo):
#   FLAG        flagd flag name to reset        (default paymentFailure)
#   VARIANT     variant to set it to            (default off)
#   INSTANCE_ID EC2 running the OTel Demo        (default i-0123456789abcdef0)
#   REGION      AWS region                       (default ap-southeast-2)
#   PROFILE     AWS CLI profile (optional)
#   DEMO_DIR    OTel Demo dir on the host        (default /opt/obs-stack/docker-compose/opentelemetry-demo)
#   FLAG_FILE   flagd config (rel to DEMO_DIR)   (default src/flagd/demo.flagd.json)
#
set -euo pipefail

FLAG="${FLAG:-paymentFailure}"
VARIANT="${VARIANT:-off}"
INSTANCE_ID="${INSTANCE_ID:-i-0123456789abcdef0}"
# Default to the ambient AWS region/profile so the SSM command targets the same
# account/region you deployed into (NOT a hard-coded region).
REGION="${REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || echo us-east-1)}}}"
PROFILE="${PROFILE:-${AWS_PROFILE:-}}"
DEMO_DIR="${DEMO_DIR:-/opt/obs-stack/docker-compose/opentelemetry-demo}"
FLAG_FILE="${FLAG_FILE:-src/flagd/demo.flagd.json}"

PROFILE_ARG=()
[ -n "${PROFILE}" ] && PROFILE_ARG=(--profile "${PROFILE}")

echo "[reset] setting flagd '${FLAG}' -> ${VARIANT} on ${INSTANCE_ID} (${REGION})"

read -r -d '' PYCODE <<'PY' || true
import json, sys
path, flag, variant = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as fh:
    d = json.load(fh)
if flag not in d.get("flags", {}):
    sys.stderr.write("ERROR: flag %r not found in %s\n" % (flag, path)); sys.exit(2)
variants = d["flags"][flag].get("variants", {})
if variant not in variants:
    sys.stderr.write("ERROR: variant %r not in %s for flag %r\n" % (variant, list(variants.keys()), flag)); sys.exit(3)
d["flags"][flag]["defaultVariant"] = variant
with open(path, "w") as fh:
    json.dump(d, fh, indent=2); fh.write("\n")
print("%s.defaultVariant -> %s" % (flag, d["flags"][flag]["defaultVariant"]))
PY
PYB64="$(printf '%s' "${PYCODE}" | base64 | tr -d '\n')"

PARAMS_FILE="$(mktemp "${TMPDIR:-/tmp}/reset-flag.XXXXXX.json")"
trap 'rm -f "${PARAMS_FILE}"' EXIT
cat > "${PARAMS_FILE}" <<EOF
{"commands":[
  "cd ${DEMO_DIR}",
  "echo ${PYB64} | base64 -d | python3 - ${FLAG_FILE} '${FLAG}' '${VARIANT}'",
  "docker restart flagd",
  "echo restarted flagd"
]}
EOF

COMMAND_ID="$(aws ssm send-command \
  "${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}" \
  --region "${REGION}" \
  --document-name "AWS-RunShellScript" \
  --targets "Key=InstanceIds,Values=${INSTANCE_ID}" \
  --comment "reset ${FLAG}=${VARIANT}" \
  --parameters "file://${PARAMS_FILE}" \
  --query "Command.CommandId" \
  --output text)"

echo "[reset] SSM CommandId=${COMMAND_ID}"
echo "[reset] poll: aws ssm get-command-invocation ${PROFILE:+--profile ${PROFILE} }--region ${REGION} --command-id ${COMMAND_ID} --instance-id ${INSTANCE_ID}"
echo "[reset] done. ${FLAG} -> ${VARIANT}."
