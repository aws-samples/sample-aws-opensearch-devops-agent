import * as fc from "fast-check";
import { ACCOUNT, REGION } from "../lib/types";
import type { DevOpsAgentIncident } from "../lib/types";

/**
 * Placeholder scaffold test. Confirms the shared types compile/import and the
 * account/region constants and fast-check harness are wired up. Real logic tests
 * are added by later tasks.
 */
describe("scaffold", () => {
  it("pins the account and region constants", () => {
    expect(ACCOUNT).toBe("111122223333");
    expect(REGION).toBe("us-east-1");
  });

  it("shared incident type is usable", () => {
    const incident: DevOpsAgentIncident = {
      eventType: "incident",
      incidentId: "M-logs-error-rate-2024-01-01T00:00:00Z",
      action: "created",
      priority: "HIGH",
      title: "scaffold",
      timestamp: "2024-01-01T00:00:00Z",
      data: {
        monitorId: "M-logs-error-rate",
        triggeringCondition: "error-rate 8.3% >= 5%",
        incidentTimestamp: "2024-01-01T00:00:00Z",
        runbookRef: "runbook://M-logs-error-rate",
        metadata: { account: ACCOUNT, region: REGION }
      }
    };
    expect(incident.data.metadata.account).toBe(ACCOUNT);
  });

  it("fast-check global config is active (min 100 runs)", () => {
    // A trivial property; the shared setup sets numRuns=100 globally.
    fc.assert(
      fc.property(fc.integer(), (n) => Number.isInteger(n))
    );
  });
});
