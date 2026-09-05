import { useEffect, useRef, useState } from "react";
import { Layers, Navigation2, Play, LocateFixed } from "lucide-react";
import MapView, { type ActiveLayers, type MapViewHandle, type RouteLabel } from "./components/MapView";
import along from "@turf/along";
import { feature } from "@turf/helpers";
import SearchBar from "./components/SearchBar";
import SearchSheet, { type Endpoint } from "./components/SearchSheet";
import Sheet from "./components/Sheet";
import RouteSheet from "./components/RouteSheet";
import HotspotSheet from "./components/HotspotSheet";
import LayersSheet from "./components/LayersSheet";
import Navigation, { type RerouteResult } from "./components/Navigation";
import { fetchRoutes, type DirectionsRoute } from "./lib/mapboxDirections";
import { generateDetourRoutes } from "./lib/alternativeRoute";
import { getCurrentPosition } from "./lib/geocode";
import { analyzeRoute } from "./lib/routeAnalysis";
import { annotateLeftTurns, type TwoStageContext } from "./lib/twoStageLeft";
import { GpsProvider, SimulatedProvider, type LocationProvider } from "./lib/location";
import { voice } from "./lib/voice";
import { DEMO_ORIGIN, DEMO_DESTINATION } from "./lib/demoData";
import { FIXTURE_ENABLED, buildFixtureRoute } from "./lib/devFixture";
import { MAPBOX_TOKEN, LAYER_SOURCES } from "./lib/config";
import type {
  HotspotProps, RouteOption, RouteOptionId, SurveyedIntersectionProps, TravelMode, WaitingZoneProps,
} from "./lib/types";
import "./app.css";

type SheetView = "none" | "search" | "route" | "hotspot" | "layers";
type ZoneCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps>;
type SurveyedCollection = GeoJSON.FeatureCollection<GeoJSON.Point, SurveyedIntersectionProps>;
type HotspotCollection = GeoJSON.FeatureCollection<GeoJSON.Point, HotspotProps>;
type Built = { option: RouteOption; hits: GeoJSON.Feature<GeoJSON.Point, HotspotProps>[] };

const EMPTY_ZONES: ZoneCollection = { type: "FeatureCollection", features: [] };
const EMPTY_SURVEYED: SurveyedCollection = { type: "FeatureCollection", features: [] };

const requiredCount = (o: RouteOption) => o.leftTurns.filter((l) => l.status === "required").length;
const hasUturn = (o: RouteOption) => o.steps.some((s) => s.modifier === "uturn");

/** Google-Maps-style callouts: 待轉區 at each box the route uses, 靠左 where
 *  a direct left is allowed, and the ETA at the route's midpoint while planning */
function labelsFor(route: RouteOption, withEta: boolean): RouteLabel[] {
  const out: RouteLabel[] = [];
  for (const lt of route.leftTurns) {
    if (lt.status === "required" && lt.zone) {
      out.push({ lng: lt.zone.properties.lon, lat: lt.zone.properties.lat, text: "待轉區", kind: "wait" });
    } else if (lt.status === "direct") {
      out.push({ lng: lt.location[0], lat: lt.location[1], text: "靠左", kind: "left" });
    }
  }
  if (withEta) {
    const mid = along(feature(route.geometry), route.distanceKm / 2, { units: "kilometers" });
    const [lng, lat] = mid.geometry.coordinates;
    out.push({ lng, lat, text: `${route.durationMin} 分鐘`, kind: "eta" });
  }
  return out;
}

export default function App() {
  const mapRef = useRef<MapViewHandle>(null);
  const hotspotCache = useRef<HotspotCollection[] | null>(null);
  // blue dot while planning (navigation runs its own provider)
  const planningWatch = useRef<GpsProvider | null>(null);

  const [layers, setLayers] = useState<ActiveLayers>({
    motorcycle: false,
    pedestrian: false,
    intersection: false,
    roadSegment: false,
    crosswalk: false,
    waitingZone: true,
    traffic: false,
    buildings3d: false,
  });

  const [mode, setMode] = useState<TravelMode>("motorcycle");
  const [sheet, setSheet] = useState<SheetView>("none");
  const [selectedHotspot, setSelectedHotspot] = useState<{ props: HotspotProps; layerKey: string } | null>(null);

  const [origin, setOrigin] = useState<Endpoint | null>(null);
  const [destination, setDestination] = useState<Endpoint | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [routes, setRoutes] = useState<{ fastest: RouteOption; avoidWaiting: RouteOption | null } | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<RouteOptionId>("fastest");
  const [routeHits, setRouteHits] = useState<Record<RouteOptionId, GeoJSON.Feature<GeoJSON.Point, HotspotProps>[]>>({
    fastest: [], avoidWaiting: [], alternative: [],
  });
  const [navigation, setNavigation] = useState<{ provider: LocationProvider; route: RouteOption; hits: Built["hits"] } | null>(null);
  const [freeLook, setFreeLook] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [zones, setZones] = useState<ZoneCollection>(EMPTY_ZONES);
  const [surveyed, setSurveyed] = useState<SurveyedCollection>(EMPTY_SURVEYED);

  // DieTurn output: 1,344 待轉格 polygons + the 2,556 intersections that were
  // photographed. Both are needed: the second one is what lets us say "no box
  // here, you may turn directly" instead of just "we don't know".
  useEffect(() => {
    fetch(LAYER_SOURCES.waitingZone)
      .then((r) => (r.ok ? r.json() : EMPTY_ZONES))
      .then((d: ZoneCollection) => setZones(d?.features ? d : EMPTY_ZONES))
      .catch(() => setZones(EMPTY_ZONES));
    fetch(LAYER_SOURCES.surveyedIntersections)
      .then((r) => (r.ok ? r.json() : EMPTY_SURVEYED))
      .then((d: SurveyedCollection) => setSurveyed(d?.features ? d : EMPTY_SURVEYED))
      .catch(() => setSurveyed(EMPTY_SURVEYED));
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
  }

  async function loadHotspotCollections(): Promise<HotspotCollection[]> {
    if (hotspotCache.current) return hotspotCache.current;
    const urls = [LAYER_SOURCES.intersection, LAYER_SOURCES.roadSegment, LAYER_SOURCES.motorcycle, LAYER_SOURCES.pedestrian];
    const results = (await Promise.all(urls.map((u) => fetch(u).then((r) => r.json())))) as HotspotCollection[];
    hotspotCache.current = results;
    return results;
  }

  function buildOption(r: DirectionsRoute, id: RouteOptionId, label: string, collections: HotspotCollection[], ctx: TwoStageContext): Built {
    const { stats, hitFeatures } = analyzeRoute(r.geometry, collections);
    const leftTurns = annotateLeftTurns(r, ctx);
    return {
      option: {
        id, label,
        durationMin: r.durationMin,
        distanceKm: r.distanceKm,
        geometry: r.geometry,
        steps: r.steps,
        stats,
        congestion: r.congestion,
        maxspeedKph: r.maxspeedKph,
        leftTurns,
        waitingZones: leftTurns.flatMap((l) => (l.zone ? [l.zone] : [])),
      },
      hits: hitFeatures,
    };
  }

  function startPlanningWatch() {
    if (planningWatch.current) return;
    const gps = new GpsProvider();
    planningWatch.current = gps;
    gps.start(
      (fix) => mapRef.current?.updatePuck(fix.lng, fix.lat, fix.headingDeg ?? 0, fix.accuracyM),
      () => {}
    );
  }

  function stopPlanningWatch() {
    planningWatch.current?.stop();
    planningWatch.current = null;
  }

  async function locateRider(opts: { quiet?: boolean } = {}): Promise<Endpoint | null> {
    try {
      const pos = await getCurrentPosition();
      const here: Endpoint = { label: "目前位置", ...pos, isCurrentLocation: true };
      setOrigin(here);
      mapRef.current?.updatePuck(pos.lng, pos.lat, 0, 30);
      mapRef.current?.flyTo(pos.lng, pos.lat, 16);
      startPlanningWatch();
      return here;
    } catch {
      if (!opts.quiet) showToast("無法取得目前位置，請改用搜尋設定起點");
      return null;
    }
  }

  // the origin defaults to where the rider is, like any navigation app;
  // if location is refused the origin simply stays empty and can be searched
  useEffect(() => {
    if (!mapReady) return;
    locateRider({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady]);

  async function planRoute(from: Endpoint, to: Endpoint, travelMode: TravelMode) {
    if (!MAPBOX_TOKEN) return;
    setLoading(true);
    setNavigation(null);
    setMode(travelMode);
    try {
      const collections = FIXTURE_ENABLED ? [] : await loadHotspotCollections();
      const ctx: TwoStageContext = { zones, surveyed };
      const fixture = FIXTURE_ENABLED ? buildFixtureRoute(zones, surveyed) : null;
      const candidates = fixture ? [fixture] : await fetchRoutes(from, to, travelMode, MAPBOX_TOKEN);

      const analyzed = candidates.map((r) => build(r, "fastest", "最快路線"));
      analyzed.sort((a, b) => a.option.durationMin - b.option.durationMin);
      const fastest = analyzed[0];

      // Second option. With two-stage lefts on the fastest route it is
      // "避開待轉": Mapbox's own alternatives plus detours pushed around each
      // required box, keeping whichever needs the fewest. Otherwise it is a
      // plain "替代路線" so the rider always has a choice, like Google Maps.
      let avoid: Built | null = null;
      const others = analyzed.slice(1);
      if (travelMode === "motorcycle" && !fixture && requiredCount(fastest.option) > 0) {
        const detours = await generateDetourRoutes(
          from, to, candidates[0],
          fastest.option.waitingZones.map((z) => [z.properties.lon, z.properties.lat] as [number, number]),
          travelMode, MAPBOX_TOKEN
        );
        // a U-turn is not a way to avoid a left turn; drop candidates that
        // "avoid" the box by looping back (unless the fastest route U-turns too)
        const pool = [...others, ...detours.map((r) => build(r, "avoidWaiting", "避開待轉"))]
          .filter((d) => !hasUturn(d.option) || hasUturn(fastest.option));
        const better = pool
          .filter((d) => requiredCount(d.option) < requiredCount(fastest.option))
          .sort((a, b) => requiredCount(a.option) - requiredCount(b.option) || a.option.durationMin - b.option.durationMin)[0];
        if (better) avoid = { ...better, option: { ...better.option, id: "avoidWaiting", label: "避開待轉" } };
      }
      if (!avoid && !fixture) {
        let alt: Built | undefined = others[0];
        if (!alt) {
          // Mapbox often returns a single route for short urban trips: push a
          // waypoint sideways at the midpoint to get a genuinely different one
          const mid = along(feature(fastest.option.geometry), fastest.option.distanceKm / 2, { units: "kilometers" });
          // push proportionally to trip length: 350 m sideways on a 1 km trip
          // only yields absurd loops
          const offsetM = Math.min(350, Math.max(100, fastest.option.distanceKm * 1000 * 0.2));
          const detours = await generateDetourRoutes(from, to, candidates[0], [mid.geometry.coordinates as [number, number]], travelMode, MAPBOX_TOKEN, offsetM);
          const base = new Set(fastest.option.geometry.coordinates.map((c) => c.join(",")));
          const overlap = (g: GeoJSON.LineString) => g.coordinates.filter((c) => base.has(c.join(","))).length / g.coordinates.length;
          alt = detours
            .map((r) => build(r, "alternative", "替代路線"))
            .filter((d) => (!hasUturn(d.option) || hasUturn(fastest.option)) && d.option.durationMin <= fastest.option.durationMin * 1.6 + 3 && overlap(d.option.geometry) < 0.85)
            .sort((a, b) => a.option.durationMin - b.option.durationMin)[0];
        }
        if (alt) avoid = { ...alt, option: { ...alt.option, id: "alternative", label: "替代路線" } };
      }

      setRoutes({ fastest: fastest.option, avoidWaiting: avoid?.option ?? null });
      setRouteHits({ fastest: fastest.hits, avoidWaiting: avoid?.hits ?? [], alternative: avoid?.hits ?? [] });
      // the normal route is the default; 避開待轉 is offered, not imposed
      setSelectedRoute("fastest");
      setSheet("route");
      showRoutes(fastest.option, avoid?.option ?? null, "fastest");

      function build(r: DirectionsRoute, id: RouteOptionId, label: string) {
        return buildOption(r, id, label, collections, ctx);
      }
    } catch (e) {
      console.error(e);
      showToast("目前無法取得路線，請稍後再試");
    } finally {
      setLoading(false);
    }
  }

  function showRoutes(fastest: RouteOption, avoid: RouteOption | null, selected: RouteOptionId) {
    const shown = selected !== "fastest" && avoid ? avoid : fastest;
    mapRef.current?.setRoutes(
      { geometry: fastest.geometry, congestion: fastest.congestion },
      avoid?.geometry ?? null,
      selected !== "fastest" && avoid ? "alt" : "fastest"
    );
    mapRef.current?.fitToBounds(shown.geometry.coordinates as [number, number][]);
    mapRef.current?.highlightWaitingZones(shown.waitingZones.map((z) => z.properties.id));
    mapRef.current?.setRouteLabels(labelsFor(shown, true));
  }

  function selectRoute(id: RouteOptionId) {
    if (!routes) return;
    setSelectedRoute(id);
    showRoutes(routes.fastest, routes.avoidWaiting, id);
  }

  const activeRoute =
    routes ? (selectedRoute !== "fastest" && routes.avoidWaiting ? routes.avoidWaiting : routes.fastest) : null;

  function startNavigation(kind: "gps" | "sim") {
    if (!activeRoute) return;
    // must happen inside the tap handler: mobile browsers only let speech
    // (and the first geolocation prompt) start from a user gesture
    voice.unlock();
    let provider: LocationProvider;
    if (kind === "gps") provider = new GpsProvider();
    else {
      const sim = new SimulatedProvider(activeRoute.geometry);
      sim.setPauses(activeRoute.leftTurns.flatMap((l) => (l.status === "required" && l.zoneEntryM != null ? [l.zoneEntryM] : [])));
      provider = sim;
    }
    stopPlanningWatch();
    setSheet("none");
    setFreeLook(false);
    setNavigation({ provider, route: activeRoute, hits: routeHits[selectedRoute] });
    mapRef.current?.setRouteLabels(labelsFor(activeRoute, false));
    mapRef.current?.setNavigation(true);
  }

  function endNavigation() {
    setNavigation(null);
    setFreeLook(false);
    mapRef.current?.setNavigation(false);
    mapRef.current?.clearPuck();
    mapRef.current?.setManeuverArrow(null, 0);
    if (origin?.isCurrentLocation) startPlanningWatch();
    if (routes) {
      showRoutes(routes.fastest, routes.avoidWaiting, selectedRoute);
      setSheet("route");
    }
  }

  async function handleReroute(from: { lng: number; lat: number }, bearing: number): Promise<RerouteResult | null> {
    if (!MAPBOX_TOKEN || !destination) return null;
    try {
      const collections = await loadHotspotCollections();
      const [r] = await fetchRoutes(from, destination, mode, MAPBOX_TOKEN, { originBearing: bearing, alternatives: false });
      return buildOption(r, "fastest", "最快路線", collections, { zones, surveyed });
    } catch {
      return null;
    }
  }

  function handleRouteReplaced(r: RerouteResult) {
    setRoutes({ fastest: r.option, avoidWaiting: null });
    setRouteHits({ fastest: r.hits, avoidWaiting: [], alternative: [] });
    setSelectedRoute("fastest");
    setNavigation((n) => (n ? { ...n, route: r.option, hits: r.hits } : n));
    mapRef.current?.setRoutes({ geometry: r.option.geometry, congestion: r.option.congestion }, null, "fastest");
    mapRef.current?.setRouteLabels(labelsFor(r.option, false));
  }

  async function runDemo() {
    // start from the rider's real position when we have it; the fixed
    // landmark is only the fallback for machines without location
    const here = origin?.isCurrentLocation ? origin : await locateRider({ quiet: true });
    const from: Endpoint = here ?? { label: DEMO_ORIGIN.name, lng: DEMO_ORIGIN.lng, lat: DEMO_ORIGIN.lat };
    const to: Endpoint = { label: DEMO_DESTINATION.name, lng: DEMO_DESTINATION.lng, lat: DEMO_DESTINATION.lat };
    setOrigin(from);
    setDestination(to);
    planRoute(from, to, "motorcycle");
  }

  const navigating = navigation != null;

  return (
    <div className="app-root">
      <MapView
        ref={mapRef}
        activeLayers={layers}
        suppressHotspots={navigating}
        onReady={() => setMapReady(true)}
        onFreeLook={setFreeLook}
        onHotspotClick={(props, layerKey) => {
          if (navigating) return;
          setSelectedHotspot({ props, layerKey });
          setSheet("hotspot");
        }}
      />

      {!navigating && (
        <div className="topbar">
          <div className="topbar-row">
            <div className="brand">
              <Navigation2 size={16} strokeWidth={2.4} />
              毋機道
            </div>
            <div className="topbar-actions">
              <button
                className={`icon-button ${sheet === "layers" ? "icon-button-active" : ""}`}
                onClick={() => setSheet(sheet === "layers" ? "none" : "layers")}
                aria-label="道路資訊"
              >
                <Layers size={19} strokeWidth={2} />
              </button>
              {!routes && (
                <button className="icon-button" disabled={(!mapReady && !FIXTURE_ENABLED) || loading} onClick={runDemo} aria-label="試用導航">
                  <Play size={18} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </div>
          <SearchBar onOpen={() => setSheet("search")} destinationLabel={destination?.label} />
        </div>
      )}

      {!navigating && sheet === "none" && (
        <button className="locate-button" aria-label="回到目前位置" onClick={() => locateRider()}>
          <LocateFixed size={20} strokeWidth={2} />
        </button>
      )}

      {sheet === "search" && (
        <Sheet title="規劃路線" onClose={() => setSheet("none")}>
          <SearchSheet
            mode={mode}
            onModeChange={setMode}
            origin={origin}
            destination={destination}
            onOriginChange={setOrigin}
            onDestinationChange={setDestination}
            onUseCurrentLocation={() => locateRider()}
            onSearch={() => origin && destination && planRoute(origin, destination, mode)}
            loading={loading}
          />
        </Sheet>
      )}

      {sheet === "route" && routes && (
        <Sheet onClose={() => setSheet("none")}>
          <RouteSheet
            destinationName={destination?.label ?? "目的地"}
            fastest={routes.fastest}
            avoidWaiting={routes.avoidWaiting}
            selected={selectedRoute}
            onSelect={selectRoute}
            onStart={() => startNavigation("gps")}
            onSimulate={() => startNavigation("sim")}
            mode={mode}
            onModeChange={(m) => {
              if (origin && destination) planRoute(origin, destination, m);
            }}
          />
        </Sheet>
      )}

      {sheet === "hotspot" && selectedHotspot && (
        <Sheet onClose={() => setSheet("none")}>
          <HotspotSheet hotspot={selectedHotspot.props} layerKey={selectedHotspot.layerKey} />
        </Sheet>
      )}

      {sheet === "layers" && (
        <Sheet title="道路資訊" onClose={() => setSheet("none")}>
          <LayersSheet layers={layers} onChange={setLayers} zoneCount={zones.features.length} />
        </Sheet>
      )}

      {navigation && (
        <Navigation
          key={navigation.provider.kind}
          route={navigation.route}
          hitFeatures={navigation.hits}
          provider={navigation.provider}
          map={mapRef}
          destinationName={destination?.label ?? "目的地"}
          freeLook={freeLook}
          onReroute={handleReroute}
          onRouteReplaced={handleRouteReplaced}
          onEnd={endNavigation}
        />
      )}

      {!mapReady && MAPBOX_TOKEN && <div className="map-loading">正在載入地圖…</div>}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
