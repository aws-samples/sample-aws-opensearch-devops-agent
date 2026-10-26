# SCN-payment-failure — Observable pass conditions (R7.7)

This document defines the **per-stage observable pass condition** that confirms each
stage of the end-to-end incident-response flow has occurred for the
`SCN-payment-failure` scenario. It maps directly to the R7.7 table in the design and
supports Requirement 7.7 (document an observable pass condition for every stage).

**Scenario:** set the OTel Demo `paymentFailure` feature flag to the `100%` variant so
the payment service fails on charge ("Payment request failed. Invalid token."),
cascading errors to checkout. Induced with `./induce.sh`, reset with `./reset.sh`.

**Deployed demo note (OTel Demo v2.2.0):** the feature flag is **`paymentFailure`** with
PERCENTAGE variants (`100%`, `90%`, `75%`, `50%`, `25%`, `10%`, `off`) — NOT the older
`paymentServiceFailure`/`on` flag. The payment fault emits the log message
**"Payment request failed. Invalid token."** at **`severityNumber` 13 (WARN)** — NOT
`>=17`. The demo dir on the host is `/opt/obs-stack/docker-compose/opentelemetry-demo`;
flagd is restarted with `docker restart flagd`.

**Fixed context:** account `111122223333`, region `us-east-1`, OTel Demo host
`i-0123456789abcdef0`, primary monitor `M-logs-error-rate`
(runbook reference `runbook://M-logs-error-rate`), OpenSearch logs index
`logs-otel-v1-000001` (time field `time`).

---

## Stage 1 — Incident induction

**Pass condition:** `flagd` shows `paymentFailure` `defaultVariant=100%`; the
payment-failure WARN log volume rises in the OpenSearch_App.

**Concrete checks:**
- Run `./induce.sh`; the SSM `send-command` returns a `CommandId`, and
  `aws ssm get-command-invocation --region us-east-1 --command-id <CommandId> --instance-id i-0123456789abcdef0`
  reports `Status=Success`.
- On the host, `src/flagd/demo.flagd.json` shows the `paymentFailure` flag with
  `"defaultVariant": "100%"` and the `flagd` container has been restarted.
- In the OpenSearch_App, the count of payment-failure logs — message
  `"Payment request failed. Invalid token."` at `severityNumber` 13 (WARN) — rises
  against the `logs-otel-v1-000001` index (compare the count in the 5 min before vs.
  the 5 min after induction; baseline is ~0).

---

## Stage 2 — Monitor triggered

**Pass condition:** monitor state = `ACTIVE`/triggered within ≤5 min (R7.2).

**Concrete checks:**
- Query the monitor state:
  `GET _plugins/_alerting/monitors/{id}` for `M-logs-error-rate` — the monitor's most
  recent execution shows a triggered/active alert (an entry under
  `_plugins/_alerting/monitors/alerts` in `ACTIVE` state).
- This transition occurs within one evaluation interval and no later than 5 minutes
  after `induce.sh` completes.
- NOTE: the monitor must key on the WARN-severity payment-failure signal
  (`severityNumber >= 13` or a message match). A monitor that keys only on
  `severityNumber >= 17` (ERROR/FATAL) will NOT trip for this fault.

---

## Stage 3 — Signal_Bridge delivery

**Pass condition:** Lambda logs a successful `delivered:200` for the `monitorId` within
120 s; the DevOps_Agent shows a received investigation (R7.3).

**Concrete checks:**
- In the translator Lambda's CloudWatch Logs (`/aws/lambda/devops-agent-signal-bridge`),
  a clean invocation records a successful signed HTTPS POST tagged with
  `monitorId=M-logs-error-rate`, emitted within 120 seconds of the monitor
  transitioning to triggered. (A delivery failure would emit a `delivery_failure` JSON
  line and throw.)
- The DevOps_Agent shows a newly received investigation for the delivered incident
  (incident id `M-logs-error-rate-<incidentTimestamp>`).

---

## Stage 4 — Runbook execution

**Pass condition:** the agent investigation references `runbook://M-logs-error-rate` and
shows steps executing (R7.4).

**Concrete checks:**
- The DevOps_Agent investigation references the runbook `runbook://M-logs-error-rate`.
- The investigation shows the runbook's investigation steps executing in ascending
  order (evidence gathered via the read-only MCP tools against the OpenSearch and AMP
  data sources).

---

## Stage 5 — RCA + remediation availability

**Pass condition:** exactly one RCA finding is viewable; remediation guidance is shown
separately, retrievable via DevOps_Agent or OpenSearch_App (R7.5 / R7.6).

**Concrete checks:**
- Exactly one RCA finding is viewable for the incident, and it references each element
  of the gathered Evidence_Bundle.
- The remediation guidance for `M-logs-error-rate` (including the confirmation-gated
  `disable-payment-failure-flag` action) is surfaced **separately** from the RCA
  finding, retrievable via the DevOps_Agent or the OpenSearch_App.

---

## Reset to baseline (R7.8)

**Pass condition:** after `./reset.sh`, the payment-failure WARN log volume falls back
to baseline (~0) and all associated monitors return to *non-triggered*.

**Concrete checks:**
- Run `./reset.sh`; the SSM command completes with `Status=Success` and
  `src/flagd/demo.flagd.json` shows `paymentFailure` with `"defaultVariant": "off"`.
- The count of `"Payment request failed. Invalid token."` WARN logs in
  `logs-otel-v1-000001` stops rising and returns to baseline (~0).
- Re-query `GET _plugins/_alerting/monitors/{id}` for each associated monitor
  (`M-logs-error-rate` and any others that tripped) and confirm no `ACTIVE` alert
  remains — every associated monitor has returned to the non-triggered baseline state.
