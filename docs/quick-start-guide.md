# Quick Start

Run top-to-bottom in one terminal. Values set with `export` are reused by later steps.
Full details/troubleshooting: [prerequisites-and-deployment.md](prerequisites-and-deployment.md).

**Prerequisites:** an AWS account (admin creds) in a Region where **AWS DevOps Agent** is
available; **Node.js 18+, AWS CDK v2, AWS CLI v2, python3**


---

### 1. Get the code + generate the internal TLS cert
```bash
git clone <this-repo-url>
cd autonomous-monitoring-opensearch-devops-agent/devops-agent-integration
npm install
# Generate the self-signed cert for the internal MCP TLS endpoint. It is read at
# synth time by every cdk command and is git-ignored (never commit the private key),
# so run this ONCE before any cdk command below.
bash mcp-servers/tls/generate.sh
```

### 2. Set account/Region + bootstrap
```bash
export CDK_DEFAULT_ACCOUNT=<account-id>
export CDK_DEFAULT_REGION=<region>
export AWS_REGION=$CDK_DEFAULT_REGION AWS_DEFAULT_REGION=$CDK_DEFAULT_REGION
# export AWS_PROFILE=<profile>   # if you use one
aws sts get-caller-identity          # must show YOUR account
cdk bootstrap aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION
```

### 3. Deploy the platform (Part 1) and capture its coordinates
Deploy the upstream OpenSearch **observability-stack** fully, into a VPC (this creates the
domain, **AMP workspace**, OSIS pipeline, and **OTel demo EC2 host**):
```bash
npx @opensearch-project/observability-stack        # https://observability.opensearch.org/docs/deploy/aws/
```
> Supply-chain note: `npx` fetches the latest published `@opensearch-project/observability-stack`
> at runtime. This upstream installer runs an **interactive guided deployment** where the
> OpenSearch version and components are selected in the steps *after* the `npx` invocation, so
> the OpenSearch release is chosen (and thereby pinned) during that flow. To also pin the
> installer package itself to a known-good release, append a version — `npx
> @opensearch-project/observability-stack@<version>`.
Then capture coordinates (you type only these two):
```bash
export DOMAIN_NAME=<opensearch-domain-name>
export FGAC_MASTER_ROLE_ARN=<domain-master-role-arn>

read -r DOMAIN_HOST DOMAIN_ARN OBS_VPC_ID OBS_SG OBS_SUBNETS OBS_AZS <<<"$(
  aws opensearch describe-domain --domain-name "$DOMAIN_NAME" --region "$AWS_REGION" \
    --query 'DomainStatus.[Endpoints.vpc, ARN, VPCOptions.VPCId, join(`,`,VPCOptions.SecurityGroupIds), join(`,`,VPCOptions.SubnetIds), join(`,`,VPCOptions.AvailabilityZones)]' --output text)"
export DOMAIN_HOST DOMAIN_ARN OBS_VPC_ID OBS_SG OBS_SUBNETS OBS_AZS
export AMP_WS_ID=$(aws amp list-workspaces --region "$AWS_REGION" --query 'workspaces[0].workspaceId' --output text)
export AMP_WS_ARN=$(aws amp list-workspaces --region "$AWS_REGION" --query 'workspaces[0].arn' --output text)
export DEMO_INSTANCE_ID=$(aws ec2 describe-instances --region "$AWS_REGION" \
  --filters "Name=instance-state-name,Values=running" "Name=tag:Name,Values=*bservability*,*otel*,*demo*" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

echo "$DOMAIN_HOST | amp=$AMP_WS_ID | demo=$DEMO_INSTANCE_ID"   # none may be empty/None
```

### 4. Build the MCP image (CodeBuild)
```bash
cdk deploy DevOpsAgent-Build --require-approval never
aws codebuild start-build --project-name devops-agent-mcp-build --region "$AWS_REGION"
# wait for SUCCEEDED:
BID=$(aws codebuild list-builds-for-project --project-name devops-agent-mcp-build --region "$AWS_REGION" --query "ids[0]" --output text)
aws codebuild batch-get-builds --ids "$BID" --region "$AWS_REGION" --query "builds[0].buildStatus" --output text
```

### 5. Create the webhook secret (placeholder for now)
The Part 2 stack **imports** this secret by name; its real value is set in Step 7 (after the
webhook exists). Create it now with a placeholder so the import resolves:
```bash
export WEBHOOK_URL='https://placeholder.invalid/webhook'   
aws secretsmanager create-secret --name devops-agent/webhook-hmac \
  --region "$AWS_REGION" --secret-string placeholder 2>/dev/null \
  || echo "secret already exists — ok"
```

### 6. Deploy detection + agent (Part 2)
This creates the Signal Bridge, the MCP Services, and the Agent Space
`devops-agent-incident-response`:
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

### 7. Create the webhook on the Agent Space, then wire it in
In the **AWS DevOps Agent** console, open the Agent Space **`devops-agent-incident-response`**
(created in Step 6) → add an **Agent Space Webhook** with **HMAC** auth. Copy its two values,
store the secret, and redeploy the Signal Bridge with the real URL:
```bash
export WEBHOOK_URL='https://...'     # the webhook URL on devops-agent-incident-response
export HMAC_SECRET='...'             # its HMAC signing key
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

### 8. Register monitors + FGAC + AMP rules (once)
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
bash ./scenarios/verify.sh     # expect all [ PASS ]
```

### 10. Trigger an incident
```bash
FLAG=paymentFailure VARIANT=100% INSTANCE_ID=$DEMO_INSTANCE_ID bash ./scenarios/induce-flag.sh
```
Within ~1–5 min an investigation appears in the DevOps Agent console (Agent Space
`devops-agent-incident-response`). Reset:
```bash
FLAG=paymentFailure INSTANCE_ID=$DEMO_INSTANCE_ID bash ./scenarios/reset-flag.sh
```

### 11. Clean up
```bash
cdk destroy --all
aws secretsmanager delete-secret --secret-id devops-agent/webhook-hmac --force-delete-without-recovery --region "$AWS_REGION"
# also delete the Agent Space Webhook (Step 7) in the console, then tear down the Part 1 observability-stack.
```
