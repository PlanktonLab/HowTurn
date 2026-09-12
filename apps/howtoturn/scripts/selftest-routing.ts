import assert from "node:assert/strict";
import { fetchRoutes, type DirectionsRoute } from "../src/lib/mapboxDirections";
import { isReasonableAlternative, planMotorcycleRoutes, routesAreEquivalent } from "../src/lib/routePlanner";
import { generateDetourRoutes } from "../src/lib/alternativeRoute";
import type { TwoStageContext } from "../src/lib/twoStageLeft";

const origin = { lng: 121, lat: 25 };
const destination = { lng: 121.01, lat: 25 };
const ctx: TwoStageContext = {
  zones: { type: "FeatureCollection", features: [] },
  surveyed: { type: "FeatureCollection", features: [] },
};
function route(durationS = 180, distanceM = 1_000, coords = [[121, 25], [121.01, 25]]): DirectionsRoute {
  const geometry: GeoJSON.LineString = { type: "LineString", coordinates: coords };
  return {
    durationS, durationMin: Math.ceil(durationS / 60), distanceM, distanceKm: distanceM / 1_000,
    geometry, congestion: [], maxspeedKph: [],
    steps: [{
      distanceM, durationS, maneuverType: "depart", instruction: "出發", name: "測試路",
      location: coords[0] as [number, number], bearingBefore: 90, bearingAfter: 90,
      lanes: null, exit: null, voiceTriggersM: [], geometry,
    }],
  };
}
function raw(r: DirectionsRoute) {
  return {
    duration: r.durationS, distance: r.distanceM, geometry: r.geometry,
    legs: [{ steps: r.steps.map((s) => ({
      distance: s.distanceM, duration: s.durationS, geometry: s.geometry,
      maneuver: { location: s.location, type: s.maneuverType, modifier: s.modifier, bearing_before: s.bearingBefore, bearing_after: s.bearingAfter },
    })) }],
  };
}
let requests: URL[] = [];
const originalFetch = globalThis.fetch;
function mock(routes: DirectionsRoute[]) {
  requests = [];
  globalThis.fetch = async (input) => {
    requests.push(new URL(String(input)));
    return new Response(JSON.stringify({ code: "Ok", routes: routes.map(raw) }), { status: 200 });
  };
}
try {
  assert(routesAreEquivalent(route(), route(181, 1_000, [[121, 25], [121.004, 25], [121.01, 25]])), "vertex density must not create a new route");
  assert(!routesAreEquivalent(route(), route(200, 1_000, [[121, 25], [121.005, 25.002], [121.01, 25]])), "different roads remain distinct");
  assert(!isReasonableAlternative(route(400, 1_200), route()), "absurd time detours are rejected");
  assert(!isReasonableAlternative(route(190, 3_000), route()), "absurd distance detours are rejected");
  const uturn = route(190); uturn.steps[0].modifier = "uturn";
  assert(!isReasonableAlternative(uturn, route()), "an extra U-turn is not an improvement");
  mock([route(180), route(170)]);
  let primaryCount = 0;
  const plan = await planMotorcycleRoutes(origin, destination, "test", ctx, { onPrimaryRoute: () => primaryCount++ });
  assert.equal(plan.fastest.steps[0].durationS, 170, "sort exact seconds, not rounded minutes");
  assert.equal(plan.avoidWaiting, null, "do not force a second card or duplicate the route");
  assert.equal(primaryCount, 1);
  assert.equal(requests.length, 1, "no waits means no extra requests");
  assert.equal(requests[0].searchParams.get("exclude"), "motorway,ferry");
  assert.equal(requests[0].searchParams.get("radiuses"), "100;100");
  mock([route(), route(900, 1_500, [[121, 25], [121.005, 25.004], [121.01, 25]])]);
  assert.equal((await planMotorcycleRoutes(origin, destination, "test", ctx)).avoidWaiting, null);
  mock([route(), route(200, 1_200, [[121, 25], [121.005, 25.001], [121.01, 25]])]);
  const ordinaryAlternative = await planMotorcycleRoutes(origin, destination, "test", ctx);
  assert.equal(ordinaryAlternative.avoidWaiting, null, "a different road without fewer waits must fall back to the primary route");
  assert.equal(requests.length, 1);
  mock([route()]);
  await generateDetourRoutes(origin, destination, route(), [[121.005, 25], [121.006, 25], [121.007, 25]], "motorcycle", "test");
  assert.equal(requests.length, 2, "detour search has a fixed two-request budget");
  mock([route()]);
  await generateDetourRoutes(origin, destination, route(), [[121.00001, 25]], "motorcycle", "test");
  assert.equal(requests.length, 0, "do not create endpoint loops");
  const waitingCtx: TwoStageContext = {
    surveyed: ctx.surveyed,
    zones: { type: "FeatureCollection", features: [{
      type: "Feature", geometry: { type: "Polygon", coordinates: [[[121.0051, 25.0001], [121.0052, 25.0001], [121.0051, 25.0002], [121.0051, 25.0001]]] },
      properties: {
        id: "test-zone", status: "auto", conf: 1, n_detections: 1, heading_deg: 0,
        length_m: 3, width_m: 2, corner: "NE", intersection_id: "test-intersection", intersection_dist_m: 15,
        serves_from_bearing: 0, serves_to_bearing: 270, serves_quality: "good", lat: 25.0001, lon: 121.0051,
        confidence: "confirmed", source: "test", source_updated_at: "2026-01-01",
      },
    }] },
  };
  const needsWait = route();
  Object.assign(needsWait.steps[0], { maneuverType: "turn", modifier: "left", location: [121.005, 25], bearingBefore: 0, bearingAfter: 270 });
  const noWait = route(200, 1_200, [[121, 25], [121.005, 25.001], [121.01, 25]]);
  const uncertain = structuredClone(noWait);
  Object.assign(uncertain.steps[0], { maneuverType: "turn", modifier: "left", location: [121.006, 25.001], bearingBefore: 0, bearingAfter: 270 });
  const uncertainPlan = await planMotorcycleRoutes(origin, destination, "test", waitingCtx, { initialRoutes: [needsWait, uncertain] });
  assert.equal(uncertainPlan.fastest.waitingZones.length, 1);
  assert.equal(uncertainPlan.avoidWaiting, null, "unknown restrictions must not be advertised as fewer waits");
  const nativePlan = await planMotorcycleRoutes(origin, destination, "test", waitingCtx, { initialRoutes: [needsWait, noWait] });
  assert.equal(nativePlan.avoidWaiting?.id, "avoidWaiting");
  let phases = 0, detourCalls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "Ok", routes: [raw(detourCalls++ === 0 ? needsWait : noWait)] }));
  const improved = await planMotorcycleRoutes(origin, destination, "test", waitingCtx, { onPrimaryRoute: (primary) => {
    phases++;
    assert.equal(detourCalls, 1, "primary route is available before optional requests");
    assert.equal(primary.avoidWaiting, null);
  } });
  assert.equal(phases, 1);
  assert.equal(detourCalls, 3, "one primary plus two optional requests at most");
  assert.equal(improved.avoidWaiting?.id, "avoidWaiting");
  mock([route()]);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(fetchRoutes(origin, destination, "motorcycle", "test", { signal: aborted.signal }), { name: "AbortError" });
  assert.equal(requests.length, 0, "cancel before request");
  const midflight = new AbortController();
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
    midflight.abort();
  });
  await assert.rejects(fetchRoutes(origin, destination, "motorcycle", "test", { signal: midflight.signal }), { name: "AbortError" });
  const callbackAbort = new AbortController();
  await assert.rejects(planMotorcycleRoutes(origin, destination, "test", ctx, {
    initialRoutes: [route()], signal: callbackAbort.signal, onPrimaryRoute: () => callbackAbort.abort(),
  }), { name: "AbortError" });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "NoRoute", routes: [] }));
  await assert.rejects(fetchRoutes(origin, destination, "motorcycle", "test"), /找不到/);
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 100, duration: 50, geometry: { type: "LineString", coordinates: [] }, legs: [] }] }));
  await assert.rejects(fetchRoutes(origin, destination, "motorcycle", "test"), /有效/);
  const prohibited = raw(route());
  Object.assign(prohibited.legs[0].steps[0], { intersections: [{ classes: ["motorway"] }] });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "Ok", routes: [prohibited] }));
  await assert.rejects(fetchRoutes(origin, destination, "motorcycle", "test"), /有效/);
  await assert.rejects(fetchRoutes({ lng: NaN, lat: 25 }, destination, "motorcycle", "test"), /位置無效/);
  await assert.rejects(planMotorcycleRoutes(origin, origin, "test", ctx), /太接近/);
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
  });
  await assert.rejects(fetchRoutes(origin, destination, "motorcycle", "test", { timeoutMs: 5 }), /逾時/);
  console.log("Routing self-tests passed: sorting, geometry deduplication, detour limits, request budget, cancellation, timeout, malformed/empty/prohibited routes.");
} finally {
  globalThis.fetch = originalFetch;
}
