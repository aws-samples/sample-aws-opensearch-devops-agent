/**
 * Service-map anomaly detection (Alert_Monitor `M-servicemap-anomaly`).
 *
 * Pure detection logic for the OpenSearch service-map monitor. Given the set of
 * dependency edges aggregated from `otel-v2-apm-service-map-000001`, the monitor
 * triggers if and only if at least one edge's error rate or average latency
 * exceeds its configured threshold within the evaluation interval.
 *
 * These functions are pure (no AWS calls) so they can be exercised directly by
 * both the deployed painless trigger script and the property/unit tests.
 *
 * Requirements: 2.3
 * Design: Property 3 (Service-map dependency anomaly), "OpenSearch Alerting
 * Monitor (service-map dependency anomaly)".
 */

import type { ServiceMapEdge } from "../types";

/** Threshold pair for the service-map monitor. */
export interface ServiceMapThresholds {
  /** Edge error-rate threshold, as a percentage (0..100). */
  edgeErrPct: number;
  /** Edge average-latency threshold, in milliseconds. */
  edgeLatMs: number;
}

/**
 * Compute a single dependency edge's error rate as a percentage in [0, 100].
 *
 * `errorCount / totalCount * 100`, returning `0` when `totalCount` is `0`
 * (no traffic on the edge cannot be anomalous by error rate).
 */
export function edgeErrorRate(edge: ServiceMapEdge): number {
  if (edge.totalCount === 0) {
    return 0;
  }
  return (edge.errorCount / edge.totalCount) * 100;
}

/**
 * Return true iff a single edge is anomalous: its error rate meets or exceeds
 * `edgeErrPct`, OR its average latency exceeds `edgeLatMs`.
 *
 * Note the intentional comparator asymmetry mirroring the design's painless
 * script: error rate uses `>=` (meets or exceeds) and latency uses `>`.
 */
export function isEdgeAnomalous(
  edge: ServiceMapEdge,
  edgeErrPct: number,
  edgeLatMs: number
): boolean {
  return edgeErrorRate(edge) >= edgeErrPct || edge.averageLatencyMs > edgeLatMs;
}

/**
 * Return true iff any edge in the set is anomalous under the given thresholds.
 * An empty edge set is never anomalous.
 */
export function hasAnomalousEdge(
  edges: ServiceMapEdge[],
  thresholds: ServiceMapThresholds
): boolean {
  return edges.some((edge) =>
    isEdgeAnomalous(edge, thresholds.edgeErrPct, thresholds.edgeLatMs)
  );
}
