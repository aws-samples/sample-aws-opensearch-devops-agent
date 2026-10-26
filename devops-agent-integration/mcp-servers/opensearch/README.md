# OpenSearch MCP Evidence Server (`devops-agent-opensearch-mcp`)

Container image that packages the **upstream, OpenSearch-project-maintained**
MCP server so the DevOps Agent can gather log/trace/service-map evidence from the
VPC-private `obs-stack` OpenSearch domain during Runbook execution.

There is **no custom MCP tool code** in this directory. The image only installs
and configures the upstream package — the agent uses that server's generic tools
(`ListIndexTool`, `SearchIndexTool`, `IndexMappingTool`, `GetShardsTool`, and the
PPL tool) with an explicit index + time field + query body per Runbook step.

## Upstream package

| | |
|---|---|
| Package | [`opensearch-mcp-server-py`](https://pypi.org/project/opensearch-mcp-server-py/) (OpenSearch project) |
| Version | **`0.11.0`** (pinned via the `OPENSEARCH_MCP_VERSION` Docker build arg) |
| Source | https://github.com/opensearch-project/opensearch-mcp-server-py |
| License | Apache-2.0 |
| Install | `pip install opensearch-mcp-server-py==0.11.0` (in the `Dockerfile`) |

To bump the version, pass `--build-arg OPENSEARCH_MCP_VERSION=x.y.z` to the build
(or export `OPENSEARCH_MCP_VERSION` before running `build-and-push.sh`).

## MCP transport & port

The server is launched in **streaming** mode (`--transport stream`), which serves
the MCP protocol over **streamable-HTTP and SSE**:

| Endpoint | Method | Purpose |
|---|---|---|
| `/mcp` | `POST` | Streamable-HTTP MCP (primary; used by AgentCore Runtime) |
| `/sse` | `GET` | Server-Sent Events MCP stream |

- **Bind address:** `0.0.0.0`
- **Port:** **`8000`**

Port `8000` and the `/mcp` path match the **Amazon Bedrock AgentCore Runtime MCP
protocol contract** (MCP servers listen on `0.0.0.0:8000/mcp`; `8080` is the
separate HTTP-agent contract). The `EXPOSE 8000` in the `Dockerfile` documents
this. Host/port/transport can be overridden via the `MCP_HOST` / `MCP_PORT` /
`MCP_TRANSPORT` env vars.

## Environment variables

| Variable | Set where | Value / notes |
|---|---|---|
| `OPENSEARCH_URL` | **Injected at deploy time** (task 10.2) | HTTPS endpoint of the VPC-private `obs-stack` domain. Must be `https://…` so traffic is TLS + SigV4. Intentionally **not** baked into the image. |
| `AWS_REGION` | Image default `us-east-1` | Region used for SigV4 signing against the `es` service. |
| `OPENSEARCH_ENABLED_CATEGORIES` | Image default `observability` | Enables `PPLQueryTool` (the design's "PPLTool") in addition to the default core tools. |
| `OPENSEARCH_SETTINGS_ALLOW_WRITE` | Image default `false` | Defense-in-depth: disables write ops at the tool layer (read-only is primarily enforced by IAM + FGAC — see below). |
| `OPENSEARCH_SSL_VERIFY` | Image default `true` | Require TLS certificate verification for the domain connection. |

No AWS access keys are configured. Credentials come **only** from the host
execution role via the standard AWS credential chain (see Authentication).

## Authentication (IAM / SigV4)

The server authenticates to the domain with **IAM/SigV4 using ambient
credentials** from the host **execution role** (AgentCore Runtime, or ECS Fargate
as the alternative host). Because `OPENSEARCH_URL` + `AWS_REGION` are set and no
basic-auth/`AWS_IAM_ARN`/no-auth is configured, the upstream server signs each
request against the `es` service using the role credentials it finds in the
environment. **No static keys are ever baked into the image.**

The OpenSearch execution role is additionally **FGAC-mapped to a read-only role**
on the domain in **task 11.2** (`devops-agent-opensearch-mcp-role`), restricted to
the target index patterns below with read/search permissions only. Read-only is
enforced by scoped IAM (`es:ESHttpGet`/`es:ESHttpPost` for read APIs only) plus
the FGAC mapping — not by any code in this image.

## Target indices

The agent queries these `obs-stack` indices (index + time field per Runbook step):

| Index pattern | Time field | Contents |
|---|---|---|
| `logs-otel-v1*` | `time` | Application/OTel logs |
| `otel-v1-apm-span*` | `endTime` | Trace spans |
| `otel-v2-apm-service-map*` | `@timestamp` | Service-map edges |

## Build & publish

`build-and-push.sh` builds for **`linux/arm64`** (the ECS Fargate task uses an
ARM64 `runtimePlatform`) and pushes to **Amazon ECR**, tagging both `latest` and
a UTC date tag. It is idempotent (creates the ECR repo only if missing) and
prints the resulting image URI. Account, Region, ECR repo, and profile are all
derived from your AWS CLI configuration and overridable via environment variables
(`AWS_ACCOUNT_ID`, `AWS_REGION`, `ECR_REPO`, `AWS_PROFILE`, `PLATFORM`).

```bash
./build-and-push.sh
```

- Uses the default AWS credential chain; set `AWS_PROFILE` to use a named profile.
- Cross-building arm64 on an amd64 host requires QEMU/buildx
  (`docker run --privileged tonistiigi/binfmt --install arm64`).
- **Does not deploy anything** — pass the printed image URI as
  `-c openSearchImageUri=...` to the CDK app (the `DevOpsAgent-FargateMcp` stack).

Prerequisites: Docker with `buildx`, AWS CLI v2, and configured AWS credentials.

## Notes & assumptions

- `OPENSEARCH_URL` (the VPC-private domain HTTPS endpoint) is injected at deploy
  time by the `DevOpsAgent-FargateMcp` stack as a container environment variable;
  it is intentionally not baked into the image.
- The MCP contract endpoint is `0.0.0.0:8000/mcp` and the upstream streaming server
  serves MCP at `/mcp` + `/sse`. Verified against the `opensearch-mcp-server-py`
  USER_GUIDE and confirmed end-to-end by a live deploy — re-check if the pinned
  version changes.
- Ambient-credential SigV4 (the ECS task role) is selected by setting
  `OPENSEARCH_URL` + `AWS_REGION` with no other auth method. If a future package
  version changes auth precedence, set the appropriate IAM auth env vars explicitly.
- `PPLTool` in the design corresponds to the upstream `PPLQueryTool` (in the
  `observability` category), which is why that category is enabled.
