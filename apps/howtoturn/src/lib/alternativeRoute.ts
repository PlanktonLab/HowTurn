import nearestPointOnLine from "@turf/nearest-point-on-line";
import bearing from "@turf/bearing";
import destinationPoint from "@turf/destination";
import { feature, point } from "@turf/helpers";
import type { TravelMode } from "./types";
import { fetchRoutes, type DirectionsRoute } from "./mapboxDirections";

// Mapbox Directions often returns a single route for short urban trips, so an
// alternative that avoids something specific (a two-stage-left-turn
// intersection, an accident hotspot) cannot rely on the API's own
// alternatives. Instead we generate a real detour: push a waypoint sideways
// off the route next to the thing we want to avoid and ask Mapbox to route
// through it. The result is a genuine road-network route, which the caller
// then re-analyzes — nothing about the comparison is hardcoded.
const DETOUR_OFFSET_M = 350;
const MAX_AVOID_POINTS = 3;

export async function generateDetourRoutes(
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
  baseRoute: DirectionsRoute,
  avoidPoints: [number, number][],
  mode: TravelMode,
  token: string,
  offsetM: number = DETOUR_OFFSET_M
): Promise<DirectionsRoute[]> {
  if (avoidPoints.length === 0) return [];

  const line = feature(baseRoute.geometry);
  const coords = baseRoute.geometry.coordinates;
  const requests: Promise<DirectionsRoute[]>[] = [];

  for (const avoid of avoidPoints.slice(0, MAX_AVOID_POINTS)) {
    const target = point(avoid);
    // bearing of the route where it passes the avoided spot, so the detour
    // waypoint is pushed perpendicular to the direction of travel
    const snapped = nearestPointOnLine(line, target);
    const idx = Math.max(1, (snapped.properties.index ?? 1) as number);
    const a = point(coords[Math.max(0, idx - 1)]);
    const b = point(coords[Math.min(coords.length - 1, idx + 1)]);
    const routeBearing = bearing(a, b);

    for (const side of [90, -90]) {
      const waypoint = destinationPoint(target, offsetM / 1000, routeBearing + side, {
        units: "kilometers",
      });
      const [wlng, wlat] = waypoint.geometry.coordinates;
      requests.push(
        fetchRoutes(origin, destination, mode, token, { waypoints: [{ lng: wlng, lat: wlat }], alternatives: false }).catch(() => [])
      );
    }
  }

  const settled = await Promise.all(requests);
  return settled.flat();
}
