import { AlertTriangle } from "lucide-react";
import type { HotspotProps } from "../lib/types";

interface Props {
  hotspot: HotspotProps;
  layerKey: string;
}

const TITLE_BY_LAYER: Record<string, string> = {
  motorcycle: "機車事故熱點",
  pedestrian: "行人事故熱點",
  intersection: "高事故路口",
  roadSegment: "高事故路段",
};

const RISK_TEXT: Record<string, string> = {
  extreme: "高風險",
  high: "高風險",
  medium: "中風險",
  low: "低風險",
};

function riskClass(level: string) {
  if (level === "extreme" || level === "high") return "risk-chip-high";
  if (level === "medium") return "risk-chip-med";
  return "risk-chip-low";
}

export default function HotspotSheet({ hotspot: h, layerKey }: Props) {
  return (
    <>
      <div className="t-section">{TITLE_BY_LAYER[layerKey] ?? "事故熱點"}</div>
      <div className="t-sec" style={{ marginTop: 2 }}>
        {h.county}
        {h.township ?? ""} · {h.road_or_intersection}
      </div>

      <div className={`risk-chip ${riskClass(h.risk_level)}`}>
        <AlertTriangle size={14} strokeWidth={2.4} />
        {RISK_TEXT[h.risk_level]}
      </div>

      <div className="stat-list">
        <Row label="歷史事故" value={`${h.accident_count} 件`} />
        <Row label="涉及機車" value={`${h.motorcycle_accident_count} 件`} />
        <Row label="涉及行人" value={`${h.pedestrian_accident_count} 件`} />
        <Row label="死亡" value={`${h.death_count} 人`} />
        <Row label="受傷" value={`${h.injury_count} 人`} />
      </div>

      <div className="sheet-note">
        資料期間 114 年（2025）· 內政部警政署傷亡道路交通事故資料
        <br />
        歷史事故資料，不代表未來事故預測。
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-row">
      <span style={{ color: "var(--ink-2)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}
