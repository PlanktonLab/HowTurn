import type { DirectionsRoute } from "./mapboxDirections";
import { fetchRoutes } from "./mapboxDirections";
import { generateDetourRoutes } from "./alternativeRoute";
import { annotateLeftTurns, type TwoStageContext } from "./twoStageLeft";
import type { LeftTurn, RouteOption, RouteOptionId } from "./types";

type Endpoint = { lng: number; lat: number };
interface Candidate { route: DirectionsRoute; leftTurns: LeftTurn[] }
export interface RoutePlan { fastest: RouteOption; avoidWaiting: RouteOption | null }
export interface PlannerOptions {
  signal?: AbortSignal;
  /** Publish useful results before the optional local detour requests finish. */
  onPrimaryRoute?: (plan: RoutePlan) => void;
  /** Local previews can supply fixtures without calling the routing service. */
  initialRoutes?: DirectionsRoute[];
}

const requiredCount = (candidate: Candidate) => candidate.leftTurns.filter((turn) => turn.status === "required").length;
const unknownCount = (candidate: Candidate) => candidate.leftTurns.filter((turn) => turn.status === "unknown").length;
const uturnCount = (route: DirectionsRoute) => route.steps.filter((step) => step.modifier === "uturn").length;

export function buildRouteOption(route: DirectionsRoute, ctx: TwoStageContext, id: RouteOptionId = "fastest", label = "建議路線"): RouteOption {
  return toOption({ route, leftTurns: annotateLeftTurns(route, ctx) }, id, label);
}

function toOption({ route, leftTurns }: Candidate, id: RouteOptionId, label: string): RouteOption {
  return {
    id, label, durationMin: route.durationMin, distanceKm: route.distanceKm,
    geometry: route.geometry, steps: route.steps, congestion: route.congestion,
    maxspeedKph: route.maxspeedKph, leftTurns,
    waitingZones: [...new Map(leftTurns.flatMap((turn) => turn.zone ? [[turn.zone.properties.id, turn.zone] as const] : [])).values()],
  };
}

/** Reject disproportionately long routes even when they save one wait. */
export function isReasonableAlternative(route: DirectionsRoute, fastest: DirectionsRoute): boolean {
  return route.durationS - fastest.durationS <= Math.min(180, Math.max(45, fastest.durationS * 0.3)) &&
    route.distanceM - fastest.distanceM <= Math.min(2_000, Math.max(400, fastest.distanceM * 0.35)) &&
    uturnCount(route) <= uturnCount(fastest);
}

// Compare equally spaced points along the geometry, independent of vertex
// density and rounded ETA. Identical roads encoded differently collapse too.
function sampleRoute(route: DirectionsRoute): number[][] {
  const coords = route.geometry.coordinates;
  const lengths = [0];
  for (let i = 1; i < coords.length; i++) lengths.push(lengths[i - 1] + distanceM(coords[i - 1], coords[i]));
  const total = lengths[lengths.length - 1];
  let cursor = 1;
  return Array.from({ length: 41 }, (_, i) => {
    const target = total * i / 40;
    while (cursor < lengths.length - 1 && lengths[cursor] < target) cursor++;
    const fraction = (target - lengths[cursor - 1]) / (lengths[cursor] - lengths[cursor - 1] || 1);
    return [0, 1].map((axis) => coords[cursor - 1][axis] + (coords[cursor][axis] - coords[cursor - 1][axis]) * fraction);
  });
}

function distanceM(a: number[], b: number[]): number {
  const latScale = Math.cos((a[1] + b[1]) * Math.PI / 360);
  return Math.hypot((a[0] - b[0]) * 111_320 * latScale, (a[1] - b[1]) * 110_574);
}

export function routesAreEquivalent(a: DirectionsRoute, b: DirectionsRoute): boolean {
  if (Math.abs(a.distanceM - b.distanceM) > Math.max(40, Math.min(a.distanceM, b.distanceM) * 0.03)) return false;
  const first = sampleRoute(a), second = sampleRoute(b);
  const differences = first.map((p, i) => distanceM(p, second[i]));
  return Math.max(...differences) < 45 && differences.reduce((sum, value) => sum + value, 0) / differences.length < 15;
}

export async function planMotorcycleRoutes(
  origin: Endpoint, destination: Endpoint, token: string, ctx: TwoStageContext,
  options: PlannerOptions = {},
): Promise<RoutePlan> {
  const { signal } = options;
  signal?.throwIfAborted();
  if (distanceM([origin.lng, origin.lat], [destination.lng, destination.lat]) < 30) {
    throw new Error("起點與目的地太接近，請選擇不同的位置");
  }
  const routes = options.initialRoutes ?? await fetchRoutes(origin, destination, "motorcycle", token, { signal });
  signal?.throwIfAborted();
  if (!routes.length) throw new Error("找不到可行駛路線，請調整起點或目的地");
  const analyzed = [...routes].sort((a, b) => a.durationS - b.durationS || a.distanceM - b.distanceM)
    .filter((route, i, sorted) => !sorted.slice(0, i).some((other) => routesAreEquivalent(route, other)))
    .map((route) => ({ route, leftTurns: annotateLeftTurns(route, ctx) }));
  const fastest = analyzed[0];
  const others = analyzed.slice(1).filter((candidate) => isReasonableAlternative(candidate.route, fastest.route));
  const fewerWaits = (pool: Candidate[]) => pool.filter((candidate) =>
    requiredCount(candidate) < requiredCount(fastest) && unknownCount(candidate) <= unknownCount(fastest)
  ).sort((a, b) => requiredCount(a) - requiredCount(b) || a.route.durationS - b.route.durationS)[0];
  const makePlan = (avoid?: Candidate): RoutePlan => ({
    fastest: toOption(fastest, "fastest", "建議路線"),
    avoidWaiting: avoid ? toOption(avoid, "avoidWaiting", "不待轉優先") : null,
  });
  let best = fewerWaits(others);
  const primary = makePlan(best);
  options.onPrimaryRoute?.(primary);
  signal?.throwIfAborted();
  // A legitimate route needs no invented alternative. Existing useful
  // alternatives and previews also need no further network requests.
  if (best || !requiredCount(fastest) || options.initialRoutes) return primary;
  const detours = await generateDetourRoutes(origin, destination, fastest.route,
    fastest.leftTurns.filter((turn) => turn.status === "required").map((turn) => turn.location),
    "motorcycle", token, undefined, signal);
  signal?.throwIfAborted();
  const useful = detours.filter((route) => isReasonableAlternative(route, fastest.route) &&
    !analyzed.some((candidate) => routesAreEquivalent(route, candidate.route)))
    .map((route) => ({ route, leftTurns: annotateLeftTurns(route, ctx) }));
  best = fewerWaits(useful);
  return makePlan(best);
}
