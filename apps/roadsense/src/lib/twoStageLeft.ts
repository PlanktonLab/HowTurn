import nearestPointOnLine from "@turf/nearest-point-on-line";
import { feature, point } from "@turf/helpers";
import type { DirectionsRoute, RouteStep } from "./mapboxDirections";
import type { LeftTurn, SurveyedIntersectionProps, TwoStageStatus, WaitingZoneProps } from "./types";

/**
 * Direction-aware two-stage-left-turn (兩段式左轉) detection.
 *
 * A 待轉格 is not a place the route "passes"; it is a facility that serves one
 * specific approach to an intersection. So the unit of analysis is the LEFT
 * TURN in the route's step list, not the box:
 *
 *   rider arrives with bearing f, leaves with bearing e (≈ f − 90°). Taiwan's
 *   rule (道交規則 §99) sends them straight through to the box at the far
 *   RIGHT of the intersection, where they wait facing e. Hence a box serves
 *   this turn when its centre lies in the ahead-right quadrant of the
 *   maneuver node (offset between f and f+90°), within ~55 m — 99% of the
 *   detected boxes are within 44 m of the intersection centre. Detected boxes
 *   are wider than deep (≈3.3 × 2.2 m, scooters park side by side), so the
 *   box axis is only used as a weak "aligned with the road grid" filter, never
 *   to infer the facing direction.
 *
 * With no matching box the answer depends on whether DieTurn ever looked at
 * that intersection: surveyed → "direct" (turn from the left lane), otherwise
 * "unknown" — we never promise a direct left for a junction we have not seen,
 * because that mistake costs a fine or worse, while an unnecessary wait only
 * costs a light cycle.
 */

const MATCH_RADIUS_M = 55;
const SURVEY_RADIUS_M = 40;
/** box axis must be within this of the approach or exit direction */
const GRID_TOLERANCE_DEG = 35;
const SERVES_TOLERANCE_DEG = 35;
/** box centre must be past the node, and not on its left (node placement
 *  noise on wide intersections is a few metres, hence the slack) */
const MIN_AHEAD_M = 2;
const MIN_RIGHT_M = -4;
const MAX_QUADRANT_DEG = 100;

const M_PER_DEG_LAT = 110_574;

type Zone = GeoJSON.Feature<GeoJSON.Polygon, WaitingZoneProps>;
type Surveyed = GeoJSON.Feature<GeoJSON.Point, SurveyedIntersectionProps>;

export interface TwoStageContext {
  zones: GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps>;
  surveyed: GeoJSON.FeatureCollection<GeoJSON.Point, SurveyedIntersectionProps>;
}

export function isLeftTurnStep(step: RouteStep): boolean {
  if (step.maneuverType === "depart" || step.maneuverType === "arrive") return false;
  if (["fork", "merge", "on ramp", "off ramp", "roundabout", "rotary", "exit roundabout", "exit rotary"].includes(step.maneuverType)) return false;
  return step.modifier === "left" || step.modifier === "sharp left";
}

export function annotateLeftTurns(route: DirectionsRoute, ctx: TwoStageContext): LeftTurn[] {
  const line = feature(route.geometry);
  const out: LeftTurn[] = [];
  let cursor = 0;
  route.steps.forEach((step, i) => {
    const at = cursor;
    cursor += step.distanceM;
    if (!isLeftTurnStep(step)) return;

    const zone = matchZone(step, ctx.zones.features);
    let status: TwoStageStatus;
    if (zone) status = "required";
    else status = isSurveyed(step.location, ctx.surveyed.features) ? "direct" : "unknown";

    let zoneEntryM: number | null = null;
    if (zone) {
      const snapped = nearestPointOnLine(line, point([zone.properties.lon, zone.properties.lat]), { units: "meters" });
      zoneEntryM = snapped.properties.location ?? at;
    }
    out.push({
      stepIndex: i,
      status,
      zone,
      location: step.location,
      approachBearing: step.bearingBefore,
      exitBearing: step.bearingAfter,
      distanceAlongM: at,
      zoneEntryM,
      roadName: step.name,
    });
  });
  return out;
}

function matchZone(step: RouteStep, zones: Zone[]): Zone | null {
  const [lng0, lat0] = step.location;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const f = (step.bearingBefore * Math.PI) / 180;
  const fx = Math.sin(f), fy = Math.cos(f);
  const degRadiusLat = MATCH_RADIUS_M / M_PER_DEG_LAT;
  const degRadiusLon = MATCH_RADIUS_M / mPerDegLon;

  let best: { zone: Zone; score: number } | null = null;
  for (const z of zones) {
    const p = z.properties;
    if (Math.abs(p.lat - lat0) > degRadiusLat || Math.abs(p.lon - lng0) > degRadiusLon) continue;
    const dx = (p.lon - lng0) * mPerDegLon;
    const dy = (p.lat - lat0) * M_PER_DEG_LAT;
    const dist = Math.hypot(dx, dy);
    if (dist > MATCH_RADIUS_M) continue;

    const ahead = dx * fx + dy * fy;
    const right = dx * fy - dy * fx;
    if (ahead < MIN_AHEAD_M || right < MIN_RIGHT_M) continue;
    // angle of the offset measured clockwise from the approach direction:
    // 0° = dead ahead, 90° = directly to the right; the box should sit between
    const quadrantDeg = (Math.atan2(right, ahead) * 180) / Math.PI;
    if (quadrantDeg > MAX_QUADRANT_DEG) continue;

    const gridDiff = Math.min(angleDiff180(p.heading_deg, step.bearingBefore), angleDiff180(p.heading_deg, step.bearingAfter));
    if (gridDiff > GRID_TOLERANCE_DEG) continue;

    // lower is better: a box sitting squarely in the ahead-right quadrant and
    // close to the node wins; agreement with the offline estimate is a bonus
    let score = Math.abs(quadrantDeg - 45) / 45 + dist / MATCH_RADIUS_M;
    if (angleDiff360(p.serves_from_bearing, step.bearingBefore) <= SERVES_TOLERANCE_DEG) score -= 0.4;
    if (!best || score < best.score) best = { zone: z, score };
  }
  return best?.zone ?? null;
}

function isSurveyed(location: [number, number], surveyed: Surveyed[]): boolean {
  const [lng0, lat0] = location;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const degLat = SURVEY_RADIUS_M / M_PER_DEG_LAT;
  const degLon = SURVEY_RADIUS_M / mPerDegLon;
  for (const s of surveyed) {
    const [lng, lat] = s.geometry.coordinates;
    if (Math.abs(lat - lat0) > degLat || Math.abs(lng - lng0) > degLon) continue;
    const dx = (lng - lng0) * mPerDegLon;
    const dy = (lat - lat0) * M_PER_DEG_LAT;
    if (Math.hypot(dx, dy) <= SURVEY_RADIUS_M) return true;
  }
  return false;
}

/** difference between two axial (0–180 ambiguous) bearings */
export function angleDiff180(a: number, b: number): number {
  const d = Math.abs(((a - b) % 180) + 180) % 180;
  return Math.min(d, 180 - d);
}

export function angleDiff360(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return Math.min(d, 360 - d);
}
