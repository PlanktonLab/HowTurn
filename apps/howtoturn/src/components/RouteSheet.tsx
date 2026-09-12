import { Check, Zap, CornerUpLeft, Navigation2, Play, X } from "lucide-react";
import type { LeftTurn, RouteOption, RouteOptionId } from "../lib/types";
import { explainAvoidWaitingRoute } from "../lib/routeAnalysis";
import { cleanRoadName } from "../lib/instructions";

interface Props {
  destinationName: string;
  fastest: RouteOption;
  avoidWaiting: RouteOption | null;
  selected: RouteOptionId;
  onSelect: (id: RouteOptionId) => void;
  onStart: () => void;
  onSimulate?: () => void;
  onClose: () => void;
  findingAlternative: boolean;
}


const STATUS_LABEL: Record<LeftTurn["status"], string> = { required: "待轉", direct: "直接左轉", unknown: "待確認" };

export default function RouteSheet({
  destinationName, fastest, avoidWaiting, selected, onSelect, onStart, onSimulate, onClose, findingAlternative,
}: Props) {
  const fewerWaitingRoute = avoidWaiting?.id === "avoidWaiting" ? avoidWaiting : null;
  const active = selected === "avoidWaiting" && fewerWaitingRoute ? fewerWaitingRoute : fastest;
  const reasons = avoidWaiting?.id === "avoidWaiting" ? explainAvoidWaitingRoute(fastest, avoidWaiting) : [];
  const unknown = active.leftTurns.filter((l) => l.status === "unknown").length;
  const baseRequired = fastest.leftTurns.filter((l) => l.status === "required").length;
  const baseUnknown = fastest.leftTurns.filter((l) => l.status === "unknown").length;
  const modeHint = fewerWaitingRoute ? "優先減少已知待轉路口，仍請依現場標誌行駛。" :
    baseRequired === 0 && baseUnknown === 0 ? "這條路線已不需待轉。" :
    findingAlternative ? "正在確認是否有較少待轉的路線，目前先沿用建議路線。" :
    baseUnknown > 0 ? `目前找不到更少待轉的路線，沿用建議路線；${baseUnknown} 個左轉路口仍待確認。` :
    "目前找不到更少待轉的路線，沿用建議路線。";

  return (
    <>
      <div className="route-content">
      <div className="route-sheet-head">
        <div>
          <div className="route-dest">{destinationName}</div>
          <div className="route-meta">
            {active.durationMin} 分鐘 · {active.distanceKm} 公里
          </div>
        </div>
        <div className="route-sheet-tools">
          <button type="button" className="route-close" onClick={onClose} aria-label="關閉路線預覽"><X size={16} /></button>
        </div>
      </div>

      <div className="route-options">
        <Option route={fastest} Icon={Zap} name={fastest.label} selected={selected === "fastest"} onClick={() => onSelect("fastest")} />
        <Option
          route={fewerWaitingRoute ?? fastest}
          Icon={CornerUpLeft}
          name="不待轉優先"
          selected={selected === "avoidWaiting"}
          onClick={() => onSelect("avoidWaiting")}
          note={!fewerWaitingRoute ? findingAlternative ? "正在尋找其他路線" : "沿用建議路線" : undefined}
        />
      </div>

      <details className="route-details">
        <summary>路口與待轉資訊{unknown > 0 ? ` · ${unknown} 處待確認` : ""}</summary>
        <p className="route-safety-note">規劃會避開高速公路，請依現場機車標誌行駛。</p>
        {findingAlternative && <p className="result-hint" role="status">路線已就緒，正在確認是否有較少待轉的選擇…</p>}
        <p className="route-note" role="status">{modeHint}</p>

        {reasons.length > 0 && selected === "avoidWaiting" && (
          <div className="route-why">
            <ul>
              {reasons.map((r, i) => (
                <li key={i}>
                  <Check size={15} strokeWidth={2.4} />
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}

        {active.leftTurns.length > 0 && (
          <div className="turn-list">
            <div className="turn-list-title">路線上的左轉</div>
            {active.leftTurns.map((lt) => (
              <div className="turn-row" key={lt.stepIndex}>
                <CornerUpLeft size={15} strokeWidth={2.2} className="turn-row-icon" />
                <span className="turn-row-name">{cleanRoadName(lt.roadName) || "未命名道路"}</span>
                <span className={`turn-chip turn-chip-${lt.status}`}>{STATUS_LABEL[lt.status]}</span>
              </div>
            ))}
            {unknown > 0 && (
              <div className="route-note">
                {unknown} 個左轉路口資料不足或方向待確認，請依現場標誌行駛。
              </div>
            )}
          </div>
        )}
      </details>
      </div>
      <div className="route-actions">
        <button className="btn btn-dark" onClick={onStart}><Navigation2 size={18} />開始導航</button>
        {onSimulate && <button className="btn btn-ghost" onClick={onSimulate} aria-label="模擬行駛"><Play size={17} />模擬</button>}
      </div>
    </>
  );
}

function Option({
  route, name, Icon, selected, onClick, note,
}: {
  route: RouteOption;
  name: string;
  Icon: typeof Zap;
  selected: boolean;
  onClick: () => void;
  note?: string;
}) {
  const required = route.leftTurns.filter((l) => l.status === "required").length;
  const details: string[] = [`${route.distanceKm} 公里`];
  if (required > 0) details.push(`${required} 個待轉路口`);
  const unknown = route.leftTurns.filter((l) => l.status === "unknown").length;
  if (unknown > 0) details.push(`${unknown} 個路口待確認`);
  else if (required === 0) details.push("不需待轉");

  return (
    <button className={`route-option ${selected ? "selected" : ""}`} onClick={onClick} aria-pressed={selected}>
      <div>
        <div className="route-option-name">
          <Icon size={16} strokeWidth={2.2} />
          {name}
        </div>
        <div className="route-option-sub">{note ?? details.join(" · ")}</div>
      </div>
      <div className="route-option-time">{route.durationMin} 分</div>
    </button>
  );
}
