export const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

export const TAIPEI_CENTER: [number, number] = [121.53, 25.04];

// import.meta.env.BASE_URL reflects vite.config.ts's `base` (relative "./"),
// so these resolve correctly whether the app is served at a domain root or
// under a GitHub Pages project path (https://user.github.io/repo/).
const BASE = import.meta.env.BASE_URL;

export const LAYER_SOURCES = {
  crosswalk: `${BASE}geojson/taipei_crosswalks.geojson`,
  // DieTurn output (geodata/export_app.py): 10,303 待轉格 polygons over 30,045
  // imaged intersections nationwide, so the app can tell "surveyed, no box"
  // from "never looked". Two imagery sets are merged: Taipei on 都發局 z21
  // (6.8 cm/px) and the rest of Taiwan on NLSC z20 (13.5 cm/px). Each surveyed
  // point carries its set's measured recall, because the z20 half only recalls
  // ~52% of boxes — see docs/PHASE0_Z20.md and twoStageLeft.ts.
  waitingZone: `${BASE}geojson/taiwan_waiting_zones.geojson`,
  surveyedIntersections: `${BASE}geojson/taiwan_surveyed_intersections.geojson`,
} as const;
