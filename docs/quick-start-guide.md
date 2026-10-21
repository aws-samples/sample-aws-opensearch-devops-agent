# Quick Start

Run top-to-bottom in one terminal. Values set with `export` are reused by later steps.
Full details/troubleshooting: [prerequisites-and-deployment.md](prerequisites-and-deployment.md).

> **Run everything from your local machine; commands act on AWS via API/CDK/SSM. The only non-terminal step is creating the webhook in the DevOps Agent console (Step 7).**

> **Fill in every `<...>` placeholder with your own value before running — don't paste the angle brackets.** In zsh/bash `<` and `>` are redirection operators, so a literal `<account-id>` throws a parse error instead of an obvious message.

**Prerequisites:** an AWS account (admin creds) in a Region where **AWS DevOps Agent** is
available; **Node.js 18+, AWS CDK v2, AWS CLI v2, python3**

> **Time:** end-to-end is roughly **60–90 min**, almost all of it spent waiting on AWS
> (the OpenSearch domain in Step 3 and the Fargate MCP service in Step 6 are the long poles).
> Per-step estimates are noted at each deploy below.


---

### 0. Authenticate to AWS (do this first; Step 2 verifies it)
Sign in however your account hands out access — then the `aws sts get-caller-identity` check in
Step 2 confirms it worked.
- **IAM Identity Center / SSO:** `aws configure sso` (one-time), then `aws sso login --profile <name>` and `export AWS_PROFILE=<name>`
- **Access keys:** `aws configure` (paste Access Key ID + Secret)
- **Temporary creds:** `export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_SESSION_TOKEN=…`
- **AWS CloudShell:** already signed in — skip

> If `aws sts get-caller-identity` later errors with `Unable to locate credentials` or
> `ExpiredToken`, you're not signed in — come back and do this step.

### 1. Get the code + generate the internal TLS cert
```bash
git clone https://github.com/aws-samples/sample-aws-opensearch-devops-agent.git
cd sample-aws-opensearch-devops-agent/devops-agent-integration
npm install
bash mcp-servers/tls/generate.sh
```
> The final `generate.sh` step creates the self-signed cert for the internal MCP TLS endpoint.
> Every `cdk` command reads it at synth time, and it is git-ignored (never commit the private
> key), so run it once before any `cdk` command below.

### 2. Set account/Region + bootstrap  ·  ⏱ ~1–2 min (seconds if already bootstrapped)
```bash
export CDK_DEFAULT_ACCOUNT=<account-id>
export CDK_DEFAULT_REGION=<region>
export AWS_REGION=$CDK_DEFAULT_REGION AWS_DEFAULT_REGION=$CDK_DEFAULT_REGION
aws sts get-caller-identity
cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
```
> `aws sts get-caller-identity` must show YOUR account before you continue. If you sign in with a
> named profile, run `export AWS_PROFILE=<profile>` before these commands.

### 3. Deploy the platform (Part 1) and capture its coordinates  ·  ⏱ ~25–40 min
Deploy the upstream OpenSearch **observability-stack** fully, into a VPC (this creates the
domain, **AMP workspace**, OSIS pipeline, and **OTel demo EC2 host**) — guided deploy docs:
https://observability.opensearch.org/docs/deploy/aws/
```bash
npx @opensearch-project/observability-stack
```
> ⏱ The OpenSearch domain alone takes ~10–15 min to go active (the long pole); the full
> platform install is ~25–40 min, and demo telemetry then takes a further ~10–15 min to start
> appearing in the indices.
> Supply-chain note: `npx` fetches the latest published `@opensearch-project/observability-stack`
> at runtime. This upstream installer runs an **interactive guided deployment** where the
> OpenSearch version and components are selected in the steps *after* the `npx` invocation, so
> the OpenSearch release is chosen (and thereby pinned) during that flow. To also pin the
> installer package itself to a known-good release, append a version — `npx
> @opensearch-project/observability-stack@<version>`.

#### Get the FGAC master role ARN
The upstream observability-stack installer creates the domain's FGAC master as an **IAM role**
(the demo host's role); the AWS OpenSearch API does not expose it. Retrieve it from the **IAM
console**: open **IAM → Roles**, search your domain name (e.g. `obs-stack-1792…`), and select
the role whose name ends in **`-ec2-demo-role`**. Its ARN is your `FGAC_MASTER_ROLE_ARN` —
`arn:aws:iam::<account-id>:role/obs-stack-<id>-ec2-demo-role`.

Then capture coordinates. Fill in the **first two** `export`s (your domain name, and the ARN
from the step above); the rest auto-populate:
```bash
export DOMAIN_NAME=<opensearch-domain-name>
export FGAC_MASTER_ROLE_ARN=<domain-fgac-master-role-arn>

export DOMAIN_HOST=$(aws opensearch describe-domain --domain-name "$DOMAIN_NAME" --region "$AWS_REGION" --query 'DomainStatus.Endpoints.vpc' --output text)
export DOMAIN_ARN=$(aws opensearch describe-domain --domain-name "$DOMAIN_NAME" --region "$AWS_REGION" --query 'DomainStatus.ARN' --output text)
export OBS_VPC_ID=$(aws opensearch describe-domain --domain-name "$DOMAIN_NAME" --region "$AWS_REGION" --query 'DomainStatus.VPCOptions.VPCId' --output text)
export OBS_SG=$(aws opensearch describe-domain --domain-name "$DOMAIN_NAME" --region "$AWS_REGION" --query 'DomainStatus.VPCOptions.SecurityGroupIds' --output text | tr '\t' ',')
export OBS_SUBNETS=$(aws opensearch describe-domain --domain-name "$DOMAIN_NAME" --region "$AWS_REGION" --query 'DomainStatus.VPCOptions.SubnetIds' --output text | tr '\t' ',')
export OBS_AZS=$(aws opensearch describe-domain --domain-name "$DOMAIN_NAME" --region "$AWS_REGION" --query 'DomainStatus.VPCOptions.AvailabilityZones' --output text | tr '\t' ',')
export AMP_WS_ID=$(aws amp list-workspaces --region "$AWS_REGION" --query 'workspaces[0].workspaceId' --output text)
export AMP_WS_ARN=$(aws amp list-workspaces --region "$AWS_REGION" --query 'workspaces[0].arn' --output text)
export DEMO_INSTANCE_ID=$(aws ec2 describe-instances --region "$AWS_REGION" --filters "Name=instance-state-name,Values=running" "Name=tag:Name,Values=*bservability*,*otel*,*demo*" --query 'Reservations[0].Instances[0].InstanceId' --output text)

echo "$DOMAIN_HOST | vpc=$OBS_VPC_ID | subnets=$OBS_SUBNETS | amp=$AMP_WS_ID | demo=$DEMO_INSTANCE_ID"
```
> Each value is fetched on its own single line — no backticks, no `\` line-continuations, no
> `read` heredoc — so the block survives copy-paste into zsh. Verify the echo shows real values:
> if `vpc=`/`subnets=` are empty, **stop** and fix before Step 6, because an empty `OBS_*` makes
> the deploy silently fall back to placeholder IDs like `vpc-0123456789abcdef0` and fail.

### 4. Build the MCP image (CodeBuild)  ·  ⏱ ~2 min deploy + ~3–6 min image build
```bash
cdk deploy DevOpsAgent-Build --require-approval never
aws codebuild start-build --project-name devops-agent-mcp-build --region "$AWS_REGION"
BID=$(aws codebuild list-builds-for-project --project-name devops-agent-mcp-build --region "$AWS_REGION" --query "ids[0]" --output text)
aws codebuild batch-get-builds --ids "$BID" --region "$AWS_REGION" --query "builds[0].buildStatus" --output text
```
> The last command prints the build status. Wait until it reports `SUCCEEDED` before continuing.

### 5. Create the webhook secret (placeholder for now)
The Part 2 stack **imports** this secret by name; its real value is set in Step 7 (after the
webhook exists). Create it now with a placeholder so the import resolves:
```bash
export WEBHOOK_URL='https://placeholder.invalid/webhook'
aws secretsmanager create-secret --name devops-agent/webhook-hmac \
  --region "$AWS_REGION" --secret-string placeholder 2>/dev/null \
  || echo "secret already exists — ok"
```

### 6. Deploy detection + agent (Part 2)  ·  ⏱ ~20–30 min
This creates the Signal Bridge, the MCP Services, and the Agent Space
`devops-agent-incident-response`:
> ⏱ Breakdown: Shared ~1 min, SignalBridge ~2 min, **FargateMcp ~10–15 min** (NLB + ECS task
> reaching healthy — the long pole), Integration ~2–5 min (the `AWS::DevOpsAgent::Service`
> live handshake).
```bash
cdk deploy --all \
  -c obsVpcId=$OBS_VPC_ID -c obsSubnetIds=$OBS_SUBNETS -c obsAvailabilityZones=$OBS_AZS \
  -c obsSecurityGroupId=$OBS_SG -c opensearchEndpoint=$DOMAIN_HOST -c domainArn=$DOMAIN_ARN \
  -c ampWorkspaceId=$AMP_WS_ID \
  -c ampEndpoint=https://aps-workspaces.$AWS_REGION.amazonaws.com/workspaces/$AMP_WS_ID \
  -c ampWorkspaceArn=$AMP_WS_ARN -c devopsAgentWebhookUrl=$WEBHOOK_URL \
  -c fgacMasterRoleArn=$FGAC_MASTER_ROLE_ARN -c assignPublicIpForFargate=true \
  --require-approval never
```

> **If Step 6 fails on `AWS::DevOpsAgent::Service`** with *"could not complete request
> to provider"*: that create runs a live validation handshake that can fail
> transiently. Do a clean redeploy:
> ```bash
> aws cloudformation delete-stack --stack-name DevOpsAgent-Integration --region "$AWS_REGION"
> aws cloudformation wait stack-delete-complete --stack-name DevOpsAgent-Integration --region "$AWS_REGION"
> ```
> then re-run the Step 6 deploy.

### 7. Create the webhook on the Agent Space, then wire it in  ·  ⏱ ~2–3 min (SignalBridge redeploy)
In the **AWS DevOps Agent** console, open the Agent Space **`devops-agent-incident-response`**
(created in Step 6) → add an **Agent Space Webhook** with **HMAC** auth. Copy its two values,
store the secret, and redeploy the Signal Bridge with the real URL.

Set `WEBHOOK_URL` to the webhook URL on `devops-agent-incident-response`, and `HMAC_SECRET` to
its HMAC signing key, then run:
```bash
export WEBHOOK_URL='https://...'
export HMAC_SECRET='...'
aws secretsmanager put-secret-value --secret-id devops-agent/webhook-hmac \
  --region "$AWS_REGION" --secret-string "$HMAC_SECRET"

cdk deploy DevOpsAgent-SignalBridge \
  -c obsVpcId=$OBS_VPC_ID -c obsSubnetIds=$OBS_SUBNETS -c obsAvailabilityZones=$OBS_AZS \
  -c obsSecurityGroupId=$OBS_SG -c opensearchEndpoint=$DOMAIN_HOST -c domainArn=$DOMAIN_ARN \
  -c ampWorkspaceId=$AMP_WS_ID \
  -c ampEndpoint=https://aps-workspaces.$AWS_REGION.amazonaws.com/workspaces/$AMP_WS_ID \
  -c ampWorkspaceArn=$AMP_WS_ARN -c devopsAgentWebhookUrl=$WEBHOOK_URL \
  -c fgacMasterRoleArn=$FGAC_MASTER_ROLE_ARN --require-approval never
```

### 8. Register monitors + FGAC + AMP rules (once)  ·  ⏱ ~1–2 min
```bash
export SNS_TOPIC_ARN=$(aws cloudformation describe-stack-resources --stack-name DevOpsAgent-SignalBridge --region "$AWS_REGION" \
  --query "StackResources[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId | [0]" --output text)
OS_ROLE=$(aws cloudformation describe-stack-resources --stack-name DevOpsAgent-FargateMcp --region "$AWS_REGION" \
  --query "StackResources[?ResourceType=='AWS::IAM::Role' && contains(LogicalResourceId,'OpenSearch')].PhysicalResourceId | [0]" --output text)
export MCP_TASK_ROLE_ARN=$(aws iam get-role --role-name "$OS_ROLE" --query Role.Arn --output text)

DEMO_INSTANCE_ID=$DEMO_INSTANCE_ID REGION=$AWS_REGION DOMAIN_HOST=$DOMAIN_HOST \
SNS_TOPIC_ARN=$SNS_TOPIC_ARN MCP_TASK_ROLE_ARN=$MCP_TASK_ROLE_ARN \
AMP_WORKSPACE_ID=$AMP_WS_ID FGAC_MASTER_ROLE_ARN=$FGAC_MASTER_ROLE_ARN \
  bash ./scenarios/register-from-host.sh
```

### 9. Verify
```bash
bash ./scenarios/verify.sh
```
> Expect every check to report `[ PASS ]`.

### 10. Trigger an incident
```bash
FLAG=paymentFailure VARIANT=100% INSTANCE_ID=$DEMO_INSTANCE_ID bash ./scenarios/induce-flag.sh
```
Within ~1–5 min an investigation appears in the DevOps Agent console (Agent Space
`devops-agent-incident-response`). Reset:
```bash
FLAG=paymentFailure INSTANCE_ID=$DEMO_INSTANCE_ID bash ./scenarios/reset-flag.sh
```

### 11. Clean up  ·  ⏱ ~15–25 min (Part 2) + ~15–20 min (Part 1 teardown)
```bash
cdk destroy --all
aws secretsmanager delete-secret --secret-id devops-agent/webhook-hmac --force-delete-without-recovery --region "$AWS_REGION"
```
> Then delete the Agent Space Webhook (Step 7) in the console, and tear down the Part 1
> observability-stack.

---

## Observing the loop (dashboards, fault injection, alert → investigation)

Use this around Steps 9–10 (before you clean up in Step 11). The OpenSearch domain is viewed
through the managed **OpenSearch UI application** (a public, AWS-managed endpoint). The demo app
(`flagd`, fault-panel) is **VPC-private**, so you reach it by AWS Systems Manager port-forwarding
from the demo host (`$DEMO_INSTANCE_ID`). Full catalog: [demo-scenarios.md](demo-scenarios.md).

### 1. Open the OpenSearch UI application
The observability-stack provisions a managed **OpenSearch UI application** (its name matches your
domain, e.g. `obs-stack-<id>`) that serves OpenSearch Dashboards against the VPC-private domain
over a public, AWS-managed endpoint — so you do **not** tunnel to the cluster's own OpenSearch
Dashboards. Open it from the AWS console: **Amazon OpenSearch Service → OpenSearch UI**
(Applications) → select the application for your domain → **Open**. It authenticates with your
IAM identity.

To get the endpoint URL directly:
```bash
aws opensearch list-applications --region "$AWS_REGION" \
  --query "ApplicationSummaries[?name=='$DOMAIN_NAME'].endpoint" --output text
```
→ open that `https://application-<domain>-<id>.<region>.opensearch.amazonaws.com` URL in your browser.

### 2. Inject a fault via feature flag
Faults in the OTel Astronomy Shop are driven by `flagd`. Two ways:
- **Script (same as Step 10):**
  ```bash
  FLAG=paymentFailure VARIANT=100% INSTANCE_ID=$DEMO_INSTANCE_ID bash ./scenarios/induce-flag.sh
  ```
- **flagd UI** — port-forward the frontend proxy and open the `/feature` page:
  ```bash
  aws ssm start-session --target "$DEMO_INSTANCE_ID" \
    --document-name AWS-StartPortForwardingSession \
    --parameters '{"portNumber":["8080"],"localPortNumber":["8080"]}'
  ```
  → open **http://localhost:8080/feature**, set `paymentFailure` to the **`100%`** variant.
  This drives the `M-logs-error-rate` monitor. (The GenAI travel-planner uses a separate
  fault-panel on `:8085` — see [demo-scenarios.md](demo-scenarios.md).)

### 3. See the alert trigger and the investigation start
Allow ~1–5 min — monitors evaluate a rolling 5-minute window on a 1-minute schedule.

- **In the OpenSearch UI application:** left menu → **OpenSearch Plugins → Alerting → Monitors →
  `M-logs-error-rate`**. When the payment/checkout error rate crosses 5%, the
  `error-rate-over-5pct` trigger flips to **Active** and an entry appears in the monitor's
  **Alerts** tab.
- **Confirm the Signal Bridge delivered the alert to the agent:**
  ```bash
  FN=$(aws cloudformation describe-stack-resources --stack-name DevOpsAgent-SignalBridge --region "$AWS_REGION" \
    --query "StackResources[?ResourceType=='AWS::Lambda::Function'].PhysicalResourceId | [0]" --output text)
  aws logs filter-log-events --log-group-name "/aws/lambda/${FN}" --region "$AWS_REGION" \
    --start-time $(( ($(date +%s) - 900) * 1000 )) --query "events[].message" --output text | grep delivered
  ```
  → a `{"event":"delivered",...,"httpStatus":200}` line.
- **In the AWS DevOps Agent console:** open Agent Space **`devops-agent-incident-response`** →
  **Investigations**. Within ~1–5 min of the alert, a new investigation appears and the agent
  begins pulling evidence through the MCP servers.

Reset the fault when done:
```bash
FLAG=paymentFailure INSTANCE_ID=$DEMO_INSTANCE_ID bash ./scenarios/reset-flag.sh
```
