import destination from "@turf/destination";
import { point } from "@turf/helpers";
import type { DirectionsRoute, RouteStep } from "./mapboxDirections";
import type { SurveyedIntersectionProps, WaitingZoneProps } from "./types";

/**
 * DEV ONLY (`?fixture=1`): a synthetic route built around a real 待轉格 from
 * the dataset, so the whole navigation UI — two-stage phases, lanes, arrival —
 * can be exercised with the simulator when Mapbox is unreachable. Geometry is
 * straight lines, not roads; never shown outside development.
 */
export function buildFixtureRoute(
  zones: GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps>,
  surveyed: GeoJSON.FeatureCollection<GeoJSON.Point, SurveyedIntersectionProps>
): DirectionsRoute | null {
  const zone = zones.features.find((z) => z.properties.serves_quality === "good" && z.properties.conf > 0.9);
  const centre = zone && surveyed.features.find((s) => s.properties.id === zone.properties.intersection_id);
  if (!zone || !centre) return null;

  const C = point(centre.geometry.coordinates);
  const f = zone.properties.serves_from_bearing;
  const e = zone.properties.serves_to_bearing;
  const A = destination(C, 0.45, f + 180, { units: "kilometers" });
  const B = destination(C, 0.3, e, { units: "kilometers" });
  const D = destination(B, 0.25, e + 90, { units: "kilometers" });
  const c = (p: GeoJSON.Feature<GeoJSON.Point>) => p.geometry.coordinates as [number, number];

  const step = (partial: Partial<RouteStep> & Pick<RouteStep, "distanceM" | "maneuverType" | "location" | "geometry" | "name">): RouteStep => ({
    durationS: partial.distanceM / 9,
    instruction: "",
    bearingBefore: 0,
    bearingAfter: 0,
    lanes: null,
    exit: null,
    voiceTriggersM: [],
    ...partial,
  });

  const steps: RouteStep[] = [
    step({ distanceM: 450, maneuverType: "depart", name: "測試路一段", location: c(A), bearingBefore: f, bearingAfter: f, geometry: { type: "LineString", coordinates: [c(A), c(C)] } }),
    step({ distanceM: 300, maneuverType: "turn", modifier: "left", name: "測試路二段", location: c(C), bearingBefore: f, bearingAfter: e, geometry: { type: "LineString", coordinates: [c(C), c(B)] } }),
    step({
      distanceM: 250, maneuverType: "turn", modifier: "right", name: "測試街", location: c(B), bearingBefore: e, bearingAfter: e + 90,
      lanes: [
        { valid: false, active: false, indications: ["left"], validIndication: null },
        { valid: false, active: false, indications: ["straight"], validIndication: null },
        { valid: true, active: true, indications: ["straight", "right"], validIndication: "right" },
      ],
      geometry: { type: "LineString", coordinates: [c(B), c(D)] },
    }),
    step({ distanceM: 0, maneuverType: "arrive", modifier: "right", name: "", location: c(D), bearingBefore: e + 90, bearingAfter: e + 90, geometry: { type: "LineString", coordinates: [c(D), c(D)] } }),
  ];
  const coords = [c(A), c(C), c(B), c(D)];
  return {
    geometry: { type: "LineString", coordinates: coords },
    durationMin: 2,
    durationS: 110,
    distanceKm: 1,
    distanceM: 1000,
    steps,
    congestion: ["low", "moderate", "heavy"],
    maxspeedKph: [50, 50, 40],
  };
}

export const FIXTURE_ENABLED = import.meta.env.DEV && new URLSearchParams(window.location.search).has("fixture");
