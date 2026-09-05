import nearestPointOnLine from "@turf/nearest-point-on-line";
import { feature } from "@turf/helpers";
import type { Lane, RouteStep } from "./mapboxDirections";
import type { Progress } from "./routeProgress";
import type { HotspotProps, LeftTurn, RouteOption } from "./types";
import { cleanRoadName, formatDistance, leftTurnAdvice, phraseForStep, spokenDistance } from "./instructions";
import { angleDiff360 } from "./twoStageLeft";

export type TwoStagePhase = "approach" | "enter" | "wait" | "done";
export type BannerTone = "default" | "amber" | "green" | "alert";

export interface Guidance {
  arrived: boolean;
  /** the maneuver the banner is about */
  maneuver: { step: RouteStep; index: number; distanceM: number; leftTurn: LeftTurn | null } | null;
  banner: { title: string; text: string; tone: BannerTone };
  advice: ReturnType<typeof leftTurnAdvice> | null;
  twoStage: { phase: TwoStagePhase; leftTurn: LeftTurn } | null;
  lanes: Lane[] | null;
  /** the maneuver after the upcoming one, when it follows closely */
  next: { step: RouteStep; leftTurn: LeftTurn | null } | null;
  hotspotAlert: boolean;
  speedLimitKph: number | null;
  say: { text: string; interrupt?: boolean } | null;
}

const APPROACH_M = 300;
const ENTER_M = 60;
const WAIT_RADIUS_M = 12;
const DONE_HOLD_MS = 4000;
const HOTSPOT_M = 80;
const ARRIVE_M = 25;
const LANES_SHOW_M = 400;
const NEXT_CHIP_M = 200;
const TIERS: { key: string; at: number; minStep: number }[] = [
  { key: "far", at: 500, minStep: 700 },
  { key: "mid", at: 200, minStep: 250 },
  { key: "near", at: 60, minStep: 0 },
  { key: "now", at: 20, minStep: 0 },
];

/**
 * Turns route progress into guidance. Stateful on purpose: which
 * announcements already fired, and where we are in a two-stage left turn,
 * both have to survive from one GPS fix to the next.
 */
export class GuidanceEngine {
  private fired = new Set<string>();
  private active: { lt: LeftTurn; phase: TwoStagePhase; doneAt: number } | null = null;
  private hotspotAlongM: number[];
  private started = false;
  private arrivedSaid = false;

  private route: RouteOption;
  private stepStart: (i: number) => number;
  private totalM: number;

  constructor(
    route: RouteOption,
    hotspots: GeoJSON.Feature<GeoJSON.Point, HotspotProps>[],
    stepStart: (i: number) => number,
    totalM: number,
    opts: { silentStart?: boolean } = {}
  ) {
    this.started = !!opts.silentStart;
    this.route = route;
    this.stepStart = stepStart;
    this.totalM = totalM;
    const line = feature(route.geometry);
    this.hotspotAlongM = hotspots
      .filter((h) => h.properties.risk_level === "high" || h.properties.risk_level === "extreme")
      .map((h) => nearestPointOnLine(line, h, { units: "meters" }).properties.location ?? Infinity)
      .sort((a, b) => a - b);
  }

  private leftTurnFor(stepIndex: number): LeftTurn | null {
    return this.route.leftTurns.find((l) => l.stepIndex === stepIndex) ?? null;
  }

  update(p: Progress): Guidance {
    const say: string[] = [];
    let interrupt = false;
    const steps = this.route.steps;

    if (!this.started) {
      this.started = true;
      const road = cleanRoadName(steps[0]?.name);
      say.push(road ? `開始導航，沿 ${road} 前進` : "開始導航");
    }

    // ---------- arrival ----------
    // "arrived" means the rider is physically at the destination — not that
    // the nearest point of the route happens to be its end (which is what a
    // fix far away from the whole route snaps to)
    const arrived = p.onRoute && p.offRouteM <= 40 && p.remainingM <= ARRIVE_M;
    if (arrived) {
      if (!this.arrivedSaid) {
        this.arrivedSaid = true;
        say.push("已抵達目的地");
        interrupt = true;
      }
      return {
        arrived: true,
        maneuver: null,
        banner: { title: "抵達", text: "目的地就在附近", tone: "default" },
        advice: null, twoStage: null, lanes: null, next: null, hotspotAlert: false,
        speedLimitKph: null,
        say: say.length ? { text: say.join("，"), interrupt } : null,
      };
    }

    // ---------- upcoming maneuver ----------
    const idx = p.nextManeuverIndex;
    const step = idx != null ? steps[idx] : null;
    const lt = idx != null ? this.leftTurnFor(idx) : null;
    const dist = p.distToManeuverM;

    // ---------- two-stage left turn state machine ----------
    if (!this.active && lt?.status === "required" && dist <= APPROACH_M) {
      this.active = { lt, phase: "approach", doneAt: 0 };
    }
    if (this.active) {
      const a = this.active;
      const maneuverM = a.lt.distanceAlongM * this.scale();
      const entryM = (a.lt.zoneEntryM ?? a.lt.distanceAlongM) * this.scale();
      const distToNode = maneuverM - p.distanceAlongM;
      const nearBox = a.lt.zone ? distanceM(p.fix, a.lt.zone.properties.lon, a.lt.zone.properties.lat) <= WAIT_RADIUS_M : false;
      const exitRoad = cleanRoadName(a.lt.roadName);
      const exitDir = exitRoad ? `${exitRoad} 方向` : bearingName(a.lt.exitBearing);

      if (a.phase === "approach" && distToNode <= ENTER_M) {
        a.phase = "enter";
        say.push("靠右直行，進入前方待轉格");
        interrupt = true;
      }
      if (a.phase === "enter" && (nearBox || p.distanceAlongM >= entryM - 6 && p.speedMps < 2 || p.distanceAlongM >= maneuverM + 5)) {
        a.phase = "wait";
        say.push(`在待轉格等候左轉號誌，綠燈後往 ${exitDir}前進`);
        interrupt = true;
      }
      if (a.phase === "wait") {
        const headingOk = p.fix.headingDeg != null && angleDiff360(p.fix.headingDeg, a.lt.exitBearing) <= 45 && p.speedMps > 2;
        const passed = p.distanceAlongM >= Math.max(entryM, maneuverM) + 15;
        if (headingOk || passed) {
          a.phase = "done";
          a.doneAt = Date.now();
          say.push(exitRoad ? `待轉完成，沿 ${exitRoad} 前進` : "待轉完成，繼續前進");
        }
      }
      if (a.phase === "done" && Date.now() - a.doneAt > DONE_HOLD_MS) this.active = null;
      // safety valve: if the tracker has moved two maneuvers past this turn,
      // the rider clearly did something else — stop showing the card
      if (this.active && idx != null && idx > a.lt.stepIndex + 1) this.active = null;
    }

    // ---------- spoken maneuver announcements (non two-stage phases) ----------
    if (step && idx != null) {
      const stepLen = this.stepStart(idx) - this.stepStart(idx - 1);
      const tier = TIERS.filter((t) => t.at >= dist && stepLen >= t.minStep).sort((a, b) => a.at - b.at)[0];
      if (tier && dist > -5) {
        const key = `${idx}:${tier.key}`;
        if (!this.fired.has(key)) {
          for (const t of TIERS) if (t.at >= tier.at) this.fired.add(`${idx}:${t.key}`);
          const text = announcementFor(step, lt, tier.key, dist);
          if (text) say.push(text);
        }
      }
    }

    // ---------- hotspots ----------
    const nextHot = this.hotspotAlongM.find((h) => h >= p.distanceAlongM - 5);
    const hotspotAlert = nextHot != null && nextHot - p.distanceAlongM <= HOTSPOT_M;
    if (hotspotAlert && !this.fired.has(`hot:${nextHot}`)) {
      this.fired.add(`hot:${nextHot}`);
      say.push("前方路口事故較多，請放慢速度");
    }

    // ---------- banner ----------
    let banner: Guidance["banner"];
    let twoStage: Guidance["twoStage"] = null;
    let advice: Guidance["advice"] = null;
    let maneuver: Guidance["maneuver"] = step && idx != null ? { step, index: idx, distanceM: dist, leftTurn: lt } : null;

    if (!p.onRoute) {
      banner = { title: "偏離路線", text: "正在重新規劃路線…", tone: "alert" };
    } else if (this.active) {
      const a = this.active;
      const exitRoad = cleanRoadName(a.lt.roadName);
      twoStage = { phase: a.phase, leftTurn: a.lt };
      advice = leftTurnAdvice(a.lt);
      const ltStep = steps[a.lt.stepIndex];
      maneuver = { step: ltStep, index: a.lt.stepIndex, distanceM: Math.max(0, a.lt.distanceAlongM * this.scale() - p.distanceAlongM), leftTurn: a.lt };
      switch (a.phase) {
        case "approach":
          banner = { title: formatDistance(maneuver.distanceM), text: exitRoad ? `左轉進入 ${exitRoad}` : "左轉", tone: "amber" };
          break;
        case "enter":
          banner = { title: "靠右進入待轉格", text: "直行穿過路口，停進右前方待轉格", tone: "amber" };
          break;
        case "wait":
          banner = { title: "等候左轉號誌", text: exitRoad ? `面向 ${exitRoad}，綠燈後前進` : "面向目標道路，綠燈後前進", tone: "amber" };
          break;
        default:
          banner = { title: "待轉完成", text: exitRoad ? `沿 ${exitRoad} 前進` : "繼續前進", tone: "green" };
      }
    } else if (step) {
      advice = lt ? leftTurnAdvice(lt) : null;
      banner = { title: formatDistance(dist), text: phraseForStep(step, lt), tone: advice?.tone === "green" ? "green" : "default" };
    } else {
      banner = { title: formatDistance(p.remainingM), text: "前往目的地", tone: "default" };
    }

    // Mapbox lane data says "use the left lanes" for a left turn — exactly
    // wrong for a two-stage left, so lanes are only shown when they agree
    // with the motorcycle rule.
    const lanes = step && !this.active && lt?.status !== "required" && dist <= LANES_SHOW_M && step.lanes?.length ? step.lanes : null;

    let next: Guidance["next"] = null;
    if (idx != null && idx + 1 < steps.length && !this.active) {
      const gap = this.stepStart(idx + 1) - this.stepStart(idx);
      if (gap <= NEXT_CHIP_M) next = { step: steps[idx + 1], leftTurn: this.leftTurnFor(idx + 1) };
    }

    const speedLimitKph = this.route.maxspeedKph[p.segmentIndex] ?? null;

    return {
      arrived: false,
      maneuver,
      banner,
      advice,
      twoStage,
      lanes,
      next,
      hotspotAlert,
      speedLimitKph,
      say: say.length ? { text: say.join("。"), interrupt } : null,
    };
  }

  /** stepStart() is scaled to the drawn geometry; LeftTurn distances are
   *  raw step sums — same scale factor the tracker applies */
  private scale(): number {
    const sum = this.route.steps.reduce((s, st) => s + st.distanceM, 0) || 1;
    return this.totalM / sum;
  }
}

function announcementFor(step: RouteStep, lt: LeftTurn | null, tier: string, dist: number): string | null {
  const road = cleanRoadName(step.name);
  const into = road ? `進入 ${road}` : "";
  if (lt?.status === "required") {
    // near/now are spoken by the two-stage phases
    if (tier === "near" || tier === "now") return null;
    return `${spokenDistance(dist)}後左轉${into}，需要兩段式待轉，請提前靠右`;
  }
  if (lt?.status === "direct") {
    if (tier === "now") return `現在左轉${into}`;
    if (tier === "near") return `左轉${into}`;
    return `${spokenDistance(dist)}後左轉${into}，可直接左轉，請提前靠左`;
  }
  const phrase = phraseForStep(step, lt);
  if (step.maneuverType === "arrive") return tier === "far" || tier === "mid" ? `${spokenDistance(dist)}後${phrase}` : phrase;
  if (tier === "now") return `現在${phrase}`;
  if (tier === "near") return phrase;
  return `${spokenDistance(dist)}後${phrase}`;
}

function distanceM(a: { lng: number; lat: number }, lng: number, lat: number): number {
  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  return Math.hypot((a.lng - lng) * mLon, (a.lat - lat) * 110_574);
}

function bearingName(b: number): string {
  const names = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];
  return `${names[Math.round((((b % 360) + 360) % 360) / 45) % 8]}方`;
}
