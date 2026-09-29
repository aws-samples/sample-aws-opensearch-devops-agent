/**
 * Signal_Bridge payload builder.
 *
 * Pure, AWS-free logic that normalizes a fired alert (`SnsAlertEnvelope`) plus its
 * applicable runbook reference into the DevOps Agent generic-webhook incident payload
 * (`DevOpsAgentIncident`).
 *
 * Requirements:
 * - R1.6: each delivered alert carries the Alert_Monitor identifier, the triggering
 *   condition, the incident timestamp, and a reference to the applicable Runbook.
 * - R1.7 / R6.7: the payload's metadata pins the demo's account (111122223333) and
 *   region (ap-southeast-2).
 */

import {
  ACCOUNT,
  REGION,
  type DevOpsAgentIncident,
  type SnsAlertEnvelope,
} from "../types";

/**
 * Build a `DevOpsAgentIncident` from a fired-alert envelope and its runbook reference.
 *
 * The resulting payload matches the documented generic-webhook schema:
 * - `eventType` is fixed to `"incident"`.
 * - `incidentId` is the dedupe key `${monitorId}-${incidentTimestamp}`.
 * - `action` is `"created"` (a newly fired alert) and `priority` is `"HIGH"`.
 * - `title` is `${monitorId}: ${triggeringCondition}` and `description` is the
 *   triggering condition.
 * - `timestamp` is the incident timestamp (when the monitor transitioned).
 * - `service` is taken from `seedEvidence.service` when that value is a string.
 * - `data` carries the R1.6-required fields plus the seed evidence and the
 *   account/region metadata (R1.7 / R6.7).
 *
 * This function is pure and performs no AWS calls.
 *
 * @param env the fired-alert envelope parsed from the monitor's SNS notification
 * @param runbookRef reference to the applicable Runbook (e.g. "runbook://M-logs-error-rate")
 * @returns the DevOps Agent incident payload ready to be signed and delivered
 */
export function buildAgentPayload(
  env: SnsAlertEnvelope,
  runbookRef: string
): DevOpsAgentIncident {
  const { monitorId, triggeringCondition, incidentTimestamp, seedEvidence } = env;

  // Derive the optional service from the seed evidence snapshot when present as a string.
  const seedService = seedEvidence?.["service"];
  const service = typeof seedService === "string" ? seedService : undefined;

  return {
    eventType: "incident",
    incidentId: `${monitorId}-${incidentTimestamp}`,
    action: "created",
    priority: "HIGH",
    title: `${monitorId}: ${triggeringCondition}`,
    description: triggeringCondition,
    timestamp: incidentTimestamp,
    ...(service !== undefined ? { service } : {}),
    data: {
      monitorId,
      triggeringCondition,
      incidentTimestamp,
      runbookRef,
      ...(seedEvidence !== undefined ? { seedEvidence } : {}),
      metadata: { account: ACCOUNT, region: REGION },
    },
  };
}
