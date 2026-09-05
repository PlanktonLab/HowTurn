import type { TravelMode } from "./types";

// Mapbox Directions has no motorcycle profile, so 機車 routes on the driving
// network — correct for Taiwan (機車 shares the roadway) but the two-stage
// left turn is ours to add on top (see twoStageLeft.ts). driving-traffic gives
// live-traffic ETAs and per-segment congestion for the route line.
const PROFILE_MAP: Record<TravelMode, string> = {
  motorcycle: "mapbox/driving-traffic",
  car: "mapbox/driving-traffic",
  walking: "mapbox/walking",
};

export type Congestion = "unknown" | "low" | "moderate" | "heavy" | "severe";

export type LaneIndication =
  | "left" | "slight left" | "sharp left" | "straight"
  | "right" | "slight right" | "sharp right" | "uturn" | "none";

export interface Lane {
  /** this lane can be used to complete the step's maneuver */
  valid: boolean;
  /** Mapbox's pick of the single best lane for the maneuver, when it says so */
  active: boolean;
  indications: LaneIndication[];
  /** which of `indications` is the one matching the maneuver */
  validIndication: LaneIndication | null;
}

export interface RouteStep {
  /** distance of this step, meters */
  distanceM: number;
  durationS: number;
  /** raw Mapbox maneuver type, e.g. "turn", "arrive", "roundabout", "depart" */
  maneuverType: string;
  /** e.g. "left", "right", "slight left", "straight", "uturn" */
  modifier?: string;
  /** Mapbox's own localized instruction (language=zh-Hant) */
  instruction: string;
  /** road name for this step (the road you are on after the maneuver) */
  name: string;
  location: [number, number];
  /** heading immediately before / after the maneuver, compass degrees */
  bearingBefore: number;
  bearingAfter: number;
  /** turn lanes at this step's maneuver intersection, if Mapbox knows them */
  lanes: Lane[] | null;
  /** roundabout / rotary exit number */
  exit: number | null;
  /** Mapbox's recommended announce distances for the *next* maneuver,
   *  measured back from the end of this step (largest first) */
  voiceTriggersM: number[];
  geometry: GeoJSON.LineString;
}

export interface DirectionsRoute {
  geometry: GeoJSON.LineString;
  durationMin: number;
  durationS: number;
  distanceKm: number;
  distanceM: number;
  steps: RouteStep[];
  congestion: Congestion[];
  maxspeedKph: (number | null)[];
}

export interface RouteRequestOptions {
  /** heading of travel at the origin; keeps a reroute from telling the rider
   *  to U-turn back the way they came */
  originBearing?: number;
  waypoints?: { lng: number; lat: number }[];
  alternatives?: boolean;
}

export async function fetchRoutes(
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
  mode: TravelMode,
  token: string,
  opts: RouteRequestOptions = {}
): Promise<DirectionsRoute[]> {
  const profile = PROFILE_MAP[mode];
  const waypoints = opts.waypoints ?? [];
  const all = [origin, ...waypoints, destination];
  const coords = all.map((p) => `${p.lng},${p.lat}`).join(";");

  const params = new URLSearchParams({
    alternatives: String(opts.alternatives ?? true),
    geometries: "geojson",
    overview: "full",
    steps: "true",
    voice_instructions: "true",
    voice_units: "metric",
    roundabout_exits: "true",
    language: "zh-Hant",
    access_token: token,
  });
  if (mode !== "walking") params.set("annotations", "congestion,maxspeed");
  // detour waypoints are "pass near here", not "stop here": without this
  // Mapbox happily U-turns at the waypoint and drives back the same road
  if (waypoints.length) params.set("continue_straight", "true");
  if (opts.originBearing != null) {
    // one entry per coordinate; blanks mean "no constraint"
    params.set("bearings", [`${Math.round(opts.originBearing)},45`, ...all.slice(1).map(() => "")].join(";"));
  }

  const res = await fetch(`https://api.mapbox.com/directions/v5/${profile}/${coords}?${params}`);
  if (!res.ok) {
    throw new Error(`Mapbox Directions API error: ${res.status}`);
  }
  const data = await res.json();
  if (!data.routes || data.routes.length === 0) {
    throw new Error("No route found between these two points.");
  }
  return data.routes.map(parseRoute);
}

function parseRoute(r: any): DirectionsRoute {
  const legs = r.legs as any[];
  const congestion: Congestion[] = legs.flatMap((l) => (l.annotation?.congestion ?? []) as Congestion[]);
  const maxspeedKph: (number | null)[] = legs.flatMap((l) =>
    ((l.annotation?.maxspeed ?? []) as any[]).map((m) => {
      if (!m || m.unknown || m.none || typeof m.speed !== "number") return null;
      return m.unit === "mph" ? Math.round(m.speed * 1.609) : m.speed;
    })
  );
  return {
    geometry: r.geometry as GeoJSON.LineString,
    durationMin: Math.round(r.duration / 60),
    durationS: r.duration,
    distanceKm: Math.round((r.distance / 1000) * 10) / 10,
    distanceM: r.distance,
    congestion,
    maxspeedKph,
    steps: legs.flatMap((leg) => leg.steps.map(parseStep)),
  };
}

function parseStep(s: any): RouteStep {
  const lanesRaw = s.intersections?.[0]?.lanes as any[] | undefined;
  const lanes: Lane[] | null = lanesRaw?.length
    ? lanesRaw.map((l) => ({
        valid: !!l.valid,
        active: !!l.active,
        indications: (l.indications ?? []) as LaneIndication[],
        validIndication: (l.valid_indication as LaneIndication | undefined) ?? null,
      }))
    : null;
  return {
    distanceM: s.distance,
    durationS: s.duration,
    maneuverType: s.maneuver.type,
    modifier: s.maneuver.modifier,
    instruction: s.maneuver.instruction,
    name: s.name ?? "",
    location: s.maneuver.location,
    bearingBefore: s.maneuver.bearing_before ?? 0,
    bearingAfter: s.maneuver.bearing_after ?? 0,
    lanes,
    exit: typeof s.maneuver.exit === "number" ? s.maneuver.exit : null,
    voiceTriggersM: ((s.voiceInstructions ?? []) as any[])
      .map((v) => v.distanceAlongGeometry as number)
      .filter((d) => typeof d === "number")
      .sort((a, b) => b - a),
    geometry: s.geometry,
  };
}
