import nearestPointOnLine from "@turf/nearest-point-on-line";
import bearing from "@turf/bearing";
import destinationPoint from "@turf/destination";
import distance from "@turf/distance";
import { feature, point } from "@turf/helpers";
import type { TravelMode } from "./types";
import { fetchRoutes, type DirectionsRoute } from "./mapboxDirections";

/** At most two local candidates around one relevant turn. Never generate a
 * detour just to fill a second card; the planner must verify a real benefit. */
export async function generateDetourRoutes(
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
  baseRoute: DirectionsRoute,
  avoidPoints: [number, number][],
  mode: TravelMode,
  token: string,
  offsetM = Math.min(250, Math.max(100, baseRoute.distanceM * 0.08)),
  signal?: AbortSignal,
): Promise<DirectionsRoute[]> {
  signal?.throwIfAborted();
  if (baseRoute.distanceM < 600 || baseRoute.geometry.coordinates.length < 2) return [];
  const avoid = avoidPoints.find((p) =>
    distance(p, [origin.lng, origin.lat], { units: "meters" }) > 200 &&
    distance(p, [destination.lng, destination.lat], { units: "meters" }) > 200
  );
  if (!avoid) return [];
  const line = feature(baseRoute.geometry);
  const snapped = nearestPointOnLine(line, point(avoid));
  const coords = baseRoute.geometry.coordinates;
  const idx = Math.min(coords.length - 2, Math.max(0, snapped.properties.index ?? 0));
  const routeBearing = bearing(point(coords[idx]), point(coords[idx + 1]));
  const results = await Promise.all([90, -90].map(async (side) => {
    const waypoint = destinationPoint(snapped, offsetM / 1000, routeBearing + side, { units: "kilometers" });
    const [lng, lat] = waypoint.geometry.coordinates;
    try {
      return await fetchRoutes(origin, destination, mode, token, {
        waypoints: [{ lng, lat }], alternatives: false, signal, timeoutMs: 5_000,
      });
    } catch {
      // Missing side roads or an optional candidate timing out must not discard
      // the usable primary route. User cancellation must still propagate.
      signal?.throwIfAborted();
      return [];
    }
  }));
  signal?.throwIfAborted();
  return results.flat();
}
