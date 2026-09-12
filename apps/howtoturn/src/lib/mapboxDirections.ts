import type { TravelMode } from "./types";

// Mapbox has no motorcycle profile. Avoid motorways and ferries explicitly;
// other local motorcycle restrictions still require a dedicated routing source.
const MOTORCYCLE_PROFILE = "mapbox/driving-traffic";

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
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function fetchRoutes(
  origin: { lng: number; lat: number },
  destination: { lng: number; lat: number },
  mode: TravelMode,
  token: string,
  opts: RouteRequestOptions = {}
): Promise<DirectionsRoute[]> {
  if (mode !== "motorcycle") throw new Error("目前僅支援機車路線");
  if (!token.trim()) throw new Error("尚未設定地圖服務，無法規劃路線");
  opts.signal?.throwIfAborted();
  const profile = MOTORCYCLE_PROFILE;
  const waypoints = opts.waypoints ?? [];
  const all = [origin, ...waypoints, destination];
  if (all.some((p) => !validCoordinate([p.lng, p.lat]))) {
    throw new Error("起點或目的地的位置無效，請重新選擇");
  }
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
  params.set("annotations", "congestion,maxspeed");
  params.set("exclude", "motorway,ferry");
  // Do not silently snap a misplaced destination several kilometres away.
  params.set("radiuses", all.map(() => "100").join(";"));
  // detour waypoints are "pass near here", not "stop here": without this
  // Mapbox happily U-turns at the waypoint and drives back the same road
  if (waypoints.length) params.set("continue_straight", "true");
  if (opts.originBearing != null && Number.isFinite(opts.originBearing)) {
    // one entry per coordinate; blanks mean "no constraint"
    params.set("bearings", [`${Math.round((opts.originBearing % 360 + 360) % 360) % 360},45`, ...all.slice(1).map(() => "")].join(";"));
  }

  const controller = new AbortController();
  const abort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), opts.timeoutMs ?? 12_000);
  try {
    const res = await fetch(`https://api.mapbox.com/directions/v5/${profile}/${coords}?${params}`, { signal: controller.signal });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) throw new Error("地圖服務金鑰無效或未授權，請檢查設定");
      if (res.status === 429) throw new Error("路線服務忙碌中，請稍後再試");
      throw new Error("路線服務暫時無法使用，請稍後再試");
    }
    const data = await res.json();
    opts.signal?.throwIfAborted();
    if (data.code === "NoSegment") throw new Error("選擇的位置附近沒有可行駛道路，請改選附近路口");
    if (data.code !== "Ok" || !Array.isArray(data.routes)) throw new Error("找不到可行駛路線，請調整起點或目的地");
    const routes = data.routes.filter(validRoute).map(parseRoute) as DirectionsRoute[];
    if (!routes.length) throw new Error("找不到有效的機車候選路線，請調整起點或目的地");
    return routes;
  } catch (error) {
    opts.signal?.throwIfAborted();
    if (controller.signal.aborted) throw new Error("路線搜尋逾時，請檢查網路後重試");
    if (error instanceof TypeError) throw new Error("無法連線至路線服務，請檢查網路後重試");
    throw error;
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", abort);
  }
}

function validCoordinate(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 &&
    Number.isFinite(value[0]) && Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

function validLine(value: any): boolean {
  return value?.type === "LineString" && Array.isArray(value.coordinates) &&
    value.coordinates.length >= 2 && value.coordinates.every(validCoordinate);
}

function validRoute(route: any): boolean {
  return Number.isFinite(route?.duration) && route.duration > 0 &&
    Number.isFinite(route.distance) && route.distance > 0 && validLine(route.geometry) &&
    Array.isArray(route.legs) && route.legs.length > 0 && route.legs.every((leg: any) =>
      Array.isArray(leg.steps) && leg.steps.length > 0 && leg.steps.every((step: any) =>
        validCoordinate(step?.maneuver?.location) && typeof step.maneuver.type === "string" &&
        Number.isFinite(step.distance) && step.distance >= 0 && Number.isFinite(step.duration) && step.duration >= 0 &&
        validLine(step.geometry) && !(step.intersections ?? []).some((intersection: any) =>
          (intersection.classes ?? []).some((roadClass: string) => roadClass === "motorway" || roadClass === "ferry")
        )
      )
    );
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
    durationMin: Math.max(1, Math.ceil(r.duration / 60)),
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
    instruction: s.maneuver.instruction ?? "",
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
