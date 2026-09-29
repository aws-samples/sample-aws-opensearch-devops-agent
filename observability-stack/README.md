# Observability Stack (Part 1)

This component provisions the AWS-managed observability platform that the DevOps Agent integration builds on:

- **Amazon OpenSearch Service** domain (VPC-private, FGAC, TLS, KMS) for logs and traces.
- **Amazon Managed Service for Prometheus (AMP)** workspace for metrics.
- **Amazon OpenSearch Ingestion (OSIS)** pipeline running Data Prepper, receiving OTLP over SigV4.
- **OpenTelemetry Collector** on an SSM-managed EC2 host exporting logs/traces to OSIS and metrics to AMP.
- **OpenSearch UI / OpenSearch Application** for dashboards, plus the OpenTelemetry demo workloads.

It follows the OpenSearch `observability-stack` project's **"Option 4: AWS Managed Services"** deployment path, expressed as AWS CDK (TypeScript) in a two-stack split:

- `ObsInfra` — foundational, long-lived resources (domain, AMP, DQS, pipeline IAM role, KMS/VPC).
- `ObservabilityStack` — FGAC role mapping, the OSIS pipeline, the OpenSearch Application, UI init, and the optional demo workload.

## How to deploy it (upstream quickstart)

The CDK source for this platform is maintained in the upstream OpenSearch
**`observability-stack`** project and is **not vendored into this sample**. Deploy it
directly from there, then capture its coordinates for Part 2
(see [`../docs/prerequisites-and-deployment.md`](../docs/prerequisites-and-deployment.md)).

- **Deploy on AWS managed services (start here):** https://observability.opensearch.org/docs/deploy/aws/
- **CLI installer** (fastest end-to-end deploy): https://github.com/opensearch-project/observability-stack/blob/main/aws/cli-installer/README.md
- **CDK** (infrastructure-as-code, same resources): https://github.com/opensearch-project/observability-stack/blob/main/aws/cdk/README.md
- **Amazon OpenSearch Service — Get started with observability:** https://docs.aws.amazon.com/opensearch-service/latest/developerguide/observability-get-started.html

> For the VPC-private posture this sample assumes, deploy the platform into a VPC
> (the upstream installer/CDK takes `--vpc-id` / `--subnet-ids` / `--security-group-ids`),
> then pass those same coordinates to Part 2.

See [`../docs/architecture.md`](../docs/architecture.md) for how this platform fits the
overall design.

## Contract consumed by Part 2

| Resource | Referenced as | Notes |
|---|---|---|
| OpenSearch domain endpoint | `<domain>.<region>.es.amazonaws.com` | VPC-private; FGAC master is an IAM role |
| AMP workspace id | `ws-xxxxxxxx-...` | metrics store queried via PromQL |
| OSIS pipeline name | `obs-stack-pipeline` | OTLP `/v1/{logs,traces,metrics}` sub-paths |
| Telemetry indices | `logs-otel-v1-*`, `otel-v1-apm-span-*`, `otel-v2-apm-service-map-*` | monitors query these |
