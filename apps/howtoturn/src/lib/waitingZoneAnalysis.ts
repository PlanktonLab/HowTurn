import center from "@turf/center";
import booleanIntersects from "@turf/boolean-intersects";
import buffer from "@turf/buffer";
import { feature } from "@turf/helpers";
import type { WaitingZoneProps } from "./types";

const ROUTE_BUFFER_METERS = 25;

/**
 * Finds waiting-zone (待轉格) polygons the route actually passes through.
 * Works against whatever is in the waiting-zone GeoJSON — currently empty
 * (see config.ts), so this always returns [] until real annotated polygons
 * are added, at which point it starts working with no code changes needed.
 */
export function findWaitingZonesOnRoute(
  routeGeometry: GeoJSON.LineString,
  zones: GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps>
): GeoJSON.Feature<GeoJSON.Polygon, WaitingZoneProps>[] {
  if (!zones.features.length) return [];
  const line = feature(routeGeometry);
  const routeBuffer = buffer(line, ROUTE_BUFFER_METERS, { units: "meters" });
  if (!routeBuffer) return [];
  return zones.features.filter((z) => booleanIntersects(z, routeBuffer));
}

export function waitingZoneCenter(zone: GeoJSON.Feature<GeoJSON.Polygon>): [number, number] {
  const c = center(zone);
  return c.geometry.coordinates as [number, number];
}
