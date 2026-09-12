import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import along from "@turf/along";
import turfBearing from "@turf/bearing";
import destination from "@turf/destination";
import turfLength from "@turf/length";
import { feature } from "@turf/helpers";

export interface Fix {
  lng: number;
  lat: number;
  /** compass heading of travel, null when the device does not know */
  headingDeg: number | null;
  speedMps: number | null;
  accuracyM: number;
  timestamp: number;
}

export interface LocationProvider {
  readonly kind: "gps" | "sim";
  start(onFix: (fix: Fix) => void, onError: (message: string) => void): void;
  stop(): void;
}

/** One API for the browser and the installed app, including native permissions. */
async function ensureLocationPermission() {
  if (!Capacitor.isNativePlatform()) return;
  let permissions = await Geolocation.checkPermissions();
  if (permissions.location !== 'granted' && permissions.coarseLocation !== 'granted') {
    permissions = await Geolocation.requestPermissions({ permissions: ['location'] });
  }
  if (permissions.location !== 'granted' && permissions.coarseLocation !== 'granted') {
    throw new Error('定位權限被拒絕，請在系統設定中允許 HowTurn 使用定位');
  }
}

export function locationErrorMessage(error: unknown): string {
  const err = error as { code?: string | number; message?: string };
  if (err?.code === 1 || err?.code === 'OS-PLUG-GLOC-0003') {
    return Capacitor.isNativePlatform()
      ? '定位權限被拒絕，請在系統設定中允許 HowTurn 使用定位'
      : '定位權限被拒絕，請在瀏覽器設定允許定位';
  }
  if (err?.code === 2 || err?.code === 'OS-PLUG-GLOC-0007' || err?.code === 'OS-PLUG-GLOC-0009') {
    return '目前無法取得定位，請確認裝置定位服務已開啟';
  }
  if (err?.code === 3 || err?.code === 'OS-PLUG-GLOC-0010') return '定位逾時，請移至訊號較好的位置後重試';
  return err?.message || '無法取得定位，請稍後重試';
}

export async function getCurrentFix(): Promise<Fix> {
  try {
    await ensureLocationPermission();
    return toFix(await Geolocation.getCurrentPosition({ enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }));
  } catch (error) {
    throw new Error(locationErrorMessage(error));
  }
}

function toFix(pos: { coords: { longitude: number; latitude: number; heading: number | null; speed: number | null; accuracy: number }; timestamp: number }): Fix {
  const c = pos.coords;
  return {
    lng: c.longitude,
    lat: c.latitude,
    headingDeg: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
    speedMps: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
    accuracyM: c.accuracy ?? 50,
    timestamp: pos.timestamp || Date.now(),
  };
}

/** Uses the native GPS plugin in APKs and browser geolocation on the web. */
export class GpsProvider implements LocationProvider {
  readonly kind = 'gps' as const;
  private watchId: string | null = null;
  private generation = 0;

  start(onFix: (fix: Fix) => void, onError: (message: string) => void) {
    this.stop();
    const generation = this.generation;
    void (async () => {
      try {
        await ensureLocationPermission();
        if (generation !== this.generation) return;
        const id = await Geolocation.watchPosition(
          { enableHighAccuracy: true, maximumAge: 0, timeout: 15000, minimumUpdateInterval: 1000 },
          (pos, error) => {
            if (generation !== this.generation) return;
            if (error) onError(locationErrorMessage(error));
            else if (pos) onFix(toFix(pos));
          },
        );
        if (generation !== this.generation) await Geolocation.clearWatch({ id });
        else this.watchId = id;
      } catch (error) {
        if (generation === this.generation) onError(locationErrorMessage(error));
      }
    })();
  }

  stop() {
    this.generation += 1;
    if (this.watchId != null) void Geolocation.clearWatch({ id: this.watchId }).catch(() => {});
    this.watchId = null;
  }
}

export interface SimOptions {
  speedMps?: number;
  intervalMs?: number;
  /** metres of random noise added to each fix, like a real receiver */
  jitterM?: number;
}

/**
 * Drives along the route at a fixed speed, emitting fixes like a GPS would.
 * Used for desktop demos and indoor presentations; `detour()` pushes the
 * position sideways for a while so the reroute path can be exercised.
 */
export class SimulatedProvider implements LocationProvider {
  readonly kind = "sim" as const;
  private timer: number | null = null;
  private line: GeoJSON.Feature<GeoJSON.LineString>;
  private totalM: number;
  private progressM = 0;
  private detourUntil = 0;
  private pauses: { atM: number; seconds: number; done: boolean }[] = [];
  private pausedUntil = 0;
  private opts: Required<SimOptions>;
  private onFix: ((fix: Fix) => void) | null = null;

  constructor(route: GeoJSON.LineString, opts: SimOptions = {}) {
    this.line = feature(route);
    this.totalM = turfLength(this.line, { units: "meters" });
    this.opts = { speedMps: opts.speedMps ?? 11, intervalMs: opts.intervalMs ?? 1000, jitterM: opts.jitterM ?? 1.5 };
  }

  start(onFix: (fix: Fix) => void) {
    this.onFix = onFix;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), this.opts.intervalMs);
  }

  stop() {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
  }

  /** follow a new route from the current position (after a reroute) */
  setRoute(route: GeoJSON.LineString) {
    this.line = feature(route);
    this.totalM = turfLength(this.line, { units: "meters" });
    this.progressM = 0;
    this.detourUntil = 0;
    this.pauses = [];
  }

  detour(seconds = 25) {
    this.detourUntil = Date.now() + seconds * 1000;
  }

  /** stop for a while at these distances along the route — a red light at
   *  each 待轉格, so the demo shows the "wait" phase instead of racing through */
  setPauses(alongM: number[], seconds = 6) {
    this.pauses = alongM.map((atM) => ({ atM, seconds, done: false }));
  }

  setSpeed(mps: number) {
    this.opts.speedMps = mps;
  }

  private tick() {
    const paused = Date.now() < this.pausedUntil;
    const speed = paused ? 0 : this.opts.speedMps;
    const next = Math.min(this.totalM, this.progressM + (speed * this.opts.intervalMs) / 1000);
    const stop = this.pauses.find((p) => !p.done && p.atM > this.progressM - 1 && p.atM <= next);
    if (stop) {
      stop.done = true;
      this.pausedUntil = Date.now() + stop.seconds * 1000;
      this.progressM = stop.atM;
    } else {
      this.progressM = next;
    }
    const pos = along(this.line, this.progressM, { units: "meters" });
    const ahead = along(this.line, Math.min(this.totalM, this.progressM + 8), { units: "meters" });
    const behind = along(this.line, Math.max(0, this.progressM - 8), { units: "meters" });
    const bearing = (turfBearing(behind, ahead) + 360) % 360;

    let p = pos;
    if (Date.now() < this.detourUntil) {
      // slide off the route sideways, 4 m per tick, so the tracker sees a
      // genuine, growing deviation rather than a teleport
      const elapsed = (this.detourUntil - Date.now()) / 1000;
      const offM = Math.min(120, (25 - elapsed) * 5);
      p = destination(pos, offM / 1000, bearing + 90, { units: "kilometers" });
    }
    const j = this.opts.jitterM;
    const [lng, lat] = p.geometry.coordinates;
    this.onFix?.({
      lng: lng + ((Math.random() - 0.5) * j) / 111_320,
      lat: lat + ((Math.random() - 0.5) * j) / 110_574,
      headingDeg: bearing,
      speedMps: this.progressM >= this.totalM ? 0 : speed,
      accuracyM: 5,
      timestamp: Date.now(),
    });
    if (this.progressM >= this.totalM) this.stop();
  }
}
