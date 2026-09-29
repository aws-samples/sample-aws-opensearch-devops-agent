# Demo Scenarios

Two fault-injection surfaces let you reproduce incidents deterministically.

## Reaching the demo host (VPC-private)

The demo workloads, `flagd`, and the fault-panel run on the SSM-managed EC2 host inside
the private VPC — there are no public endpoints. Use AWS Systems Manager to reach them.

```bash
# The demo instance id (from your Part 1 deployment)
DEMO=<demo-instance-id>

# fault-panel UI on :8085
aws ssm start-session --target "$DEMO" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8085"],"localPortNumber":["8085"]}'
# → http://localhost:8085

# flagd UI is served under the frontend-proxy path — forward 8080, open /feature
aws ssm start-session --target "$DEMO" \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'
# → http://localhost:8080/feature
```

The `induce-flag.sh` / `reset-flag.sh` scripts run over SSM Run Command and take an
`INSTANCE_ID` (and optional `REGION` / `PROFILE`) via environment variables.

## 1. OpenTelemetry Astronomy Shop — `flagd` feature flags

The shop exposes feature flags through `flagd`. Toggle them with the bundled scripts (which edit the flag and restart `flagd`) or the flagd UI.

| Flag | Variant | Trips monitor(s) |
|---|---|---|
| `paymentFailure` | `100%` | `M-logs-error-rate`, `M-amp-promql` |
| `emailMemoryLeak` | `10000x` | `M-trace-latency-slo` |
| `cartFailure` | `on` | `M-servicemap-anomaly` |

```bash
# Induce (defaults shown; override with env vars)
FLAG=paymentFailure VARIANT=100% bash ./scenarios/induce-flag.sh

# Reset
FLAG=paymentFailure bash ./scenarios/reset-flag.sh
```

> The flagd UI is served under the frontend-proxy path (`/feature`), not on the flagd port directly.

## 2. GenAI travel planner — fault-injection panel

The multi-agent travel planner (orchestrator + weather-agent + events-agent + MCP tool server) is driven by a weighted fault-injection panel (HTTP API on port `8085`). It selects faults probabilistically per request.

| Preset | Effect | Trips monitor(s) |
|---|---|---|
| `all_clean` | 100% healthy (baseline) | — |
| `latency_spike` | 70% weather-agent 5 s latency | `M-travelagent-latency-slo` |
| `chaos` | random errors across agents | `M-travelagent-error-rate` |
| `cascading_failure` | both sub-agents fail + partial | `M-travelagent-error-rate` |
| `deep_traces_only` | very deep trace waterfalls | — |

```bash
# Set a preset
curl -s -X POST http://<fault-panel>:8085/config \
  -H 'content-type: application/json' -d '{"preset":"chaos"}'

# Custom weights (drive both agent monitors at once)
curl -s -X POST http://<fault-panel>:8085/config \
  -H 'content-type: application/json' \
  -d '{"fault_weights":{"none":0.0,"weather_high_latency":0.45,"weather_error":0.30,"events_error":0.25},"canary_interval":10}'

# Reset
curl -s -X POST http://<fault-panel>:8085/config \
  -H 'content-type: application/json' -d '{"preset":"all_clean"}'
```

> The panel supports a real-LLM mode; keep it disabled unless you intend to incur Amazon Bedrock model-invocation cost.

## Timing

Monitors evaluate a rolling ~5-minute window on a 1-minute schedule with a minimum request count, and each action is throttled (60 min) after it fires. After inducing a fault, allow the window to fill (a shorter fault-panel canary interval fills it faster) before expecting an investigation.

## Watching the loop

```bash
# Find the Signal Bridge Lambda name (from the deployed stack)
FN=$(aws cloudformation describe-stack-resources --stack-name DevOpsAgent-SignalBridge \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" \
  --output text)

# Watch delivery
aws logs filter-log-events \
  --log-group-name "/aws/lambda/${FN}" \
  --start-time $(( ($(date +%s) - 900) * 1000 )) \
  --query "events[].message" --output text | grep delivered
# → {"event":"delivered","monitorId":"...","httpStatus":200,"attempt":1}
```
