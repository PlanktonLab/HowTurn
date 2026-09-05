export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

export const TAIPEI_CENTER: [number, number] = [121.53, 25.04];

// import.meta.env.BASE_URL reflects vite.config.ts's `base` (relative "./"),
// so these resolve correctly whether the app is served at a domain root or
// under a GitHub Pages project path (https://user.github.io/repo/).
const BASE = import.meta.env.BASE_URL;

export const LAYER_SOURCES = {
  intersection: `${BASE}geojson/taipei_intersection_hotspots.geojson`,
  roadSegment: `${BASE}geojson/taipei_road_segment_hotspots.geojson`,
  motorcycle: `${BASE}geojson/taipei_motorcycle_accident_hotspots.geojson`,
  pedestrian: `${BASE}geojson/taipei_pedestrian_accident_hotspots.geojson`,
  crosswalk: `${BASE}geojson/taipei_crosswalks.geojson`,
  // DieTurn output (geodata/export_app.py): 1,344 待轉格 polygons detected on
  // 2025 Taipei orthophotos, and the 2,556 intersections that were imaged so
  // the app can tell "surveyed, no box" from "never looked".
  waitingZone: `${BASE}geojson/taipei_waiting_zones.geojson`,
  surveyedIntersections: `${BASE}geojson/taipei_surveyed_intersections.geojson`,
} as const;

export type LayerKey = keyof typeof LAYER_SOURCES | "complexIntersection" | "difficultRoad";

// Layers RoadSense does not yet have real data for. Kept visible-but-disabled
// in the layer control so the UI is honest about current coverage instead of
// silently omitting the feature (see DATA_SOURCES.md).
export const NOT_YET_AVAILABLE: LayerKey[] = ["complexIntersection", "difficultRoad"];
