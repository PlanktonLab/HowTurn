import { useEffect, useRef, useState } from "react";
import { Layers, Navigation2, Play, LocateFixed } from "lucide-react";
import MapView, { type ActiveLayers, type MapViewHandle, type RouteLabel } from "./components/MapView";
import along from "@turf/along";
import { feature } from "@turf/helpers";
import SearchBar, { type Endpoint } from "./components/SearchBar";
import Sheet from "./components/Sheet";
import RouteSheet from "./components/RouteSheet";
import LayersSheet from "./components/LayersSheet";
import Navigation, { type RerouteResult } from "./components/Navigation";
import { fetchRoutes } from "./lib/mapboxDirections";
import type { TwoStageContext } from "./lib/twoStageLeft";
import { buildRouteOption, planMotorcycleRoutes, type RoutePlan } from "./lib/routePlanner";
import { onAndroidBack } from "./lib/native";
import { getCurrentPosition } from "./lib/geocode";
import { GpsProvider, SimulatedProvider, type LocationProvider } from "./lib/location";
import { voice } from "./lib/voice";
import { DEMO_ORIGIN, DEMO_DESTINATION } from "./lib/demoData";
import { FIXTURE_ENABLED, buildFixtureRoute } from "./lib/devFixture";
import { MAPBOX_TOKEN, LAYER_SOURCES } from "./lib/config";
import type {
  RouteOption, RouteOptionId, SurveyedIntersectionProps, TravelMode, WaitingZoneProps,
} from "./lib/types";
import "./app.css";

type SheetView = "none" | "route" | "layers";
type ZoneCollection = GeoJSON.FeatureCollection<GeoJSON.Polygon, WaitingZoneProps>;
type SurveyedCollection = GeoJSON.FeatureCollection<GeoJSON.Point, SurveyedIntersectionProps>;

const EMPTY_ZONES: ZoneCollection = { type: "FeatureCollection", features: [] };
const EMPTY_SURVEYED: SurveyedCollection = { type: "FeatureCollection", features: [] };


/** Google-Maps-style callouts: 待轉區 at each box the route uses, 靠左 where
 *  a direct left is allowed, and the ETA at the route's midpoint while planning */
function labelsFor(route: RouteOption, withEta: boolean): RouteLabel[] {
  const out: RouteLabel[] = [];
  for (const lt of route.leftTurns) {
    if (lt.status === "required" && lt.zone) {
      out.push({ lng: lt.zone.properties.lon, lat: lt.zone.properties.lat, text: "待轉區", kind: "wait" });
    } else if (lt.status === "direct") {
      out.push({ lng: lt.location[0], lat: lt.location[1], text: "靠左", kind: "left" });
    } else if (lt.status === "unknown") {
      out.push({ lng: lt.location[0], lat: lt.location[1], text: "待轉待確認", kind: "unknown" });
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
  const planningRequest = useRef<AbortController | null>(null);
  const rerouteRequest = useRef<AbortController | null>(null);
  const navigationActive = useRef(false);
  const locationRequest = useRef(0);
  const selectedRouteRef = useRef<RouteOptionId>("fastest");
  const contextRequest = useRef<Promise<TwoStageContext> | null>(null);
  // blue dot while planning (navigation runs its own provider)
  const planningWatch = useRef<GpsProvider | null>(null);

  const [layers, setLayers] = useState<ActiveLayers>({
    crosswalk: false,
    waitingZone: true,
    traffic: false,
    buildings3d: false,
    nightLighting: false,
  });

  const mode: TravelMode = "motorcycle";
  const [sheet, setSheet] = useState<SheetView>("none");

  const [origin, setOrigin] = useState<Endpoint | null>(null);
  const [destination, setDestination] = useState<Endpoint | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [routes, setRoutes] = useState<{ fastest: RouteOption; avoidWaiting: RouteOption | null } | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<RouteOptionId>("fastest");
  const [navigation, setNavigation] = useState<{ provider: LocationProvider; route: RouteOption } | null>(null);
  const [freeLook, setFreeLook] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [zones, setZones] = useState<ZoneCollection>(EMPTY_ZONES);
  const [surveyed, setSurveyed] = useState<SurveyedCollection>(EMPTY_SURVEYED);

  // DieTurn output: 10,303 待轉格 polygons + the 30,045 intersections that were
  // photographed. Both are needed: the second one is what lets us say "no box
  // here, you may turn directly" instead of just "we don't know" — and it
  // carries each intersection's survey_recall, which decides which of those
  // two answers we are entitled to give (see twoStageLeft.ts).
  useEffect(() => {
    const controller = new AbortController();
    const read = async (url: string) => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error("Waiting zone data unavailable");
      const data = await response.json();
      if (data?.type !== "FeatureCollection" || !Array.isArray(data.features)) throw new Error("Invalid waiting zone data");
      return data;
    };
    contextRequest.current = Promise.all([read(LAYER_SOURCES.waitingZone), read(LAYER_SOURCES.surveyedIntersections)])
      .then(([loadedZones, loadedSurveyed]) => {
        if (!controller.signal.aborted) {
          setZones(loadedZones);
          setSurveyed(loadedSurveyed);
        }
        return { zones: loadedZones, surveyed: loadedSurveyed };
      }).catch(() => {
        // A survey without its matching boxes cannot prove a direct left.
        if (!controller.signal.aborted) { setZones(EMPTY_ZONES); setSurveyed(EMPTY_SURVEYED); }
        return { zones: EMPTY_ZONES, surveyed: EMPTY_SURVEYED };
      });
    return () => controller.abort();
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3200);
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
    const requestId = ++locationRequest.current;
    try {
      const pos = await getCurrentPosition();
      if (requestId !== locationRequest.current || navigationActive.current) return null;
      const here: Endpoint = { label: "現在的位置", ...pos, isCurrentLocation: true };
      mapRef.current?.updatePuck(pos.lng, pos.lat, 0, 30);
      mapRef.current?.flyTo(pos.lng, pos.lat, 16);
      startPlanningWatch();
      return here;
    } catch (error) {
      if (requestId !== locationRequest.current) return null;
      if (!opts.quiet) showToast(error instanceof Error ? error.message : "無法取得目前位置，請改用搜尋設定起點");
      return null;
    }
  }

  function cancelPlanning() {
    planningRequest.current?.abort();
    planningRequest.current = null;
    setLoading(false);
  }

  function editEndpoint(field: "origin" | "destination", endpoint: Endpoint | null) {
    cancelPlanning();
    setSheet("none");
    setRoutes(null);
    mapRef.current?.setRoutes(null, null, null);
    mapRef.current?.setRouteLabels([]);
    mapRef.current?.highlightWaitingZones([]);
    (field === "origin" ? setOrigin : setDestination)(endpoint);
    if (endpoint) mapRef.current?.flyTo(endpoint.lng, endpoint.lat, 16.5);
    if (field === "origin" && !endpoint?.isCurrentLocation) stopPlanningWatch();
  }

  function closeSheet() {
    locationRequest.current++;
    if (sheet === "route") {
      editEndpoint("destination", null);
      return;
    }
    cancelPlanning();
    setSheet("none");
  }

  async function planRoute(from: Endpoint, to: Endpoint) {
    cancelPlanning();
    if (!MAPBOX_TOKEN) {
      showToast("尚未設定地圖服務，暫時無法規劃路線");
      return;
    }
    const controller = new AbortController();
    planningRequest.current = controller;
    setLoading(true);
    selectedRouteRef.current = "fastest";
    setSelectedRoute("fastest");
    setNavigation(null);
    const publish = (plan: RoutePlan) => {
      if (controller.signal.aborted) return;
      setRoutes(plan);
      setSheet("route");
      showRoutes(plan.fastest, plan.avoidWaiting, selectedRouteRef.current);
    };
    try {
      const ctx = await contextRequest.current ?? { zones: EMPTY_ZONES, surveyed: EMPTY_SURVEYED };
      controller.signal.throwIfAborted();
      const fixture = FIXTURE_ENABLED ? buildFixtureRoute(ctx.zones, ctx.surveyed) : null;
      const plan = await planMotorcycleRoutes(from, to, MAPBOX_TOKEN, ctx, {
        signal: controller.signal,
        onPrimaryRoute: publish,
        initialRoutes: fixture ? [fixture] : undefined,
      });
      publish(plan);
    } catch (e) {
      if (!controller.signal.aborted) showToast(e instanceof Error ? e.message : "目前無法取得路線，請稍後再試");
    } finally {
      if (planningRequest.current === controller) {
        planningRequest.current = null;
        setLoading(false);
      }
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
    selectedRouteRef.current = id;
    setSelectedRoute(id);
    showRoutes(routes.fastest, routes.avoidWaiting, id);
  }

  const activeRoute =
    routes ? (selectedRoute !== "fastest" && routes.avoidWaiting ? routes.avoidWaiting : routes.fastest) : null;

  function startNavigation(kind: "gps" | "sim", chosenRoute = activeRoute) {
    const activeRoute = chosenRoute;
    if (!activeRoute) return;
    cancelPlanning();
    // must happen inside the tap handler: mobile browsers only let speech
    // (and the first geolocation prompt) start from a user gesture
    voice.unlock();
    navigationActive.current = true;
    locationRequest.current++;
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
    setNavigation({ provider, route: activeRoute });
    mapRef.current?.setRouteLabels(labelsFor(activeRoute, false));
    mapRef.current?.setNavigation(true);
  }

  function endNavigation() {
    navigationActive.current = false;
    rerouteRequest.current?.abort();
    voice.stop();
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
    if (!MAPBOX_TOKEN || !destination || !navigationActive.current) return null;
    rerouteRequest.current?.abort();
    const controller = new AbortController();
    rerouteRequest.current = controller;
    try {
      const [r] = await fetchRoutes(from, destination, mode, MAPBOX_TOKEN, { originBearing: bearing, alternatives: false, signal: controller.signal });
      if (controller.signal.aborted || !navigationActive.current) return null;
      return { option: buildRouteOption(r, { zones, surveyed }) };
    } catch {
      return null;
    }
  }

  function handleRouteReplaced(r: RerouteResult) {
    if (!navigationActive.current) return;
    selectedRouteRef.current = "fastest";
    setRoutes({ fastest: r.option, avoidWaiting: null });
    setSelectedRoute("fastest");
    setNavigation((n) => (n ? { ...n, route: r.option } : n));
    mapRef.current?.setRoutes({ geometry: r.option.geometry, congestion: r.option.congestion }, null, "fastest");
    mapRef.current?.setRouteLabels(labelsFor(r.option, false));
  }

  async function runDemo() {
    const from: Endpoint = { label: DEMO_ORIGIN.name, lng: DEMO_ORIGIN.lng, lat: DEMO_ORIGIN.lat };
    const to: Endpoint = { label: DEMO_DESTINATION.name, lng: DEMO_DESTINATION.lng, lat: DEMO_DESTINATION.lat };
    setOrigin(from);
    setDestination(to);
    void planRoute(from, to);
  }

  useEffect(() => () => {
    planningRequest.current?.abort();
    rerouteRequest.current?.abort();
    planningWatch.current?.stop();
  }, []);

  useEffect(() => onAndroidBack(() => {
    if (sheet !== "none") { closeSheet(); return true; }
    if (navigation) { endNavigation(); return true; }
    return false;
  }));

  const navigating = navigation != null;

  return (
    <div className="app-root">
      <MapView
        ref={mapRef}
        activeLayers={layers}
        onReady={() => setMapReady(true)}
        onFreeLook={setFreeLook}
      />

      {!navigating && (
        <div className="topbar">
          <div className="topbar-row">
            <div className="brand">
              <Navigation2 size={16} strokeWidth={2.4} />
              HowTurn
            </div>
            <div className="topbar-actions">
              <button
                className={`icon-button ${sheet === "layers" ? "icon-button-active" : ""}`}
                onClick={() => { cancelPlanning(); setSheet(sheet === "layers" ? "none" : "layers"); }}
                aria-label="道路資訊"
              >
                <Layers size={19} strokeWidth={2} />
              </button>
              {FIXTURE_ENABLED && !routes && (
                <button className="icon-button" disabled={(!mapReady && !FIXTURE_ENABLED) || loading} onClick={runDemo} aria-label="試用導航">
                  <Play size={18} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </div>
          <SearchBar
            origin={origin}
            destination={destination}
            onOriginChange={(endpoint) => editEndpoint("origin", endpoint)}
            onDestinationChange={(endpoint) => editEndpoint("destination", endpoint)}
            onUseCurrentLocation={() => locateRider()}
            onPlan={(from, to) => void planRoute(from, to)}
            planning={loading}
          />
        </div>
      )}

      {!navigating && sheet === "none" && !(origin && !origin.isCurrentLocation && !destination) && (
        <button className="locate-button" aria-label="回到目前位置" onClick={() => locateRider()}>
          <LocateFixed size={20} strokeWidth={2} />
        </button>
      )}

      {sheet === "route" && routes && (
        <Sheet onClose={closeSheet} variant="route">
          <RouteSheet
            destinationName={destination?.label ?? "目的地"}
            fastest={routes.fastest}
            avoidWaiting={routes.avoidWaiting}
            selected={selectedRoute}
            onSelect={selectRoute}
            onStart={() => startNavigation("gps")}
            onSimulate={FIXTURE_ENABLED ? () => startNavigation("sim") : undefined}
            onClose={closeSheet}
            findingAlternative={loading}
          />
        </Sheet>
      )}


      {sheet === "layers" && (
        <Sheet title="道路資訊" onClose={closeSheet}>
          <LayersSheet layers={layers} onChange={setLayers} zoneCount={zones.features.length} />
        </Sheet>
      )}

      {navigation && (
        <Navigation
          key={navigation.provider.kind}
          route={navigation.route}
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
