export type TravelMode = "motorcycle" | "car" | "walking";

export interface HotspotProps {
  hotspot_id: string;
  hotspot_type: "intersection" | "road_segment";
  county: string;
  township: string | null;
  road_or_intersection: string;
  accident_count: number;
  motorcycle_accident_count: number;
  motorcycle_accident_ratio: number;
  pedestrian_accident_count: number;
  pedestrian_accident_ratio: number;
  death_count: number;
  injury_count: number;
  fatal_accident_count: number;
  risk_score: number;
  risk_level: "low" | "medium" | "high" | "extreme";
  confidence: "confirmed" | "probable" | "low_confidence";
  source: string;
  motorcycle_risk_score?: number;
  pedestrian_risk_score?: number;
  major_axis_m?: number;
  aspect_ratio?: number;
}

/**
 * One 待轉格 detected by DieTurn (YOLO OBB on 2025 Taipei orthophotos).
 * Produced by geodata/export_app.py; the polygon is the box itself (~3×2 m).
 */
export interface WaitingZoneProps {
  id: string;
  status: "auto" | "review";
  conf: number;
  n_detections: number;
  /** long-axis compass bearing of the box, 0–180 (ambiguous by 180°) */
  heading_deg: number;
  length_m: number;
  width_m: number;
  corner: "NE" | "NW" | "SE" | "SW";
  intersection_id: string;
  intersection_dist_m: number;
  /** approach bearing of the rider this box serves (offline estimate) */
  serves_from_bearing: number;
  /** bearing the rider faces while waiting = direction of the target road */
  serves_to_bearing: number;
  serves_quality: "good" | "ambiguous";
  lat: number;
  lon: number;
  confidence: "confirmed" | "probable";
  source: string;
  source_updated_at: string;
}

/** An intersection DieTurn has orthophoto coverage for (2556 in Taipei). */
export interface SurveyedIntersectionProps {
  id: string;
  n_nodes: number;
}

export interface CrosswalkProps {
  id: string;
  county: string;
  city: string | null;
  road_name: string | null;
  intersection_name: string | null;
  facility_type: string;
  source: string;
  source_url: string;
  source_updated_at: string;
  confidence: string;
  status: string;
}

/**
 * required — a 待轉格 serving this exact approach exists: two-stage left turn.
 * direct   — the intersection was surveyed and no box serves this approach.
 * unknown  — outside DieTurn coverage; we refuse to promise a direct left.
 */
export type TwoStageStatus = "required" | "direct" | "unknown";

export interface LeftTurn {
  /** index into route.steps of the step whose maneuver is this left turn */
  stepIndex: number;
  status: TwoStageStatus;
  zone: GeoJSON.Feature<GeoJSON.Polygon, WaitingZoneProps> | null;
  /** maneuver location (the intersection node) */
  location: [number, number];
  approachBearing: number;
  exitBearing: number;
  /** distance along the route at which the maneuver happens */
  distanceAlongM: number;
  /** distance along the route of the point nearest the box (required only) */
  zoneEntryM: number | null;
  /** road being turned onto */
  roadName: string;
}

export type RouteOptionId = "fastest" | "avoidWaiting" | "alternative";

export interface RouteOption {
  id: RouteOptionId;
  label: string;
  durationMin: number;
  distanceKm: number;
  geometry: GeoJSON.LineString;
  stats: RouteRiskStats;
  steps: import("./mapboxDirections").RouteStep[];
  /** per-segment congestion (aligned with geometry.coordinates, length n-1) */
  congestion: import("./mapboxDirections").Congestion[];
  /** per-segment speed limit in km/h, null when unknown */
  maxspeedKph: (number | null)[];
  /** every left turn on the route, annotated with two-stage status */
  leftTurns: LeftTurn[];
  /** the 待轉格 polygons this route will actually use (status = required) */
  waitingZones: GeoJSON.Feature<GeoJSON.Polygon, WaitingZoneProps>[];
}

export interface RouteRiskStats {
  totalHotspots: number;
  highOrExtreme: number;
  extreme: number;
  motorcycleHotspots: number;
  pedestrianHotspots: number;
  deathsAlongRoute: number;
  injuriesAlongRoute: number;
  /** Sum of risk_score over hotspots the route passes — a route that goes
   *  through fewer *and* less severe locations scores lower. Used to rank
   *  candidate routes, since in dense Taipei almost every route passes some. */
  exposureScore: number;
}
