/**
 * IAM policy-shape validation for the DevOps Agent Integration demo.
 *
 * This is a PURE function: it inspects a plain, JSON-serializable IAM policy
 * document and reports whether it satisfies the least-privilege / containment
 * shape the design requires. It makes no AWS calls and constructs no CDK
 * constructs, so it can be unit- and property-tested in isolation (task 9.3).
 *
 * The shape rules enforced (design "Property 11: Least-privilege IAM policy
 * shape", R6.1/R6.3) are:
 *
 *   1. No wildcard actions. An `Action` entry is rejected when it is literally
 *      `"*"` or when it contains a `"*"` anywhere (e.g. a service wildcard such
 *      as `"es:*"`). Least-privilege requires every action to be named
 *      explicitly.
 *
 *   2. No whole-resource wildcard. A `Resource` is rejected only when it is
 *      literally `"*"`. Resource-path suffixes such as
 *      `arn:aws:ec2:...:network-interface/*` or
 *      `arn:aws:logs:...:log-group:/aws/lambda/foo:*` are the least-privilege
 *      form for those APIs — they scope a path within a specific
 *      service/account/region and are NOT the disallowed open-ended `"*"`
 *      resource, so they are accepted.
 *
 *   3. Account / region containment. Every resource ARN must parse as a
 *      well-formed ARN whose region segment equals {@link REGION} and whose
 *      account segment equals {@link ACCOUNT}. (Every ARN in this project is
 *      regional, so an empty region segment is not accepted.)
 *
 * _Requirements: 6.1, 6.3_
 */

import { ACCOUNT, REGION } from "../types";
import type { IamPolicyDocument, IamPolicyStatement } from "./policies";

/** Result of validating an IAM policy document's shape. */
export interface PolicyShapeValidationResult {
  /** True iff the policy satisfies every least-privilege / containment rule. */
  valid: boolean;
  /** Human-readable descriptions of every rule violation found (empty when valid). */
  errors: string[];
}

/**
 * Validate that an IAM policy document has a least-privilege, account/region
 * contained shape.
 *
 * Rejects any statement whose action list contains a wildcard action, and any
 * statement whose resource is the whole-resource wildcard `"*"`; asserts every
 * resource ARN is scoped to {@link ACCOUNT} / {@link REGION}. All violations are
 * collected (validation does not short-circuit) so the caller sees the complete
 * set of problems at once.
 *
 * @param policy the IAM policy document to inspect
 * @returns `{ valid, errors }` — `valid` is true iff `errors` is empty
 */
export function validatePolicyShape(policy: IamPolicyDocument): PolicyShapeValidationResult {
  const errors: string[] = [];
  const statements: IamPolicyStatement[] = policy?.Statement ?? [];

  for (const statement of statements) {
    const sid = statement?.Sid ?? "<no-sid>";

    // Rule 1: no wildcard actions (literal "*" or any action containing "*",
    // e.g. a service wildcard like "es:*").
    const actions = normalizeToArray(statement?.Action);
    for (const action of actions) {
      if (typeof action !== "string" || action.includes("*")) {
        errors.push(
          `Statement "${sid}": wildcard action ${JSON.stringify(action)} is not permitted; ` +
            `least-privilege requires every IAM action to be named explicitly.`,
        );
      }
    }

    // Rules 2 & 3: resources must not be the whole-resource wildcard and must be
    // ARNs scoped to the permitted account and region.
    const resources = normalizeToArray(statement?.Resource);
    for (const resource of resources) {
      errors.push(...validateResource(sid, resource));
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate a single `Resource` value from a statement.
 *
 * @param sid the owning statement's Sid, used for error context
 * @param resource the resource value to check
 * @returns an array of violation messages (empty when the resource is valid)
 */
function validateResource(sid: string, resource: unknown): string[] {
  const errors: string[] = [];

  if (typeof resource !== "string" || resource.length === 0) {
    errors.push(`Statement "${sid}": resource must be a non-empty ARN string, got ${JSON.stringify(resource)}.`);
    return errors;
  }

  // Rule 2: reject only the whole-resource wildcard. A path suffix like
  // ".../network-interface/*" is NOT this case and is handled by the ARN parse
  // below (its region/account segments are still concrete).
  if (resource === "*") {
    errors.push(
      `Statement "${sid}": whole-resource wildcard "*" is not permitted; ` +
        `least-privilege requires a scoped resource ARN.`,
    );
    return errors;
  }

  // Rule 3: must be a well-formed ARN scoped to ACCOUNT / REGION.
  // ARN layout: arn:partition:service:region:account-id:resource[:...]
  if (!resource.startsWith("arn:")) {
    errors.push(`Statement "${sid}": resource ${JSON.stringify(resource)} is not a valid ARN.`);
    return errors;
  }

  const parts = resource.split(":");
  if (parts.length < 6) {
    errors.push(
      `Statement "${sid}": resource ${JSON.stringify(resource)} is not a well-formed ARN ` +
        `(expected arn:partition:service:region:account:resource).`,
    );
    return errors;
  }

  const region = parts[3];
  const account = parts[4];

  if (region !== REGION) {
    errors.push(
      `Statement "${sid}": resource ${JSON.stringify(resource)} region ${JSON.stringify(region)} ` +
        `is not scoped to ${REGION}.`,
    );
  }

  if (account !== ACCOUNT) {
    errors.push(
      `Statement "${sid}": resource ${JSON.stringify(resource)} account ${JSON.stringify(account)} ` +
        `is not scoped to ${ACCOUNT}.`,
    );
  }

  return errors;
}

/**
 * Normalize a policy field that may be a single value or an array into an array.
 * IAM permits both `"Action": "s3:GetObject"` and `"Action": [...]`; this keeps
 * the validator robust to either form.
 */
function normalizeToArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
