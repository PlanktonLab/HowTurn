import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ArrowUp, ArrowLeft, ArrowRight, ArrowUpLeft, ArrowUpRight, CornerUpLeft, CornerUpRight,
  Undo2, RotateCcw, Flag, Bike, AlertTriangle, X, Volume2, VolumeX, LocateFixed, FlaskConical, Satellite,
} from "lucide-react";
import type { MapViewHandle } from "./MapView";
import type { Lane, LaneIndication, RouteStep } from "../lib/mapboxDirections";
import type { HotspotProps, RouteOption } from "../lib/types";
import type { LocationProvider } from "../lib/location";
import { SimulatedProvider } from "../lib/location";
import { RouteTracker, type Progress } from "../lib/routeProgress";
import { GuidanceEngine, type Guidance } from "../lib/guidance";
import { phraseForStep } from "../lib/instructions";
import { voice } from "../lib/voice";
import { acquireWakeLock } from "../lib/wakeLock";

export interface RerouteResult {
  option: RouteOption;
  hits: GeoJSON.Feature<GeoJSON.Point, HotspotProps>[];
}

interface Props {
  route: RouteOption;
  hitFeatures: GeoJSON.Feature<GeoJSON.Point, HotspotProps>[];
  provider: LocationProvider;
  map: RefObject<MapViewHandle | null>;
  destinationName: string;
  freeLook: boolean;
  onReroute: (from: { lng: number; lat: number }, bearing: number) => Promise<RerouteResult | null>;
  onRouteReplaced: (r: RerouteResult) => void;
  onEnd: () => void;
}

const REROUTE_COOLDOWN_MS = 8000;
const GPS_WEAK_M = 40;
const GPS_LOST_MS = 8000;

type GpsStatus = "ok" | "weak" | "lost";

export default function Navigation({
  route, hitFeatures, provider, map, destinationName, freeLook, onReroute, onRouteReplaced, onEnd,
}: Props) {
  const routeRef = useRef(route);
  const tracker = useRef(new RouteTracker(route.geometry, route.steps));
  const engine = useRef<GuidanceEngine>(
    new GuidanceEngine(route, hitFeatures, (i) => tracker.current.stepStart(i), tracker.current.totalM)
  );
  const progressRef = useRef<Progress | null>(null);
  const target = useRef<{ along: number; speed: number; onRoute: boolean; raw: [number, number]; heading: number | null; acc: number; receivedAt: number } | null>(null);
  const display = useRef({ along: 0, lng: route.geometry.coordinates[0][0], lat: route.geometry.coordinates[0][1], bearing: 0, init: false });
  const lastFrame = useRef(performance.now());
  const rerouting = useRef(false);
  const lastRerouteAt = useRef(0);
  const lastArrowIdx = useRef(-1);
  const lastFixAt = useRef(Date.now());
  const callbacks = useRef({ onReroute, onRouteReplaced });
  callbacks.current = { onReroute, onRouteReplaced };

  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [summary, setSummary] = useState({ remainingM: route.distanceKm * 1000, remainingS: route.durationMin * 60, speedKph: 0 });
  const [gps, setGps] = useState<GpsStatus>("ok");
  const [error, setError] = useState<string | null>(null);
  const [isRerouting, setIsRerouting] = useState(false);
  const [muted, setMuted] = useState(voice.isMuted);

  // ---------- route replacement after a reroute ----------
  function replaceRoute(r: RerouteResult) {
    routeRef.current = r.option;
    tracker.current = new RouteTracker(r.option.geometry, r.option.steps);
    engine.current = new GuidanceEngine(r.option, r.hits, (i) => tracker.current.stepStart(i), tracker.current.totalM, { silentStart: true });
    lastArrowIdx.current = -1;
    if (provider instanceof SimulatedProvider) provider.setRoute(r.option.geometry);
    callbacks.current.onRouteReplaced(r);
  }

  async function reroute(p: Progress) {
    if (rerouting.current) return;
    const far = p.offRouteM > 100;
    if (!far && Date.now() - lastRerouteAt.current < REROUTE_COOLDOWN_MS) return;
    rerouting.current = true;
    setIsRerouting(true);
    try {
      const bearing = p.fix.headingDeg ?? display.current.bearing;
      const r = await callbacks.current.onReroute({ lng: p.fix.lng, lat: p.fix.lat }, bearing);
      if (r) {
        replaceRoute(r);
        voice.speak("已重新規劃路線", { interrupt: true });
      }
    } finally {
      rerouting.current = false;
      lastRerouteAt.current = Date.now();
      setIsRerouting(false);
    }
  }

  // ---------- GPS fixes → progress → guidance ----------
  useEffect(() => {
    const releaseWakeLock = acquireWakeLock();
    provider.start(
      (fix) => {
        lastFixAt.current = Date.now();
        const p = tracker.current.update(fix);
        progressRef.current = p;
        target.current = {
          along: p.distanceAlongM,
          speed: p.speedMps,
          onRoute: p.onRoute,
          raw: [fix.lng, fix.lat],
          heading: fix.headingDeg,
          acc: fix.accuracyM,
          receivedAt: performance.now(),
        };
        setGps(fix.accuracyM > GPS_WEAK_M ? "weak" : "ok");

        const g = engine.current.update(p);
        if (g.say) voice.speak(g.say.text, { interrupt: g.say.interrupt });
        setGuidance(g);
        setSummary({ remainingM: p.remainingM, remainingS: p.remainingS, speedKph: Math.round(p.speedMps * 3.6) });

        const m = map.current;
        const r = routeRef.current;
        if (m) {
          // the 60 fps loop below owns the puck, but requestAnimationFrame
          // stops when the page is hidden (screen off, app switched); fall
          // back to per-fix updates so the map is right when it comes back
          if (performance.now() - lastFrame.current > 500) {
            const [lng, lat] = p.onRoute ? p.snapped : [fix.lng, fix.lat];
            const b = fix.headingDeg ?? p.routeBearing;
            display.current.bearing = b;
            display.current.along = p.distanceAlongM;
            m.updatePuck(lng, lat, b, fix.accuracyM);
            m.followCamera(lng, lat, b, p.speedMps);
          }
          m.setRouteProgress(p.distanceAlongM / tracker.current.totalM);
          const arrowIdx = g.maneuver?.index ?? -1;
          if (arrowIdx !== lastArrowIdx.current) {
            lastArrowIdx.current = arrowIdx;
            if (arrowIdx >= 0 && r.steps[arrowIdx]?.maneuverType !== "arrive") m.setManeuverArrow(r.geometry, tracker.current.stepStart(arrowIdx));
            else m.setManeuverArrow(null, 0);
          }
          m.highlightWaitingZones(r.waitingZones.map((z) => z.properties.id), g.twoStage?.leftTurn.zone?.properties.id ?? null);
        }
        if (!p.onRoute && !g.arrived) reroute(p);
      },
      (msg) => setError(msg)
    );
    const lostTimer = window.setInterval(() => {
      if (Date.now() - lastFixAt.current > GPS_LOST_MS) setGps("lost");
    }, 2000);
    return () => {
      provider.stop();
      releaseWakeLock();
      window.clearInterval(lostTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  // ---------- 60 fps puck + camera between fixes ----------
  useEffect(() => {
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - lastFrame.current) / 1000);
      lastFrame.current = now;
      const t = target.current;
      const m = map.current;
      if (!t || !m) return;
      const d = display.current;
      const tr = tracker.current;

      let lng: number, lat: number, bearingTarget: number;
      if (t.onRoute) {
        // dead-reckon along the route from the last fix, then ease toward it
        const age = Math.min(2.5, (now - t.receivedAt) / 1000);
        const predicted = Math.min(tr.totalM, t.along + t.speed * age);
        if (!d.init) {
          d.along = predicted;
          d.init = true;
        }
        d.along += (predicted - d.along) * (1 - Math.exp(-dt / 0.35));
        [lng, lat] = tr.pointAt(d.along);
        bearingTarget = t.speed > 1.5 && t.heading != null ? t.heading : tr.bearingAt(d.along);
      } else {
        const k = 1 - Math.exp(-dt / 0.4);
        d.lng += (t.raw[0] - d.lng) * k;
        d.lat += (t.raw[1] - d.lat) * k;
        lng = d.lng;
        lat = d.lat;
        bearingTarget = t.heading ?? d.bearing;
      }
      d.lng = lng;
      d.lat = lat;
      let diff = ((bearingTarget - d.bearing + 540) % 360) - 180;
      if (!d.init) diff = 0;
      d.bearing = (d.bearing + diff * (1 - Math.exp(-dt / 0.45)) + 360) % 360;

      m.updatePuck(lng, lat, d.bearing, t.acc);
      m.followCamera(lng, lat, d.bearing, t.speed);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- derived UI ----------
  const remainingMin = Math.max(0, Math.round(summary.remainingS / 60));
  const remainingKm = Math.round((summary.remainingM / 1000) * 10) / 10;
  const arrival = new Date(Date.now() + summary.remainingS * 1000);
  const arrivalText = `${arrival.getHours()}:${String(arrival.getMinutes()).padStart(2, "0")}`;
  const arrived = guidance?.arrived ?? false;
  const banner = guidance?.banner ?? { title: "", text: "取得定位中…", tone: "default" as const };
  const Icon = iconForGuidance(guidance);
  const stage = guidance?.twoStage?.phase ?? null;

  return (
    <>
      <div className="nav-top">
        <div className={`nav-banner nav-banner-${banner.tone}`}>
          <div className="nav-banner-main">
            <div className="nav-banner-icon">
              <Icon size={34} strokeWidth={2.4} />
            </div>
            <div className="nav-banner-text">
              <div className="nav-distance">{banner.title}</div>
              <div className="nav-instruction">{banner.text}</div>
            </div>
          </div>
          {guidance?.advice && (!stage || stage === "approach") && (
            <div className={`nav-advice nav-advice-${guidance.advice.tone}`}>
              <Bike size={14} strokeWidth={2.4} />
              {guidance.advice.short}
            </div>
          )}
        </div>

        {guidance?.lanes && <LaneStrip lanes={guidance.lanes} />}

        {!arrived && guidance?.hotspotAlert && (
          <div className="nav-chip nav-chip-alert">
            <AlertTriangle size={13} strokeWidth={2.4} /> 前方路口事故較多，放慢速度
          </div>
        )}
        {!arrived && !guidance?.hotspotAlert && guidance?.next && (
          <div className="nav-chip">接下來 · {phraseForStep(guidance.next.step, guidance.next.leftTurn)}</div>
        )}
      </div>

      <div className="nav-left">
        <div className="nav-speed">
          <b>{summary.speedKph}</b>
          <span>km/h</span>
        </div>
        {guidance?.speedLimitKph != null && (
          <div className="nav-limit" aria-label={`速限 ${guidance.speedLimitKph}`}>{guidance.speedLimitKph}</div>
        )}
      </div>

      <div className="nav-side-controls">
        <button className="icon-button" onClick={() => { const m = !muted; setMuted(m); voice.setMuted(m); }} aria-label={muted ? "開啟語音" : "關閉語音"}>
          {muted ? <VolumeX size={19} strokeWidth={2} /> : <Volume2 size={19} strokeWidth={2} />}
        </button>
        {freeLook && (
          <button className="icon-button icon-button-active" onClick={() => map.current?.resumeFollow()} aria-label="回到導航">
            <LocateFixed size={19} strokeWidth={2} />
          </button>
        )}
        {provider instanceof SimulatedProvider && !arrived && (
          <button className="icon-button" onClick={() => provider.detour()} aria-label="模擬偏離路線" title="模擬偏離路線">
            <FlaskConical size={18} strokeWidth={2} />
          </button>
        )}
      </div>

      {arrived ? (
        <div className="nav-footer nav-footer-arrived">
          <div className="nav-arrived">
            <Flag size={20} strokeWidth={2.4} />
            <div>
              <div className="nav-eta">已抵達</div>
              <div className="nav-sub">{destinationName}</div>
            </div>
          </div>
          <button className="btn btn-dark" onClick={onEnd}>結束導航</button>
        </div>
      ) : (
        <div className="nav-footer">
          <button className="nav-exit" onClick={onEnd} aria-label="結束導航">
            <X size={20} strokeWidth={2.4} />
          </button>
          <div className="nav-summary">
            <div className="nav-eta">{remainingMin} 分鐘</div>
            <div className="nav-sub">{remainingKm} 公里 · {arrivalText} 抵達</div>
          </div>
          <div className={`nav-gps nav-gps-${gps}`} title={gps === "ok" ? "GPS 正常" : gps === "weak" ? "GPS 訊號弱" : "GPS 中斷"}>
            <Satellite size={15} strokeWidth={2.2} />
          </div>
          <div className="nav-progress">
            <div className="nav-progress-fill" style={{ width: `${Math.min(100, (1 - summary.remainingM / Math.max(1, tracker.current.totalM)) * 100)}%` }} />
          </div>
        </div>
      )}

      {!arrived && (isRerouting || error || gps === "lost") && (
        <div className={`nav-status ${error ? "nav-status-error" : ""}`}>
          {error ?? (isRerouting ? "正在重新規劃路線…" : "GPS 訊號中斷，等待定位…")}
        </div>
      )}
    </>
  );
}

function LaneStrip({ lanes }: { lanes: Lane[] }) {
  return (
    <div className="nav-lanes">
      {lanes.map((l, i) => {
        const ind = (l.valid && l.validIndication) || l.indications[0] || "straight";
        const I = laneIcon(ind);
        return (
          <div key={i} className={`nav-lane ${l.valid ? "valid" : ""} ${l.active ? "active" : ""}`}>
            <I size={20} strokeWidth={2.6} />
          </div>
        );
      })}
    </div>
  );
}

function laneIcon(ind: LaneIndication) {
  switch (ind) {
    case "left": return CornerUpLeft;
    case "slight left": return ArrowUpLeft;
    case "sharp left": return ArrowLeft;
    case "right": return CornerUpRight;
    case "slight right": return ArrowUpRight;
    case "sharp right": return ArrowRight;
    case "uturn": return Undo2;
    default: return ArrowUp;
  }
}

function iconForGuidance(g: Guidance | null) {
  if (!g) return ArrowUp;
  if (g.arrived) return Flag;
  if (g.twoStage) return Bike;
  return iconForStep(g.maneuver?.step);
}

function iconForStep(step: RouteStep | undefined) {
  if (!step) return ArrowUp;
  if (step.maneuverType === "arrive") return Flag;
  if (step.maneuverType === "roundabout" || step.maneuverType === "rotary") return RotateCcw;
  switch (step.modifier) {
    case "left": return CornerUpLeft;
    case "sharp left": return ArrowLeft;
    case "right": return CornerUpRight;
    case "sharp right": return ArrowRight;
    case "slight left": return ArrowUpLeft;
    case "slight right": return ArrowUpRight;
    case "uturn": return Undo2;
    default: return ArrowUp;
  }
}
