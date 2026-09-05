import type { RouteStep } from "./mapboxDirections";
import type { LeftTurn } from "./types";

// Mapbox's own zh-Hant instruction strings mix Simplified characters in
// places (e.g. "行驶", "继续") — not acceptable for an app that promises
// consistent Traditional Chinese. We build our own phrasing from the
// language-independent maneuver type/modifier and the step's road name.
export function phraseForStep(step: RouteStep | undefined, leftTurn?: LeftTurn | null): string {
  if (!step) return "繼續前進";
  const road = cleanRoadName(step.name);
  const into = road ? `進入 ${road}` : "";
  const { maneuverType: type, modifier } = step;

  switch (type) {
    case "depart":
      return road ? `沿 ${road} 出發` : "出發";
    case "arrive":
      if (modifier === "left") return "目的地在左側";
      if (modifier === "right") return "目的地在右側";
      return "抵達目的地";
    case "roundabout":
    case "rotary":
      return step.exit ? `進入圓環，從第 ${step.exit} 個出口離開` : "進入圓環";
    case "exit roundabout":
    case "exit rotary":
      return road ? `離開圓環${into}` : "離開圓環";
    case "merge":
      return road ? `併入 ${road}` : "併入車流";
    case "on ramp":
      return road ? `上匝道往 ${road}` : "上匝道";
    case "off ramp":
      return road ? `下匝道往 ${road}` : "下匝道";
    case "fork":
      if (modifier?.includes("left")) return `叉路靠左${into ? `，${into}` : ""}`;
      if (modifier?.includes("right")) return `叉路靠右${into ? `，${into}` : ""}`;
      return "叉路保持直行";
    case "end of road":
      if (modifier?.includes("left")) return `路底左轉${into}`;
      return `路底右轉${into}`;
    case "new name":
    case "continue":
      if (modifier === "straight" || !modifier) return road ? `繼續沿 ${road} 直行` : "繼續直行";
      break;
    default:
      break;
  }

  switch (modifier) {
    case "left":
    case "sharp left": {
      const verb = modifier === "sharp left" ? "大幅左轉" : "左轉";
      if (leftTurn?.status === "required") return `兩段式左轉${into}`;
      return `${verb}${into}`;
    }
    case "right":
      return `右轉${into}`;
    case "sharp right":
      return `大幅右轉${into}`;
    case "slight left":
      return `靠左${into}`;
    case "slight right":
      return `靠右${into}`;
    case "straight":
      return road ? `直行${into}` : "繼續直行";
    case "uturn":
      return "迴轉";
    default:
      return road ? `沿 ${road} 前進` : "繼續前進";
  }
}

/** The lane-position advice that makes this a motorcycle navigator. */
export function leftTurnAdvice(lt: LeftTurn): { short: string; long: string; tone: "amber" | "green" | "neutral" } {
  switch (lt.status) {
    case "required":
      return { short: "兩段式待轉 · 靠右", long: "需要兩段式待轉，請提前靠右，直行到對面待轉格", tone: "amber" };
    case "direct":
      return { short: "可直接左轉 · 靠左", long: "此路口可直接左轉，請提前靠左", tone: "green" };
    default:
      return { short: "依路口標誌待轉", long: "此路口沒有待轉資料，請依路口標誌決定是否待轉", tone: "neutral" };
  }
}

/** Mapbox returns "" or "/" separated alternates; keep the first proper name. */
export function cleanRoadName(name: string | undefined): string {
  if (!name) return "";
  const n = name.split("/")[0].trim();
  return n === "" ? "" : n;
}

export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} 公尺`;
  return `${(m / 1000).toFixed(1)} 公里`;
}

/** spoken form: "300 公尺" / "1.2 公里" but round more aggressively */
export function spokenDistance(m: number): string {
  if (m < 100) return `${Math.max(10, Math.round(m / 10) * 10)} 公尺`;
  if (m < 1000) return `${Math.round(m / 50) * 50} 公尺`;
  return `${(Math.round(m / 100) / 10).toFixed(1)} 公里`;
}
