/**
 * Account / region containment check for the Signal_Bridge.
 *
 * Pure, AWS-free logic implementing the containment constraint from the design's
 * "Account and region containment" property (Property 10) and Requirements
 * R1.7, R6.7, and R6.8: the Signal_Bridge operates exclusively within account
 * `111122223333` and region `ap-southeast-2`, and any attempt to access a
 * resource outside that account or region is denied.
 *
 * These functions perform no I/O and make no AWS calls; they are intended to be
 * evaluated before any outbound access as an in-process guard.
 */

import { ACCOUNT, REGION } from "../types";

/** A resource target identified by its AWS account and region. */
export interface Target {
  account: string;
  region: string;
}

/**
 * Determine whether an outbound target is permitted by the account/region
 * containment policy.
 *
 * A target is permitted if and only if it resides in the single permitted
 * account ({@link ACCOUNT}) AND the single permitted region ({@link REGION}).
 * Any other account or region is denied (R1.7, R6.7, R6.8).
 *
 * @param target the resource target's account and region
 * @returns `true` iff `target.account === ACCOUNT` and `target.region === REGION`
 */
export function isTargetPermitted(target: Target): boolean {
  return target.account === ACCOUNT && target.region === REGION;
}

/**
 * Parse the account and region from an AWS ARN string.
 *
 * ARNs have the form `arn:partition:service:region:account-id:resource...`.
 * The `region` and `account-id` segments are extracted positionally. Some ARNs
 * legitimately omit the region and/or account (e.g. IAM ARNs use an empty
 * region), in which case the corresponding field is returned as an empty string.
 *
 * This helper is pure: it does not resolve or validate the resource, it only
 * parses the fixed ARN structure. Returns `null` when the input is not a
 * syntactically valid ARN (missing the `arn:` prefix or too few segments).
 *
 * @param arn an ARN string, e.g. `arn:aws:sns:ap-southeast-2:111122223333:devops-agent-alerts`
 * @returns `{ account, region }` parsed from the ARN, or `null` when not a valid ARN
 */
export function parseAccountRegionFromArn(
  arn: string
): { account: string; region: string } | null {
  // An ARN has at least 6 colon-delimited segments:
  //   arn : partition : service : region : account-id : resource
  // The resource segment itself may contain additional colons, so we only need
  // the first six segments; splitting with a limit keeps the remainder intact
  // but here we only read indices 3 (region) and 4 (account).
  const segments = arn.split(":");

  if (segments.length < 6 || segments[0] !== "arn") {
    return null;
  }

  const region = segments[3] ?? "";
  const account = segments[4] ?? "";

  return { account, region };
}
