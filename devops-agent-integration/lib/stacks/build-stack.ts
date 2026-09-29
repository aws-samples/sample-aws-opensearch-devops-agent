/**
 * BuildStack — in-account, Docker-free build of the OpenSearch MCP server
 * container image.
 *
 * Motivation: the MCP image must be **arm64** (the ECS Fargate task uses an ARM64
 * runtimePlatform), but most users don't have a local arm64 Docker builder. This stack
 * removes that dependency entirely: it provisions the ECR repository plus an AWS
 * CodeBuild project running on **native ARM compute** (no QEMU) that builds the image
 * from source (shipped as an S3 asset of `mcp-servers/`) and pushes it to ECR.
 *
 * Usage (no local Docker required):
 *   1. `cdk deploy DevOpsAgent-Build`
 *   2. `aws codebuild start-build --project-name devops-agent-mcp-build`
 *      (wait for SUCCEEDED) — the image then exists at the deterministic URI below.
 *
 * The pushed image URI matches the CDK app default, so no `-c openSearchMcpImageUri`
 * override is needed:
 *   <account>.dkr.ecr.<region>.amazonaws.com/devops-agent-opensearch-mcp:latest
 */

import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as s3assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";

export const OPENSEARCH_MCP_REPO = "devops-agent-opensearch-mcp";

export class BuildStack extends cdk.Stack {
  /** Deterministic image URI (":latest") for the CDK app to consume. */
  public readonly openSearchImageUri: string;
  /** The CodeBuild project name to `start-build`. */
  public readonly projectName: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;

    // ECR repositories (emptied + removed on stack destroy for easy cleanup).
    const openSearchRepo = new ecr.Repository(this, "OpenSearchMcpRepo", {
      repositoryName: OPENSEARCH_MCP_REPO,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    // Ship the mcp-servers/ directory as the CodeBuild source (zipped S3 asset).
    const source = new s3assets.Asset(this, "McpServersSource", {
      path: path.join(__dirname, "..", "..", "mcp-servers"),
    });

    // CodeBuild project on NATIVE ARM compute — builds real arm64 without QEMU.
    const project = new codebuild.Project(this, "McpBuild", {
      projectName: "devops-agent-mcp-build",
      source: codebuild.Source.s3({
        bucket: source.bucket,
        path: source.s3ObjectKey,
      }),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true, // required for `docker build`
      },
      environmentVariables: {
        ACCOUNT: { value: account },
        REGISTRY: { value: registry },
        OS_REPO: { value: OPENSEARCH_MCP_REPO },
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              "echo Logging in to ECR $REGISTRY",
              "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $REGISTRY",
            ],
          },
          build: {
            commands: [
              "echo Building arm64 MCP image on native ARM compute",
              "docker build --platform linux/arm64 -t $REGISTRY/$OS_REPO:latest ./opensearch",
            ],
          },
          post_build: {
            commands: [
              "docker push $REGISTRY/$OS_REPO:latest",
              "echo Pushed $REGISTRY/$OS_REPO:latest",
            ],
          },
        },
      }),
    });

    // Least-privilege: build role may push to the repo + read the source asset.
    openSearchRepo.grantPullPush(project);
    source.grantRead(project);

    this.openSearchImageUri = `${registry}/${OPENSEARCH_MCP_REPO}:latest`;
    this.projectName = project.projectName;

    new cdk.CfnOutput(this, "CodeBuildProjectName", { value: project.projectName });
    new cdk.CfnOutput(this, "OpenSearchImageUri", { value: this.openSearchImageUri });
  }
}
