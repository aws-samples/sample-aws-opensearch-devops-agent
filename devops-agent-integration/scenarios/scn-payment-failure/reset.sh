#!/usr/bin/env bash
#
# SCN-payment-failure : RESET (baseline)
#
# Sets the OTel Demo `paymentFailure` feature flag back to the "off" variant in
# flagd and restarts flagd on the OTel Demo host. After reset, the payment service
# stops failing, the WARN payment-failure log volume falls back to baseline (0),
# and all associated monitors return to their non-triggered (baseline) state, so
# the demo can be repeated.
#
# NOTE (deployed demo = OTel Demo v2.2.0): the flag is `paymentFailure` with
# PERCENTAGE variants ("100%",...,"off") — NOT the older `paymentServiceFailure`.
#
# Requirements: 7.8 (reset returns the scenario to a pre-incident baseline; all
#               associated Alert_Monitors return to a non-triggered state).
#
# Overridable via environment variables (defaults target the deployed demo):
#   INSTANCE_ID   EC2 instance running the OTel Demo (default i-0123456789abcdef0)
#   REGION        AWS region                          (default us-east-1)
#   PROFILE       AWS CLI profile (optional; if set, passed as --profile)
#   DEMO_DIR      OTel Demo checkout dir on the host  (default /opt/obs-stack/docker-compose/opentelemetry-demo)
#   FLAG_FILE     flagd config file (relative to DEMO_DIR, default src/flagd/demo.flagd.json)
#   VARIANT       paymentFailure variant to set       (default off)
#
set -euo pipefail

INSTANCE_ID="${INSTANCE_ID:-i-0123456789abcdef0}"
REGION="${REGION:-us-east-1}"
PROFILE="${PROFILE:-}"
DEMO_DIR="${DEMO_DIR:-/opt/obs-stack/docker-compose/opentelemetry-demo}"
FLAG_FILE="${FLAG_FILE:-src/flagd/demo.flagd.json}"
VARIANT="${VARIANT:-off}"

PROFILE_ARG=()
[ -n "${PROFILE}" ] && PROFILE_ARG=(--profile "${PROFILE}")

echo "[reset] SCN-payment-failure: setting flagd 'paymentFailure' -> ${VARIANT}"
echo "[reset] target instance : ${INSTANCE_ID}"
echo "[reset] region          : ${REGION}"
echo "[reset] demo dir        : ${DEMO_DIR}"
echo "[reset] flag file       : ${FLAG_FILE}"

# Robust in-place JSON edit on the host: base64-encode a tiny python program so no
# shell/JSON quoting can corrupt it. The program sets flags.paymentFailure.defaultVariant.
read -r -d '' PYCODE <<'PY' || true
import json, sys
p = sys.argv[1]
variant = sys.argv[2]
with open(p) as fh:
    d = json.load(fh)
d["flags"]["paymentFailure"]["defaultVariant"] = variant
with open(p, "w") as fh:
    json.dump(d, fh, indent=2)
    fh.write("\n")
print("paymentFailure.defaultVariant ->", d["flags"]["paymentFailure"]["defaultVariant"])
PY
PYB64="$(printf '%s' "${PYCODE}" | base64 | tr -d '\n')"

PARAMS_FILE="$(mktemp "${TMPDIR:-/tmp}/scn-pf-reset.XXXXXX.json")"
trap 'rm -f "${PARAMS_FILE}"' EXIT
cat > "${PARAMS_FILE}" <<EOF
{"commands":[
  "cd ${DEMO_DIR}",
  "echo ${PYB64} | base64 -d | python3 - ${FLAG_FILE} '${VARIANT}'",
  "docker restart flagd",
  "echo restarted flagd"
]}
EOF

COMMAND_ID="$(aws ssm send-command \
  "${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"}" \
  --region "${REGION}" \
  --document-name "AWS-RunShellScript" \
  --targets "Key=InstanceIds,Values=${INSTANCE_ID}" \
  --comment "SCN-payment-failure reset: paymentFailure=${VARIANT}" \
  --parameters "file://${PARAMS_FILE}" \
  --query "Command.CommandId" \
  --output text)"

echo "[reset] SSM command dispatched: CommandId=${COMMAND_ID}"
echo "[reset] poll status with:"
echo "        aws ssm get-command-invocation ${PROFILE:+--profile ${PROFILE} }--region ${REGION} --command-id ${COMMAND_ID} --instance-id ${INSTANCE_ID}"
echo "[reset] done. paymentFailure -> ${VARIANT}; WARN payment-failure logs should stop and all associated monitors should return to non-triggered baseline."
