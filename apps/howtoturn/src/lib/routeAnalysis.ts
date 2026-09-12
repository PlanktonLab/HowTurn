import type { RouteOption } from "./types";

/**
 * Why the "避開待轉" route is worth the extra time — built from the actual
 * difference between the two analyzed routes, never hardcoded.
 */
export function explainAvoidWaitingRoute(fastest: RouteOption, avoid: RouteOption): string[] {
  const reasons: string[] = [];
  const fewerZones = fastest.waitingZones.length - avoid.waitingZones.length;
  const extraMin = avoid.durationMin - fastest.durationMin;

  if (fewerZones > 0) {
    reasons.push(`少 ${fewerZones} 個需要兩段式左轉的路口`);
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
