/**
 * Offline self-consistency test for twoStageLeft: for every surveyed
 * intersection that has boxes, synthesize the left turn each box claims to
 * serve (approach = serves_from, exit = serves_to, node = intersection
 * centre) and check the matcher picks a box serving that approach. Also
 * checks that the mirrored approach (coming from the opposite direction)
 * does not get matched to the same box.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { annotateLeftTurns, angleDiff360 } from "../src/lib/twoStageLeft";
import type { DirectionsRoute, RouteStep } from "../src/lib/mapboxDirections";
import type { WaitingZoneProps } from "../src/lib/types";

const zones = JSON.parse(readFileSync(new URL("../public/geojson/taiwan_waiting_zones.geojson", import.meta.url), "utf8"));
const surveyed = JSON.parse(readFileSync(new URL("../public/geojson/taiwan_surveyed_intersections.geojson", import.meta.url), "utf8"));
const centre = new Map<string, [number, number]>(surveyed.features.map((f: any) => [f.properties.id, f.geometry.coordinates]));

function fakeRoute(node: [number, number], from: number, to: number): DirectionsRoute {
  const step = (type: string, modifier: string | undefined, bb: number, ba: number): RouteStep => ({
    distanceM: 100, durationS: 10, maneuverType: type, modifier, instruction: "", name: "測試路",
    location: node, bearingBefore: bb, bearingAfter: ba, lanes: null, exit: null, voiceTriggersM: [],
    geometry: { type: "LineString", coordinates: [node, node] },
  });
  return {
    geometry: { type: "LineString", coordinates: [node, node, node] },
    durationMin: 1, durationS: 60, distanceKm: 0.2, distanceM: 200, congestion: [], maxspeedKph: [],
    steps: [step("depart", undefined, from, from), step("turn", "left", from, to), step("arrive", undefined, to, to)],
  };
}

function fakeZone(overrides: Partial<WaitingZoneProps> = {}): GeoJSON.Feature<GeoJSON.Polygon, WaitingZoneProps> {
  const properties: WaitingZoneProps = {
    id: "direction-test", status: "auto", conf: 0.99, n_detections: 1,
    heading_deg: 0, length_m: 3, width_m: 2, corner: "NE",
    intersection_id: "direction-node", intersection_dist_m: 15,
    serves_from_bearing: 0, serves_to_bearing: 270, serves_quality: "good",
    lat: 25.0001, lon: 121.0001, confidence: "confirmed",
    source: "test", source_updated_at: "2026-09-12", ...overrides,
  };
  return {
    type: "Feature",
    properties,
    geometry: { type: "Polygon", coordinates: [[[121.00008, 25.00008], [121.00012, 25.00008], [121.00012, 25.00012], [121.00008, 25.00008]]] },
  };
}

// A nearby box matters only for the exact left-turn movement it serves.
const directionCtx = {
  zones: { type: "FeatureCollection", features: [fakeZone()] } as GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps>,
  surveyed: { type: "FeatureCollection", features: [] } as typeof surveyed,
};
assert.equal(annotateLeftTurns(fakeRoute([121, 25], 0, 270), directionCtx)[0].status, "required");
assert.equal(annotateLeftTurns(fakeRoute([121, 25], 180, 90), directionCtx)[0].status, "unknown", "opposite approach must not use this box");
assert.equal(annotateLeftTurns(fakeRoute([121, 25], 0, 225), directionCtx)[0].status, "unknown", "wrong exit direction must not use this box");
const straight = fakeRoute([121, 25], 0, 0);
straight.steps[1].modifier = "straight";
assert.equal(annotateLeftTurns(straight, directionCtx).length, 0, "going straight past a box must never affect routing");
const ambiguousCtx = { ...directionCtx, zones: { type: "FeatureCollection", features: [fakeZone({ serves_quality: "ambiguous" })] } as GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps> };
assert.equal(annotateLeftTurns(fakeRoute([121, 25], 0, 270), ambiguousCtx)[0].status, "unknown", "ambiguous direction must not become a required wait");
const probableCtx = { ...directionCtx, zones: { type: "FeatureCollection", features: [fakeZone({ status: "review", confidence: "probable" })] } as GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps> };
assert.equal(annotateLeftTurns(fakeRoute([121, 25], 0, 270), probableCtx)[0].status, "unknown", "probable detection must not force a detour");

// Taipei → Taichung exposed a false direct-left at Chang'an W. Road: a
// plausible box was only 1 m ahead of the routing node. High survey recall
// must not erase such evidence after the strict mandatory-wait filters fail.
const trustedSurvey = { type: "FeatureCollection", features: [{
  type: "Feature", geometry: { type: "Point", coordinates: [121, 25] },
  properties: { id: "direction-node", n_nodes: 1, imagery: "test", survey_recall: 1 },
}] } as typeof surveyed;
for (const overrides of [
  { lat: 25 + 1 / 110574, confidence: "probable" as const, serves_quality: "ambiguous" as const },
  { serves_from_bearing: 37, serves_to_bearing: 307 },
]) {
  const borderline = { zones: { type: "FeatureCollection", features: [fakeZone(overrides)] } as typeof directionCtx.zones, surveyed: trustedSurvey };
  assert.equal(annotateLeftTurns(fakeRoute([121, 25], 0, 270), borderline)[0].status, "unknown", "borderline evidence must not turn into a direct-left promise");
}
const otherDirection = { ...directionCtx, surveyed: trustedSurvey };
assert.equal(annotateLeftTurns(fakeRoute([121, 25], 180, 90), otherDirection)[0].status, "direct", "a box for the opposite movement still must not force a wait");

let ok = 0, wrongZone = 0, missed = 0, mirrorHit = 0, ambiguousSkipped = 0;
const misses: string[] = [];
for (const z of zones.features) {
  const p = z.properties;
  if (p.serves_quality !== "good" || p.confidence !== "confirmed") { ambiguousSkipped++; continue; }
  const node = centre.get(p.intersection_id)!;
  const lts = annotateLeftTurns(fakeRoute(node, p.serves_from_bearing, p.serves_to_bearing), { zones, surveyed });
  const lt = lts[0];
  if (lt.status !== "required") { missed++; misses.push(`${p.id} ${p.corner} d=${p.intersection_dist_m} h=${p.heading_deg}`); continue; }
  const got = lt.zone!.properties;
  if (got.id === p.id || (got.intersection_id === p.intersection_id && angleDiff360(got.serves_from_bearing, p.serves_from_bearing) <= 30)) ok++;
  else wrongZone++;

  // approach from the opposite direction, turning left the other way
  const mirror = annotateLeftTurns(fakeRoute(node, (p.serves_from_bearing + 180) % 360, (p.serves_to_bearing + 180) % 360), { zones, surveyed })[0];
  if (mirror.zone?.properties.id === p.id) mirrorHit++;
}
console.log({ ok, wrongZone, missed, mirrorHit, ambiguousSkipped, total: zones.features.length });
console.log("sample misses:", misses.slice(0, 8));
assert.equal(mirrorHit, 0, "a box must never match the opposite movement");
assert.equal(wrongZone, 0, "strict direction matching must not select a box for another movement");

// coverage semantics: a node far from any surveyed point must be "unknown"
const far = annotateLeftTurns(fakeRoute([121.0, 24.0], 0, 270), { zones, surveyed })[0];
console.log("far away status:", far.status);
assert.equal(far.status, "unknown");
