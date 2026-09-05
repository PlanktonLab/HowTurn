import { useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import lineSliceAlong from "@turf/line-slice-along";
import turfBearing from "@turf/bearing";
import { feature, point } from "@turf/helpers";
import { MAPBOX_TOKEN, TAIPEI_CENTER, LAYER_SOURCES } from "../lib/config";
import type { Congestion } from "../lib/mapboxDirections";
import type { HotspotProps } from "../lib/types";

if (MAPBOX_TOKEN) {
  mapboxgl.accessToken = MAPBOX_TOKEN;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Expr = any;

const STYLE_PLANNING = "mapbox://styles/mapbox/streets-v12";
const STYLE_NAV_DAY = "mapbox://styles/mapbox/navigation-day-v1";
const STYLE_NAV_NIGHT = "mapbox://styles/mapbox/navigation-night-v1";

const ROUTE_BLUE = "#0a7cff";
const ROUTE_TRAVELLED = "#a9afb8";

// Restrained palette: only genuinely high-risk locations get a strong colour,
// everything else stays quiet so the map does not read as a wall of red dots.
const RISK_COLOR: Expr = ["match", ["get", "risk_level"], "extreme", "#e5484d", "high", "#f0a020", "medium", "#9aa0a6", "#c3c7cb"];
const RISK_OPACITY: Expr = ["match", ["get", "risk_level"], "extreme", 0.9, "high", 0.8, "medium", 0.55, 0.4];

export interface ActiveLayers {
  intersection: boolean;
  roadSegment: boolean;
  motorcycle: boolean;
  pedestrian: boolean;
  crosswalk: boolean;
  waitingZone: boolean;
  traffic: boolean;
  buildings3d: boolean;
}

export type RouteLabelKind = "wait" | "left" | "eta";
export interface RouteLabel {
  lng: number;
  lat: number;
  text: string;
  kind: RouteLabelKind;
}

export interface MapViewHandle {
  flyTo: (lng: number, lat: number, zoom?: number) => void;
  /** Google-Maps-style callouts floating next to the route (待轉區 / 靠左 / ETA) */
  setRouteLabels: (labels: RouteLabel[]) => void;
  fitToBounds: (coords: [number, number][]) => void;
  setRoutes: (
    fastest: { geometry: GeoJSON.LineString; congestion: Congestion[] } | null,
    alt: GeoJSON.LineString | null,
    highlighted: "fastest" | "alt" | null
  ) => void;
  /** switch to the navigation style + camera; false restores the planning map */
  setNavigation: (on: boolean) => void;
  /** per-frame position of the rider */
  updatePuck: (lng: number, lat: number, bearing: number, accuracyM: number) => void;
  clearPuck: () => void;
  /** per-frame camera target; ignored while the user is free-looking */
  followCamera: (lng: number, lat: number, bearing: number, speedMps: number) => void;
  resumeFollow: () => void;
  /** grey out the travelled part of the route: 0..1 of route length */
  setRouteProgress: (fraction: number) => void;
  /** draw the turn arrow for the maneuver at this distance along the route */
  setManeuverArrow: (route: GeoJSON.LineString | null, alongM: number) => void;
  highlightWaitingZones: (ids: string[], activeId?: string | null) => void;
}

interface Props {
  activeLayers: ActiveLayers;
  onHotspotClick: (props: HotspotProps, layerKey: string) => void;
  onReady?: () => void;
  /** true while turn-by-turn navigation is active: hides the general hotspot
   *  clutter so only the route + relevant warnings are on screen */
  suppressHotspots?: boolean;
  /** the user grabbed the map during navigation (camera stops following) */
  onFreeLook?: (free: boolean) => void;
}

const POINT_LAYERS: { key: "roadSegment" | "intersection" | "pedestrian" | "motorcycle"; source: string; url: string }[] = [
  { key: "roadSegment", source: "src-road-segment", url: LAYER_SOURCES.roadSegment },
  { key: "intersection", source: "src-intersection", url: LAYER_SOURCES.intersection },
  { key: "pedestrian", source: "src-pedestrian", url: LAYER_SOURCES.pedestrian },
  { key: "motorcycle", source: "src-motorcycle", url: LAYER_SOURCES.motorcycle },
];

const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function isNight() {
  const h = new Date().getHours();
  return h < 6 || h >= 18;
}

/** px per metre at zoom z, latitude lat (Web Mercator) */
function pxPerMeter(z: number, lat: number) {
  return Math.pow(2, z) / (156543.03392 * Math.cos((lat * Math.PI) / 180));
}

function makePuckImage(): ImageData {
  // drawn at 2x; renders 64 css px with a 26 px body — about Google's size
  const size = 128;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const cx = size / 2, cy = size / 2;
  // heading cone
  const cone = ctx.createRadialGradient(cx, cy, 14, cx, cy, size / 2);
  cone.addColorStop(0, "rgba(10,124,255,0.55)");
  cone.addColorStop(1, "rgba(10,124,255,0)");
  ctx.fillStyle = cone;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, size / 2, (-90 - 34) * (Math.PI / 180), (-90 + 34) * (Math.PI / 180));
  ctx.closePath();
  ctx.fill();
  // body
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = ROUTE_BLUE;
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2);
  ctx.fill();
  // arrow inside
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(cx, cy - 13);
  ctx.lineTo(cx + 9, cy + 8);
  ctx.lineTo(cx, cy + 3);
  ctx.lineTo(cx - 9, cy + 8);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function makeArrowHeadImage(): ImageData {
  const size = 40;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.lineJoin = "round";
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "#ffffff";
  const tri = () => {
    ctx.beginPath();
    ctx.moveTo(20, 4);
    ctx.lineTo(36, 30);
    ctx.lineTo(20, 22);
    ctx.lineTo(4, 30);
    ctx.closePath();
  };
  tri();
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = "#1b1e23";
  ctx.lineWidth = 0;
  tri();
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

function makeZonePinImage(): ImageData {
  const size = 28;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(14, 14, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f0a020";
  ctx.beginPath();
  ctx.arc(14, 14, 6.5, 0, Math.PI * 2);
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

const WAIT_ORANGE = "#f97316";
const LABEL_STYLE: Record<RouteLabelKind, { bg: string; color: string }> = {
  wait: { bg: WAIT_ORANGE, color: "#ffffff" },
  left: { bg: "#30d158", color: "#05200f" },
  eta: { bg: "#111214", color: "#ffffff" },
};

/** icon-only 待轉 marker: orange rounded square, white two-stage-left glyph, tail */
function makeWaitMarkerImage(): ImageData {
  const w = 44, h = 54, r = 12, tail = 8, s = 2;
  const c = document.createElement("canvas");
  c.width = w * s;
  c.height = h * s;
  const ctx = c.getContext("2d")!;
  ctx.scale(s, s);
  ctx.shadowColor = "rgba(0,0,0,0.28)";
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.roundRect(1, 1, w - 2, h - tail - 2, r + 2);
  ctx.moveTo(w / 2 - 7, h - tail - 1);
  ctx.lineTo(w / 2, h - 1);
  ctx.lineTo(w / 2 + 7, h - tail - 1);
  ctx.closePath();
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = WAIT_ORANGE;
  ctx.beginPath();
  ctx.roundRect(4, 4, w - 8, h - tail - 8, r);
  ctx.fill();
  // glyph (SF Symbol style, solid round strokes): an arrow pointing left on
  // top, and below it a slightly tilted arrow pointing up — "go straight,
  // then turn left", the two stages of the turn
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // upper: ← (shaft + open chevron)
  ctx.beginPath();
  ctx.moveTo(34, 15);
  ctx.lineTo(11.5, 15);
  ctx.moveTo(18.5, 8);
  ctx.lineTo(11.5, 15);
  ctx.lineTo(18.5, 22);
  ctx.stroke();
  // lower: ↑ leaning a little to the right, chevron head at the tip
  ctx.beginPath();
  ctx.moveTo(23, 40);
  ctx.lineTo(29, 22);
  ctx.moveTo(21.5, 27.5);
  ctx.lineTo(29, 22);
  ctx.lineTo(31.8, 30.8);
  ctx.stroke();
  return ctx.getImageData(0, 0, w * s, h * s);
}

/** rounded callout with a small tail, stretchable so icon-text-fit can grow it */
function makeLabelImage(bg: string): { data: ImageData; opts: { pixelRatio: number; stretchX: [number, number][]; stretchY: [number, number][]; content: [number, number, number, number] } } {
  const w = 60, h = 44, r = 9, tail = 8;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.shadowColor = "rgba(0,0,0,0.25)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.moveTo(r, 2);
  ctx.lineTo(w - r, 2);
  ctx.quadraticCurveTo(w - 2, 2, w - 2, r + 2);
  ctx.lineTo(w - 2, h - tail - r);
  ctx.quadraticCurveTo(w - 2, h - tail, w - r - 2, h - tail);
  ctx.lineTo(w / 2 + 6, h - tail);
  ctx.lineTo(w / 2, h - 1);
  ctx.lineTo(w / 2 - 6, h - tail);
  ctx.lineTo(r + 2, h - tail);
  ctx.quadraticCurveTo(2, h - tail, 2, h - tail - r);
  ctx.lineTo(2, r + 2);
  ctx.quadraticCurveTo(2, 2, r, 2);
  ctx.closePath();
  ctx.fill();
  return {
    data: ctx.getImageData(0, 0, w, h),
    opts: {
      pixelRatio: 2,
      stretchX: [[r + 4, w / 2 - 8], [w / 2 + 8, w - r - 4]],
      stretchY: [[r + 4, h - tail - r - 2]],
      content: [r + 2, 6, w - r - 2, h - tail - 4],
    },
  };
}

/** line-gradient: travelled part grey, the rest solid blue (no traffic
 *  colouring — it made the navigation view busy) */
function buildGradient(coords: number[][], progress: number, lat: number): Expr {
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const segLen: number[] = [];
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot((coords[i][0] - coords[i - 1][0]) * mLon, (coords[i][1] - coords[i - 1][1]) * 110_574);
    segLen.push(d);
    total += d;
  }
  if (total === 0) return ROUTE_BLUE;
  const stops: (number | string)[] = [];
  let acc = 0;
  let lastColor: string | null = null;
  const push = (frac: number, color: string) => {
    if (color === lastColor) return;
    const f = Math.min(1, Math.max(0, frac));
    if (stops.length && (stops[stops.length - 2] as number) >= f) return;
    stops.push(f, color);
    lastColor = color;
  };
  for (let i = 0; i < segLen.length; i++) {
    const start = acc / total;
    const end = (acc + segLen[i]) / total;
    const color = ROUTE_BLUE;
    if (end <= progress) push(start, ROUTE_TRAVELLED);
    else if (start < progress) {
      push(start, ROUTE_TRAVELLED);
      push(progress, color);
    } else push(start, color);
    acc += segLen[i];
  }
  if (stops.length === 0) return ROUTE_BLUE;
  const first = stops[1] as string;
  // a "step" expression needs at least one stop pair; a single colour is
  // just that colour
  if (stops.length === 2) return first;
  const expr: Expr = ["step", ["line-progress"], first];
  for (let i = 2; i < stops.length; i += 2) expr.push(stops[i], stops[i + 1]);
  return expr;
}

const MapView = forwardRef<MapViewHandle, Props>(
  ({ activeLayers, onHotspotClick, onReady, suppressHotspots, onFreeLook }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const styleReady = useRef(false);
    const readyFired = useRef(false);
    const layersRef = useRef(activeLayers);
    layersRef.current = activeLayers;
    const suppressRef = useRef(suppressHotspots);
    suppressRef.current = suppressHotspots;
    const onHotspotClickRef = useRef(onHotspotClick);
    onHotspotClickRef.current = onHotspotClick;
    const onFreeLookRef = useRef(onFreeLook);
    onFreeLookRef.current = onFreeLook;

    // everything the style needs to be rebuilt from after a setStyle()
    const state = useRef({
      navigating: false,
      following: true,
      routeMain: null as { geometry: GeoJSON.LineString; congestion: Congestion[] } | null,
      routeAlt: null as GeoJSON.LineString | null,
      progress: 0,
      puck: null as { lng: number; lat: number; bearing: number; acc: number } | null,
      arrow: null as { line: GeoJSON.LineString; head: [number, number]; bearing: number } | null,
      highlighted: [] as string[],
      activeZone: null as string | null,
      labels: [] as RouteLabel[],
      cam: { zoom: 17.5, pitch: 60, bearing: 0 },
      lastGradientAt: 0,
    });

    // ---------- (re)building layers on top of whatever style is loaded ----------
    const ensureAll = () => {
      const map = mapRef.current;
      // called from `style.load`: the style JSON is in, sources may still be
      // fetching, and isStyleLoaded() is false — adding layers is fine here
      if (!map || !map.getStyle()) return;
      const s = state.current;
      const lat = map.getCenter().lat;

      if (!map.hasImage("puck")) map.addImage("puck", makePuckImage(), { pixelRatio: 2 });
      if (!map.hasImage("arrow-head")) map.addImage("arrow-head", makeArrowHeadImage(), { pixelRatio: 2 });
      if (!map.hasImage("zone-pin")) map.addImage("zone-pin", makeZonePinImage(), { pixelRatio: 2 });
      for (const kind of ["left", "eta"] as RouteLabelKind[]) {
        if (!map.hasImage(`label-${kind}`)) {
          const img = makeLabelImage(LABEL_STYLE[kind].bg);
          map.addImage(`label-${kind}`, img.data, img.opts);
        }
      }
      if (!map.hasImage("marker-wait")) map.addImage("marker-wait", makeWaitMarkerImage(), { pixelRatio: 2 });

      // insert below the first *label* layer so route/puck sit above roads but
      // under street names. (The navigation styles have icon-only symbol
      // layers before the roads; anchoring on those hid everything.)
      const firstSymbol = map
        .getStyle()
        ?.layers?.find((l) => l.type === "symbol" && (l as { layout?: Record<string, unknown> }).layout?.["text-field"] != null)?.id;

      // 3D buildings: only meaningful with pitch; toggled by layer + nav state
      if (!map.getLayer("buildings-3d") && map.getSource("composite")) {
        map.addLayer(
          {
            id: "buildings-3d",
            type: "fill-extrusion",
            source: "composite",
            "source-layer": "building",
            filter: ["==", ["get", "extrude"], "true"],
            minzoom: 14.5,
            paint: {
              "fill-extrusion-color": s.navigating && isNight() ? "#2b303a" : "#dfe2e8",
              "fill-extrusion-height": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 16, ["get", "height"]],
              "fill-extrusion-base": ["interpolate", ["linear"], ["zoom"], 14.5, 0, 16, ["get", "min_height"]],
              "fill-extrusion-opacity": 0.75,
            },
          },
          firstSymbol
        );
      }

      // live traffic on the planning style (the navigation styles ship with it)
      if (!map.getSource("mapbox-traffic")) {
        map.addSource("mapbox-traffic", { type: "vector", url: "mapbox://mapbox.mapbox-traffic-v1" });
      }
      if (!map.getLayer("traffic-line")) {
        map.addLayer(
          {
            id: "traffic-line",
            type: "line",
            source: "mapbox-traffic",
            "source-layer": "traffic",
            minzoom: 11,
            layout: { "line-cap": "round", "line-join": "round", visibility: "none" },
            paint: {
              "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 1, 16, 4, 20, 10],
              "line-color": ["match", ["get", "congestion"], "low", "#22c55e", "moderate", "#f59e0b", "heavy", "#ef4444", "severe", "#991b1b", "#9aa0a6"],
              "line-opacity": 0.8,
              "line-offset": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 0.5, 16, 3, 20, 7],
            },
          },
          firstSymbol
        );
      }

      // routes
      if (!map.getSource("route-alt")) map.addSource("route-alt", { type: "geojson", data: EMPTY_FC });
      if (!map.getSource("route-main")) map.addSource("route-main", { type: "geojson", data: EMPTY_FC, lineMetrics: true });
      if (!map.getLayer("route-alt-casing")) {
        map.addLayer({ id: "route-alt-casing", type: "line", source: "route-alt", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 9, 17, 13, 20, 20], "line-opacity": 0.9 } }, firstSymbol);
        map.addLayer({ id: "route-alt-line", type: "line", source: "route-alt", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#b0b6bd", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 5, 17, 8, 20, 13] } }, firstSymbol);
      }
      if (!map.getLayer("route-main-casing")) {
        map.addLayer({ id: "route-main-casing", type: "line", source: "route-main", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 11, 17, 17, 20, 26] } }, firstSymbol);
        map.addLayer({ id: "route-main-line", type: "line", source: "route-main", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ROUTE_BLUE, "line-width": ["interpolate", ["linear"], ["zoom"], 12, 7, 17, 11, 20, 18] } }, firstSymbol);
      }

      // maneuver arrow
      if (!map.getSource("maneuver")) map.addSource("maneuver", { type: "geojson", data: EMPTY_FC });
      if (!map.getLayer("maneuver-casing")) {
        map.addLayer({ id: "maneuver-casing", type: "line", source: "maneuver", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 13 } }, firstSymbol);
        map.addLayer({ id: "maneuver-line", type: "line", source: "maneuver", filter: ["==", ["geometry-type"], "LineString"], layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": "#1b1e23", "line-width": 7 } }, firstSymbol);
        map.addLayer({
          id: "maneuver-head",
          type: "symbol",
          source: "maneuver",
          filter: ["==", ["geometry-type"], "Point"],
          layout: {
            "icon-image": "arrow-head",
            "icon-size": 0.9,
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "map",
            "icon-pitch-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
      }

      // waiting zones (待轉格): real polygons from DieTurn
      if (!map.getSource("src-waiting-zone")) {
        map.addSource("src-waiting-zone", { type: "geojson", data: LAYER_SOURCES.waitingZone, promoteId: "id" });
      }
      const hl = ["boolean", ["feature-state", "highlighted"], false];
      const act = ["boolean", ["feature-state", "active"], false];
      if (!map.getLayer("src-waiting-zone-fill")) {
        map.addLayer({
          id: "src-waiting-zone-fill",
          type: "fill",
          source: "src-waiting-zone",
          minzoom: 15,
          paint: {
            "fill-color": ["case", act, WAIT_ORANGE, "#f59e0b"],
            "fill-opacity": ["case", act, 0.85, hl, 0.6, 0.18],
          },
        });
        map.addLayer({
          id: "src-waiting-zone-outline",
          type: "line",
          source: "src-waiting-zone",
          minzoom: 15,
          paint: {
            "line-color": ["case", act, "#ffffff", "#b06f00"],
            "line-width": ["case", act, 3, hl, 2, 1],
          },
        });
        map.addLayer({
          id: "src-waiting-zone-pin",
          type: "symbol",
          source: "src-waiting-zone",
          maxzoom: 15,
          minzoom: 12.5,
          layout: { "icon-image": "zone-pin", "icon-size": ["interpolate", ["linear"], ["zoom"], 12.5, 0.5, 15, 0.9], "icon-allow-overlap": false, "symbol-placement": "point" },
          paint: { "icon-opacity": ["case", hl, 1, 0.75] },
        });
        map.addLayer({
          id: "src-waiting-zone-label",
          type: "symbol",
          source: "src-waiting-zone",
          minzoom: 16,
          layout: { "text-field": "待轉格", "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "symbol-placement": "point", "text-allow-overlap": true },
          // symbol layers reject feature-state in `filter`, so the highlight
          // is driven through paint opacity instead
          paint: {
            "text-color": "#7a4a00",
            "text-halo-color": "#fff",
            "text-halo-width": 1.4,
            "text-opacity": ["case", ["any", hl, act], 1, 0],
          },
        });
      }
      for (const id of s.highlighted) map.setFeatureState({ source: "src-waiting-zone", id }, { highlighted: true });
      if (s.activeZone) map.setFeatureState({ source: "src-waiting-zone", id: s.activeZone }, { active: true });

      // rider puck: accuracy ring in true metres + heading icon
      if (!map.getSource("puck")) map.addSource("puck", { type: "geojson", data: EMPTY_FC });
      if (!map.getLayer("puck-accuracy")) {
        map.addLayer({
          id: "puck-accuracy",
          type: "circle",
          source: "puck",
          paint: {
            "circle-radius": ["interpolate", ["exponential", 2], ["zoom"], 0, ["*", ["get", "acc"], pxPerMeter(0, lat)], 22, ["*", ["get", "acc"], pxPerMeter(22, lat)]],
            "circle-color": ROUTE_BLUE,
            "circle-opacity": 0.12,
            "circle-stroke-color": ROUTE_BLUE,
            "circle-stroke-opacity": 0.25,
            "circle-stroke-width": 1,
            "circle-pitch-alignment": "map",
          },
        });
        map.addLayer({
          id: "puck-icon",
          type: "symbol",
          source: "puck",
          layout: {
            "icon-image": "puck",
            "icon-size": 1,
            "icon-rotate": ["get", "bearing"],
            "icon-rotation-alignment": "map",
            "icon-pitch-alignment": "map",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
      }

      // route callouts, on top of everything (labels included)
      if (!map.getSource("route-labels")) map.addSource("route-labels", { type: "geojson", data: EMPTY_FC });
      if (!map.getLayer("route-labels-anchor")) {
        map.addLayer({
          id: "route-labels-anchor",
          type: "circle",
          source: "route-labels",
          paint: { "circle-radius": 4, "circle-color": ["get", "bg"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
        });
        map.addLayer({
          id: "route-labels-wait",
          type: "symbol",
          source: "route-labels",
          filter: ["==", ["get", "kind"], "wait"],
          layout: {
            "icon-image": "marker-wait",
            "icon-anchor": "bottom",
            "icon-allow-overlap": true,
            "icon-ignore-placement": true,
          },
        });
        map.addLayer({
          id: "route-labels",
          type: "symbol",
          source: "route-labels",
          filter: ["!=", ["get", "kind"], "wait"],
          layout: {
            "text-field": ["get", "text"],
            "text-size": 13,
            "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
            "text-max-width": 20,
            "icon-image": ["get", "icon"],
            "icon-text-fit": "both",
            "icon-text-fit-padding": [6, 10, 10, 10],
            "text-anchor": "bottom",
            "icon-anchor": "bottom",
            "text-offset": [0, -0.9],
            "text-allow-overlap": true,
            "icon-allow-overlap": true,
            "text-ignore-placement": true,
            "icon-ignore-placement": true,
            "symbol-sort-key": ["get", "sort"],
          },
          paint: { "text-color": ["get", "color"] },
        });
      }

      // restore data
      applyRoutes();
      applyPuck();
      applyArrow();
      applyLabels();
      syncLayers();
    };

    const applyLabels = () => {
      const map = mapRef.current;
      const s = state.current;
      if (!map || !map.getSource("route-labels")) return;
      const data: GeoJSON.FeatureCollection = {
        type: "FeatureCollection",
        features: s.labels.map((l, i) => ({
          type: "Feature",
          properties: { kind: l.kind, text: l.text, icon: `label-${l.kind}`, bg: LABEL_STYLE[l.kind].bg, color: LABEL_STYLE[l.kind].color, sort: l.kind === "wait" ? 0 : l.kind === "left" ? 1 : 2 + i },
          geometry: { type: "Point", coordinates: [l.lng, l.lat] },
        })),
      };
      (map.getSource("route-labels") as mapboxgl.GeoJSONSource).setData(data);
    };

    const applyRoutes = () => {
      const map = mapRef.current;
      const s = state.current;
      if (!map || !map.getSource("route-main")) return;
      const toFC = (g: GeoJSON.LineString | null): GeoJSON.FeatureCollection =>
        g ? { type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: g }] } : EMPTY_FC;
      (map.getSource("route-main") as mapboxgl.GeoJSONSource).setData(toFC(s.routeMain?.geometry ?? null));
      (map.getSource("route-alt") as mapboxgl.GeoJSONSource).setData(toFC(s.routeAlt));
      applyGradient(true);
    };

    const applyGradient = (force = false) => {
      const map = mapRef.current;
      const s = state.current;
      if (!map || !map.getLayer("route-main-line")) return;
      const now = performance.now();
      if (!force && now - s.lastGradientAt < 250) return;
      s.lastGradientAt = now;
      if (!s.routeMain) return;
      const lat = s.routeMain.geometry.coordinates[0]?.[1] ?? map.getCenter().lat;
      map.setPaintProperty("route-main-line", "line-gradient", buildGradient(s.routeMain.geometry.coordinates, s.progress, lat));
    };

    const applyPuck = () => {
      const map = mapRef.current;
      const s = state.current;
      if (!map || !map.getSource("puck")) return;
      const data: GeoJSON.FeatureCollection = s.puck
        ? { type: "FeatureCollection", features: [{ type: "Feature", properties: { bearing: s.puck.bearing, acc: s.puck.acc }, geometry: { type: "Point", coordinates: [s.puck.lng, s.puck.lat] } }] }
        : EMPTY_FC;
      (map.getSource("puck") as mapboxgl.GeoJSONSource).setData(data);
    };

    const applyArrow = () => {
      const map = mapRef.current;
      const s = state.current;
      if (!map || !map.getSource("maneuver")) return;
      const data: GeoJSON.FeatureCollection = s.arrow
        ? {
            type: "FeatureCollection",
            features: [
              { type: "Feature", properties: {}, geometry: s.arrow.line },
              { type: "Feature", properties: { bearing: s.arrow.bearing }, geometry: { type: "Point", coordinates: s.arrow.head } },
            ],
          }
        : EMPTY_FC;
      (map.getSource("maneuver") as mapboxgl.GeoJSONSource).setData(data);
    };

    const addPointLayer = (key: (typeof POINT_LAYERS)[number]["key"]) => {
      const map = mapRef.current;
      const entry = POINT_LAYERS.find((l) => l.key === key);
      if (!map || !entry) return;
      if (!map.getSource(entry.source)) map.addSource(entry.source, { type: "geojson", data: entry.url });
      if (map.getLayer(`${entry.source}-circle`)) return;

      const circlePaint: Expr = {
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          12, ["interpolate", ["linear"], ["get", "accident_count"], 3, 2, 30, 5],
          16, ["interpolate", ["linear"], ["get", "accident_count"], 3, 5, 30, 13],
        ],
        "circle-color": RISK_COLOR,
        "circle-opacity": RISK_OPACITY,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 0, 15, 1.2],
        "circle-stroke-color": "#ffffff",
      };
      // Two layers per source: only genuinely dangerous locations show at
      // city zoom (so the map doesn't read as a wall of red); the quieter
      // ones appear once you zoom into a neighbourhood.
      const variants: { id: string; minzoom: number; filter: Expr }[] = [
        { id: `${entry.source}-circle`, minzoom: 12, filter: ["match", ["get", "risk_level"], ["extreme", "high"], true, false] },
        { id: `${entry.source}-circle-minor`, minzoom: 14.5, filter: ["match", ["get", "risk_level"], ["extreme", "high"], false, true] },
      ];
      for (const v of variants) {
        map.addLayer({ id: v.id, type: "circle", source: entry.source, minzoom: v.minzoom, filter: v.filter, paint: circlePaint });
        map.on("click", v.id, (e) => {
          const f = e.features?.[0];
          if (f) onHotspotClickRef.current(f.properties as HotspotProps, key);
        });
        map.on("mouseenter", v.id, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", v.id, () => (map.getCanvas().style.cursor = ""));
      }
    };

    const addCrosswalkLayer = () => {
      const map = mapRef.current;
      if (!map || map.getLayer("src-crosswalk-circle")) return;
      if (!map.getSource("src-crosswalk")) map.addSource("src-crosswalk", { type: "geojson", data: LAYER_SOURCES.crosswalk });
      map.addLayer({ id: "src-crosswalk-circle", type: "circle", source: "src-crosswalk", minzoom: 14, paint: { "circle-radius": 3, "circle-color": "#4b5563", "circle-opacity": 0.65 } });
    };

    const setVisible = (id: string, visible: boolean) => {
      const map = mapRef.current;
      if (map?.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    };

    const syncLayers = () => {
      const map = mapRef.current;
      if (!map || !styleReady.current) return;
      const wanted = layersRef.current;
      const suppressed = !!suppressRef.current;
      const nav = state.current.navigating;
      for (const { key, source } of POINT_LAYERS) {
        const visible = wanted[key] && !suppressed;
        if (visible) addPointLayer(key);
        setVisible(`${source}-circle`, visible);
        setVisible(`${source}-circle-minor`, visible);
      }
      if (wanted.crosswalk && !suppressed) addCrosswalkLayer();
      setVisible("src-crosswalk-circle", wanted.crosswalk && !suppressed);
      // waiting zones stay on during navigation (that's the whole point)
      for (const id of ["src-waiting-zone-fill", "src-waiting-zone-outline", "src-waiting-zone-pin", "src-waiting-zone-label"]) {
        setVisible(id, wanted.waitingZone || nav);
      }
      // traffic only on the planning map, and only when switched on; the
      // navigation styles ship their own traffic layers, which we keep hidden
      // so the guidance view stays clean
      setVisible("traffic-line", wanted.traffic && !nav);
      for (const l of map.getStyle()?.layers ?? []) {
        if (l.id === "traffic-line") continue;
        const sl = (l as { "source-layer"?: string })["source-layer"];
        if (sl === "traffic" || /^traffic/.test(l.id)) setVisible(l.id, false);
      }
      setVisible("buildings-3d", wanted.buildings3d || nav);
    };

    useImperativeHandle(ref, () => ({
      setRouteLabels: (labels) => {
        state.current.labels = labels;
        applyLabels();
      },
      flyTo: (lng, lat, zoom) => {
        mapRef.current?.flyTo({ center: [lng, lat], zoom, essential: true, duration: 1200 });
      },
      fitToBounds: (coords) => {
        if (!coords.length) return;
        const bounds = coords.reduce((b, c) => b.extend(c), new mapboxgl.LngLatBounds(coords[0], coords[0]));
        mapRef.current?.fitBounds(bounds, { padding: { top: 110, bottom: 320, left: 60, right: 60 }, duration: 900, pitch: 0, bearing: 0 });
      },
      setRoutes: (fastest, alt, highlighted) => {
        const s = state.current;
        if (highlighted === "alt" && alt) {
          s.routeMain = { geometry: alt, congestion: [] };
          s.routeAlt = fastest?.geometry ?? null;
        } else {
          s.routeMain = fastest;
          s.routeAlt = alt;
        }
        s.progress = 0;
        applyRoutes();
      },
      setNavigation: (on) => {
        const map = mapRef.current;
        const s = state.current;
        if (!map || s.navigating === on) return;
        s.navigating = on;
        s.following = true;
        styleReady.current = false;
        map.setStyle(on ? (isNight() ? STYLE_NAV_NIGHT : STYLE_NAV_DAY) : STYLE_PLANNING);
        if (!on) {
          s.puck = null;
          s.arrow = null;
          s.progress = 0;
          s.activeZone = null;
          map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
        }
      },
      updatePuck: (lng, lat, bearing, accuracyM) => {
        state.current.puck = { lng, lat, bearing, acc: accuracyM };
        applyPuck();
      },
      clearPuck: () => {
        state.current.puck = null;
        applyPuck();
      },
      followCamera: (lng, lat, bearing, speedMps) => {
        const map = mapRef.current;
        const s = state.current;
        if (!map || !s.following || !s.navigating) return;
        // faster → zoom out a little so there is more road ahead on screen
        const targetZoom = speedMps < 3 ? 18 : speedMps < 9 ? 17.6 : speedMps < 15 ? 17.1 : 16.6;
        s.cam.zoom += (targetZoom - s.cam.zoom) * 0.04;
        s.cam.pitch += (60 - s.cam.pitch) * 0.08;
        const h = map.getContainer().clientHeight;
        map.jumpTo({
          center: [lng, lat],
          bearing,
          pitch: s.cam.pitch,
          zoom: s.cam.zoom,
          // top padding pushes the focus point down: rider in the lower third,
          // road ahead filling the screen
          padding: { top: Math.round(h * 0.45), bottom: 0, left: 0, right: 0 },
        });
      },
      resumeFollow: () => {
        const s = state.current;
        s.following = true;
        onFreeLookRef.current?.(false);
      },
      setRouteProgress: (fraction) => {
        state.current.progress = Math.max(0, Math.min(1, fraction));
        applyGradient();
      },
      setManeuverArrow: (route, alongM) => {
        const s = state.current;
        if (!route) {
          s.arrow = null;
          applyArrow();
          return;
        }
        try {
          const line = feature(route);
          const startM = Math.max(0, alongM - 45);
          const slice = lineSliceAlong(line, startM / 1000, (alongM + 35) / 1000, { units: "kilometers" });
          const c = slice.geometry.coordinates;
          if (c.length < 2) {
            s.arrow = null;
          } else {
            const head = c[c.length - 1] as [number, number];
            const prev = c[c.length - 2] as [number, number];
            s.arrow = { line: slice.geometry, head, bearing: turfBearing(point(prev), point(head)) };
          }
        } catch {
          s.arrow = null;
        }
        applyArrow();
      },
      highlightWaitingZones: (ids, activeId = null) => {
        const map = mapRef.current;
        const s = state.current;
        const prev = s.highlighted;
        const prevActive = s.activeZone;
        s.highlighted = ids;
        s.activeZone = activeId;
        if (!map || !map.getSource("src-waiting-zone")) return;
        for (const id of prev) map.setFeatureState({ source: "src-waiting-zone", id }, { highlighted: false });
        if (prevActive) map.setFeatureState({ source: "src-waiting-zone", id: prevActive }, { active: false });
        for (const id of ids) map.setFeatureState({ source: "src-waiting-zone", id }, { highlighted: true });
        if (activeId) map.setFeatureState({ source: "src-waiting-zone", id: activeId }, { active: true });
      },
    }));

    useEffect(() => {
      if (!containerRef.current || mapRef.current || !MAPBOX_TOKEN) return;

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: STYLE_PLANNING,
        center: TAIPEI_CENTER,
        zoom: 13,
        attributionControl: false,
        // rotating the map with two fingers during navigation is wanted;
        // pitch via gesture we keep off so the camera stays predictable
        touchPitch: false,
      });
      mapRef.current = map;
      if (import.meta.env.DEV) (window as unknown as { map?: mapboxgl.Map }).map = map;
      map.on("error", (e) => console.error("Mapbox error:", e.error));
      map.addControl(new mapboxgl.AttributionControl({ compact: true }), "bottom-right");

      map.on("style.load", () => {
        styleReady.current = true;
        ensureAll();
        if (!readyFired.current) {
          readyFired.current = true;
          onReady?.();
        }
      });

      // any user gesture while navigating stops the camera from following
      const onUserGesture = (e: { originalEvent?: unknown } | Record<string, unknown>) => {
        const s = state.current;
        if (!s.navigating || !s.following || !(e as { originalEvent?: unknown }).originalEvent) return;
        s.following = false;
        onFreeLookRef.current?.(true);
      };
      for (const ev of ["dragstart", "rotatestart", "zoomstart", "wheel"] as const) {
        map.on(ev, onUserGesture as (e: unknown) => void);
      }

      return () => {
        map.remove();
        mapRef.current = null;
        styleReady.current = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      syncLayers();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeLayers, suppressHotspots]);

    if (!MAPBOX_TOKEN) {
      return (
        <div className="map-token-missing">
          <div className="t-section">需要 Mapbox access token</div>
          <p className="t-sec">
            複製 <code>.env.example</code> 為 <code>.env.local</code>，填入 token 後重新啟動。
          </p>
        </div>
      );
    }

    return <div ref={containerRef} className="map-container" />;
  }
);

export default MapView;
