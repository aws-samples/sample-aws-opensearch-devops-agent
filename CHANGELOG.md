# Changelog

All notable changes to this sample are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Initial public sample: **Autonomous Monitoring using Amazon OpenSearch Service and AWS DevOps Agent**.
- AWS-managed observability platform (OpenTelemetry Collector → Amazon OpenSearch Ingestion → Amazon OpenSearch Service + Amazon Managed Service for Prometheus).
- AWS DevOps Agent integration via a secure HMAC-signed webhook Signal Bridge (Amazon SNS → AWS Lambda → webhook).
- Maintained OpenSearch MCP evidence server (`opensearch-mcp-server-py`) on Amazon ECS Fargate, reached through `AWS::DevOpsAgent::PrivateConnection`. Metrics from Amazon Managed Prometheus feed the detection/alerting path.
- Six detection monitors across OpenSearch Alerting and AMP alerting rules, including two GenAI-agent monitors.
- INCIDENT_RCA runbook asset guiding the agent's investigation.
- Fault-injectable demo workloads: OpenTelemetry Astronomy Shop (`flagd`) and a multi-agent GenAI travel planner (fault-injection panel).
- Optional Amazon OpenSearch Service zero-ETL S3 direct-query log lake.
- AWS CDK (TypeScript) infrastructure with unit and property-based (`fast-check`) tests.
