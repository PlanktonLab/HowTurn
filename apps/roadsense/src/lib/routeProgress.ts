import type { Fix } from "./location";
import type { RouteStep } from "./mapboxDirections";

export interface Progress {
  fix: Fix;
  /** the fix projected onto the route */
  snapped: [number, number];
  distanceAlongM: number;
  /** perpendicular distance from the fix to the route */
  offRouteM: number;
  /** false once the rider has clearly left the route (3 consecutive fixes) */
  onRoute: boolean;
  /** direction of the route at the snapped point */
  routeBearing: number;
  segmentIndex: number;
  /** index of the step currently being traversed */
  stepIndex: number;
  /** index of the upcoming maneuver's step, null when none is left */
  nextManeuverIndex: number | null;
  distToManeuverM: number;
  remainingM: number;
  remainingS: number;
  speedMps: number;
}

const OFF_ROUTE_M = 35;
const OFF_ROUTE_FIXES = 3;
/** this far from the route we don't wait for confirmation fixes */
const FAR_OFF_ROUTE_M = 100;
const BACK_ON_ROUTE_M = 20;
const WINDOW_BACK = 4;
const WINDOW_FORWARD = 60;
const GLOBAL_SEARCH_THRESHOLD_M = 60;
const M_PER_DEG_LAT = 110_574;

/**
 * Snaps GPS fixes to the route and turns them into "where am I on this route".
 * Everything downstream (banner, voice, camera) works in route-distance
 * space, which is what makes the guidance stable while the raw fixes wobble.
 */
export class RouteTracker {
  private coords: [number, number][];
  private cum: number[] = [];
  private segLen: number[] = [];
  private segBearing: number[] = [];
  private stepStartM: number[] = [];
  private steps: RouteStep[];
  readonly totalM: number;
  private lastSeg = -1;
  private lastAlong = 0;
  private offCount = 0;
  private offRoute = false;
  /** how far the first fix was from this route: a route computed from a
   *  position that GPS put 80 m off the road starts 80 m away by
   *  construction, and that must not read as "deviated" until the rider has
   *  actually been on the line once */
  private baselineM: number | null = null;
  private lastFix: Fix | null = null;
  private mPerDegLon: number;

  constructor(geometry: GeoJSON.LineString, steps: RouteStep[]) {
    this.coords = geometry.coordinates as [number, number][];
    this.steps = steps;
    const lat0 = this.coords[0][1];
    this.mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
    let acc = 0;
    this.cum.push(0);
    for (let i = 1; i < this.coords.length; i++) {
      const [x, y] = this.toM(this.coords[i - 1]);
      const [x2, y2] = this.toM(this.coords[i]);
      const len = Math.hypot(x2 - x, y2 - y);
      this.segLen.push(len);
      this.segBearing.push(((Math.atan2(x2 - x, y2 - y) * 180) / Math.PI + 360) % 360);
      acc += len;
      this.cum.push(acc);
    }
    this.totalM = acc;
    // step distances come from the routing graph and differ from the drawn
    // geometry's length by a hair; scale so the last maneuver lands at the end
    const stepSum = steps.reduce((s, st) => s + st.distanceM, 0) || 1;
    const k = this.totalM / stepSum;
    let sAcc = 0;
    for (const st of steps) {
      this.stepStartM.push(sAcc * k);
      sAcc += st.distanceM;
    }
  }

  private toM([lng, lat]: [number, number]): [number, number] {
    return [(lng - this.coords[0][0]) * this.mPerDegLon, (lat - this.coords[0][1]) * M_PER_DEG_LAT];
  }

  stepStart(i: number): number {
    return this.stepStartM[i] ?? this.totalM;
  }

  update(fix: Fix): Progress {
    const [px, py] = this.toM([fix.lng, fix.lat]);
    const search = (from: number, to: number) => {
      let best = { d: Infinity, seg: 0, t: 0 };
      for (let i = Math.max(0, from); i < Math.min(this.segLen.length, to); i++) {
        const [ax, ay] = this.toM(this.coords[i]);
        const [bx, by] = this.toM(this.coords[i + 1]);
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
        const qx = ax + t * (bx - ax), qy = ay + t * (by - ay);
        const d = Math.hypot(px - qx, py - qy);
        if (d < best.d) best = { d, seg: i, t };
      }
      return best;
    };

    let best = this.lastSeg < 0 ? search(0, Infinity) : search(this.lastSeg - WINDOW_BACK, this.lastSeg + WINDOW_FORWARD);
    if (this.lastSeg >= 0 && best.d > GLOBAL_SEARCH_THRESHOLD_M) {
      const g = search(0, Infinity);
      // only jump if the global match is clearly better AND ahead-ish, so a
      // parallel street 40 m over does not teleport the puck across town
      if (g.d < best.d * 0.5) best = g;
    }

    const along = this.cum[best.seg] + best.t * this.segLen[best.seg];
    const [ax, ay] = this.toM(this.coords[best.seg]);
    const [bx, by] = this.toM(this.coords[best.seg + 1]);
    const snappedM: [number, number] = [ax + best.t * (bx - ax), ay + best.t * (by - ay)];
    const snapped: [number, number] = [
      this.coords[0][0] + snappedM[0] / this.mPerDegLon,
      this.coords[0][1] + snappedM[1] / M_PER_DEG_LAT,
    ];

    if (this.baselineM == null) this.baselineM = Math.min(FAR_OFF_ROUTE_M * 2, best.d);
    if (best.d < BACK_ON_ROUTE_M) this.baselineM = 0;
    const tolerance = Math.max(OFF_ROUTE_M, fix.accuracyM * 1.5, this.baselineM + 15);
    if (best.d > tolerance) this.offCount++;
    else if (best.d < BACK_ON_ROUTE_M) this.offCount = 0;
    if (this.offCount >= OFF_ROUTE_FIXES || best.d > Math.max(FAR_OFF_ROUTE_M, tolerance)) this.offRoute = true;
    if (this.offCount === 0) this.offRoute = false;

    let speed = fix.speedMps ?? NaN;
    if (Number.isNaN(speed) && this.lastFix) {
      const dt = (fix.timestamp - this.lastFix.timestamp) / 1000;
      const [lx, ly] = this.toM([this.lastFix.lng, this.lastFix.lat]);
      speed = dt > 0 ? Math.hypot(px - lx, py - ly) / dt : 0;
    }
    if (Number.isNaN(speed)) speed = 0;

    this.lastSeg = best.seg;
    this.lastAlong = along;
    this.lastFix = fix;

    // the step we are on: last maneuver at or before our position
    let stepIndex = 0;
    for (let i = 0; i < this.stepStartM.length; i++) {
      if (this.stepStartM[i] <= along + 1) stepIndex = i;
      else break;
    }
    const nextManeuverIndex = stepIndex + 1 < this.steps.length ? stepIndex + 1 : null;
    const distToManeuverM = nextManeuverIndex != null ? this.stepStartM[nextManeuverIndex] - along : this.totalM - along;

    const remainingM = Math.max(0, this.totalM - along);
    const stepEnd = nextManeuverIndex != null ? this.stepStartM[nextManeuverIndex] : this.totalM;
    const stepLen = Math.max(1, stepEnd - this.stepStartM[stepIndex]);
    const fracLeft = Math.max(0, Math.min(1, (stepEnd - along) / stepLen));
    let remainingS = (this.steps[stepIndex]?.durationS ?? 0) * fracLeft;
    for (let i = stepIndex + 1; i < this.steps.length; i++) remainingS += this.steps[i].durationS;

    return {
      fix,
      snapped,
      distanceAlongM: along,
      offRouteM: best.d,
      onRoute: !this.offRoute,
      routeBearing: this.segBearing[best.seg] ?? 0,
      segmentIndex: best.seg,
      stepIndex,
      nextManeuverIndex,
      distToManeuverM,
      remainingM,
      remainingS,
      speedMps: speed,
    };
  }

  get lastDistanceAlongM() {
    return this.lastAlong;
  }

  get endPoint(): [number, number] {
    return this.coords[this.coords.length - 1];
  }

  /** straight-line metres from a fix to the route's end */
  distanceToEnd(fix: { lng: number; lat: number }): number {
    const [ex, ey] = this.toM(this.endPoint);
    const [px, py] = this.toM([fix.lng, fix.lat]);
    return Math.hypot(px - ex, py - ey);
  }

  private segmentAt(m: number): number {
    // binary search the cumulative table
    let lo = 0, hi = this.cum.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= m) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, Math.min(this.segLen.length - 1, lo));
  }

  /** coordinate at a distance along the route */
  pointAt(m: number): [number, number] {
    const d = Math.max(0, Math.min(this.totalM, m));
    const i = this.segmentAt(d);
    const t = this.segLen[i] > 0 ? (d - this.cum[i]) / this.segLen[i] : 0;
    const a = this.coords[i], b = this.coords[i + 1] ?? a;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  bearingAt(m: number): number {
    return this.segBearing[this.segmentAt(Math.max(0, Math.min(this.totalM, m)))] ?? 0;
  }
}
