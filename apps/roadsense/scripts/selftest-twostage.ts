/**
 * Offline self-consistency test for twoStageLeft: for every surveyed
 * intersection that has boxes, synthesize the left turn each box claims to
 * serve (approach = serves_from, exit = serves_to, node = intersection
 * centre) and check the matcher picks a box serving that approach. Also
 * checks that the mirrored approach (coming from the opposite direction)
 * does not get matched to the same box.
 */
import { readFileSync } from "node:fs";
import { annotateLeftTurns, angleDiff360 } from "../src/lib/twoStageLeft";
import type { DirectionsRoute, RouteStep } from "../src/lib/mapboxDirections";

const zones = JSON.parse(readFileSync(new URL("../public/geojson/taipei_waiting_zones.geojson", import.meta.url), "utf8"));
const surveyed = JSON.parse(readFileSync(new URL("../public/geojson/taipei_surveyed_intersections.geojson", import.meta.url), "utf8"));
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

let ok = 0, wrongZone = 0, missed = 0, mirrorHit = 0, ambiguousSkipped = 0;
const misses: string[] = [];
for (const z of zones.features) {
  const p = z.properties;
  if (p.serves_quality !== "good") { ambiguousSkipped++; continue; }
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

// coverage semantics: a node far from any surveyed point must be "unknown"
const far = annotateLeftTurns(fakeRoute([121.0, 24.0], 0, 270), { zones, surveyed })[0];
console.log("far away status:", far.status);
