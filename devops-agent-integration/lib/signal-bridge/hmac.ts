/**
 * HMAC signing/verification for the Signal_Bridge webhook contract.
 *
 * Pure, AWS-free logic implementing the DevOps_Agent generic-webhook
 * authentication scheme from the design: the signature is HMAC-SHA256 over the
 * signing input `"<timestamp>:<payload>"`, encoded as base64 and delivered in
 * the `x-amzn-event-signature` header (timestamp in `x-amzn-event-timestamp`).
 *
 * Implements Requirement 6.6: a component presenting credentials that are not
 * authorized for a requested action has that action denied. {@link verifyHmac}
 * models that deny by returning `false` for any signature that does not match
 * the recomputed HMAC, using a constant-time comparison to avoid leaking timing
 * information about how much of the signature matched.
 */

import { createHmac, timingSafeEqual } from "crypto";

/**
 * The signing input is `"<timestamp>:<payload>"` per the webhook HMAC contract.
 */
function signingInput(payloadJson: string, timestamp: string): string {
  return `${timestamp}:${payloadJson}`;
}

/**
 * Compute the HMAC-SHA256 signature over `"<timestamp>:<payload>"`.
 *
 * @param payloadJson the serialized incident payload (the exact bytes POSTed)
 * @param secret the shared webhook HMAC key
 * @param timestamp the incident/request timestamp used as the signed prefix
 * @returns the base64-encoded HMAC-SHA256 signature
 */
export function signHmac(payloadJson: string, secret: string, timestamp: string): string {
  return createHmac("sha256", secret)
    .update(signingInput(payloadJson, timestamp))
    .digest("base64");
}

/**
 * Verify a presented signature against the recomputed HMAC-SHA256.
 *
 * Recomputes the expected signature via {@link signHmac} and compares it to the
 * presented `signature` using {@link timingSafeEqual} (constant-time). A length
 * mismatch short-circuits to `false` because `timingSafeEqual` requires equal
 * buffer lengths; this also covers malformed or empty signatures.
 *
 * @param payloadJson the serialized incident payload
 * @param secret the shared webhook HMAC key
 * @param timestamp the incident/request timestamp
 * @param signature the presented base64 signature to verify
 * @returns `true` iff `signature` equals the recomputed HMAC, else `false`
 */
export function verifyHmac(
  payloadJson: string,
  secret: string,
  timestamp: string,
  signature: string
): boolean {
  const expected = signHmac(payloadJson, secret, timestamp);

  const expectedBuf = Buffer.from(expected, "utf8");
  const presentedBuf = Buffer.from(signature, "utf8");

  // Constant-time comparison requires equal-length buffers; unequal lengths
  // mean the signature cannot match, so deny without a timing-variable compare.
  if (expectedBuf.length !== presentedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, presentedBuf);
}
