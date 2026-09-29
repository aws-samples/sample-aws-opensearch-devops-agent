import { ACCOUNT, REGION } from "../../lib/types";
import {
  buildOpenSearchMcpRolePolicy,
  buildSignalBridgeLambdaPolicy,
} from "../../lib/iam/policies";
import { validatePolicyShape } from "../../lib/iam/policy-shape";

/**
 * Unit tests for the maintained-MCP execution-role policy builder. The OpenSearch
 * MCP server carries its own least-privilege role: read-only `es:ESHttpGet`/
 * `es:ESHttpPost` on the domain. It must satisfy the least-privilege / containment
 * shape (R6.1, R6.3).
 */
describe("maintained MCP execution-role policies", () => {
  describe("buildOpenSearchMcpRolePolicy", () => {
    const policy = buildOpenSearchMcpRolePolicy();

    it("has exactly one OpenSearchReadOnly statement with read-only ES actions", () => {
      expect(policy.Statement).toHaveLength(1);
      const [stmt] = policy.Statement;
      expect(stmt.Sid).toBe("OpenSearchReadOnly");
      expect(stmt.Effect).toBe("Allow");
      expect(stmt.Action).toEqual(["es:ESHttpGet", "es:ESHttpPost"]);
      expect(stmt.Action).not.toContain("es:ESHttpPut");
      expect(stmt.Action).not.toContain("es:ESHttpDelete");
      expect(stmt.Resource).toBe(
        `arn:aws:es:${REGION}:${ACCOUNT}:domain/obs-stack/*`,
      );
    });

    it("passes the least-privilege policy-shape validation", () => {
      const result = validatePolicyShape(policy);
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });

  it("still builds the unchanged Signal_Bridge Lambda policy", () => {
    const policy = buildSignalBridgeLambdaPolicy();
    const sids = policy.Statement.map((s) => s.Sid);
    expect(sids).toEqual(["ReadWebhookSecret", "ConsumeDlq", "VpcEni", "Logs"]);
  });
});
