// Import individual turf functions, not the @turf/turf meta-package: pulling
// the whole bundle costs hundreds of modules in dev and multi-MB in the build,
// which starved the map of main-thread time on first load.
import buffer from "@turf/buffer";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import { feature } from "@turf/helpers";
import type { HotspotProps, RouteRiskStats, RouteOption } from "./types";

// A hotspot "affects" a route if it falls within this buffer distance of the
// route line. 30m approximates the width of an intersection/road-user's
// awareness zone -- documented here rather than left as a magic number.
const ROUTE_BUFFER_METERS = 30;

export function analyzeRoute(
  routeGeometry: GeoJSON.LineString,
  hotspotCollections: GeoJSON.FeatureCollection<GeoJSON.Point, HotspotProps>[]
): { stats: RouteRiskStats; hitFeatures: GeoJSON.Feature<GeoJSON.Point, HotspotProps>[] } {
  const line = feature(routeGeometry);
  const buffered = buffer(line, ROUTE_BUFFER_METERS, { units: "meters" });

  const hitFeatures: GeoJSON.Feature<GeoJSON.Point, HotspotProps>[] = [];
  const seen = new Set<string>();

  if (buffered) {
    for (const fc of hotspotCollections) {
      for (const f of fc.features) {
        if (seen.has(f.properties.hotspot_id)) continue;
        if (booleanPointInPolygon(f, buffered as GeoJSON.Feature<GeoJSON.Polygon>)) {
          hitFeatures.push(f);
          seen.add(f.properties.hotspot_id);
        }
      }
    }
  }

  const stats: RouteRiskStats = {
    totalHotspots: hitFeatures.length,
    highOrExtreme: hitFeatures.filter(
      (f) => f.properties.risk_level === "high" || f.properties.risk_level === "extreme"
    ).length,
    extreme: hitFeatures.filter((f) => f.properties.risk_level === "extreme").length,
    motorcycleHotspots: hitFeatures.filter((f) => f.properties.motorcycle_accident_count > 0).length,
    pedestrianHotspots: hitFeatures.filter((f) => f.properties.pedestrian_accident_count > 0).length,
    deathsAlongRoute: hitFeatures.reduce((s, f) => s + f.properties.death_count, 0),
    injuriesAlongRoute: hitFeatures.reduce((s, f) => s + f.properties.injury_count, 0),
    exposureScore: Math.round(hitFeatures.reduce((s, f) => s + f.properties.risk_score, 0)),
  };

  return { stats, hitFeatures };
}

/**
 * Why the "避開待轉" route is worth the extra time — built from the actual
 * difference between the two analyzed routes, never hardcoded.
 */
export function explainAvoidWaitingRoute(fastest: RouteOption, avoid: RouteOption): string[] {
  const reasons: string[] = [];
  const fewerZones = fastest.waitingZones.length - avoid.waitingZones.length;
  const extraMin = avoid.durationMin - fastest.durationMin;
  const fewerHighRisk = fastest.stats.highOrExtreme - avoid.stats.highOrExtreme;

  if (fewerZones > 0) {
    reasons.push(`少 ${fewerZones} 個需要兩段式左轉的路口`);
  }
  if (fewerHighRisk > 0) {
    reasons.push(`順帶少經過 ${fewerHighRisk} 個高風險路口`);
  }
  if (extraMin > 0) {
    reasons.push(`多花約 ${extraMin} 分鐘`);
  } else if (extraMin < 0) {
    reasons.push(`而且比最快路線還快 ${-extraMin} 分鐘`);
  } else {
    reasons.push("時間和最快路線相同");
  }
  return reasons;
}
