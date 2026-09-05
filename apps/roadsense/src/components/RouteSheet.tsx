import { Check, Zap, CornerUpLeft, Route, Bike, Car, Footprints, Navigation2, Play } from "lucide-react";
import type { LeftTurn, RouteOption, RouteOptionId, TravelMode } from "../lib/types";
import { explainAvoidWaitingRoute } from "../lib/routeAnalysis";
import { cleanRoadName } from "../lib/instructions";

interface Props {
  destinationName: string;
  fastest: RouteOption;
  avoidWaiting: RouteOption | null;
  selected: RouteOptionId;
  onSelect: (id: RouteOptionId) => void;
  onStart: () => void;
  onSimulate: () => void;
  mode: TravelMode;
  onModeChange: (m: TravelMode) => void;
}

const MODES: { key: TravelMode; Icon: typeof Bike }[] = [
  { key: "motorcycle", Icon: Bike },
  { key: "car", Icon: Car },
  { key: "walking", Icon: Footprints },
];

const STATUS_LABEL: Record<LeftTurn["status"], string> = { required: "待轉", direct: "直接左轉", unknown: "無資料" };

export default function RouteSheet({
  destinationName, fastest, avoidWaiting, selected, onSelect, onStart, onSimulate, mode, onModeChange,
}: Props) {
  const active = selected !== "fastest" && avoidWaiting ? avoidWaiting : fastest;
  const reasons = avoidWaiting?.id === "avoidWaiting" ? explainAvoidWaitingRoute(fastest, avoidWaiting) : [];
  const unknown = active.leftTurns.filter((l) => l.status === "unknown").length;

  return (
    <>
      <div className="route-sheet-head">
        <div>
          <div className="route-dest">{destinationName}</div>
          <div className="route-meta">
            {active.durationMin} 分鐘 · {active.distanceKm} 公里
          </div>
        </div>
        <div className="segmented segmented-compact">
          {MODES.map(({ key, Icon }) => (
            <button key={key} className={mode === key ? "active" : ""} onClick={() => onModeChange(key)} aria-label={key}>
              <Icon size={16} strokeWidth={2} />
            </button>
          ))}
        </div>
      </div>

      <div className="route-options">
        <Option route={fastest} Icon={Zap} name="最快路線" selected={selected === "fastest"} onClick={() => onSelect("fastest")} />
        {avoidWaiting && (
          <Option
            route={avoidWaiting}
            Icon={avoidWaiting.id === "avoidWaiting" ? CornerUpLeft : Route}
            name={avoidWaiting.label}
            selected={selected === avoidWaiting.id}
            onClick={() => onSelect(avoidWaiting.id)}
          />
        )}
      </div>

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

      {mode === "motorcycle" && active.leftTurns.length > 0 && (
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
              {unknown} 個左轉路口不在待轉格資料範圍內，導航時請依路口標誌決定是否待轉。
            </div>
          )}
        </div>
      )}

      <div className="route-actions">
        <button className="btn btn-dark" onClick={onStart}>
          <Navigation2 size={17} strokeWidth={2.4} />
          開始導航
        </button>
        <button className="btn btn-ghost" onClick={onSimulate} aria-label="模擬行駛">
          <Play size={17} strokeWidth={2.4} />
          模擬
        </button>
      </div>
    </>
  );
}

function Option({
  route, name, Icon, selected, onClick,
}: {
  route: RouteOption;
  name: string;
  Icon: typeof Zap;
  selected: boolean;
  onClick: () => void;
}) {
  const required = route.leftTurns.filter((l) => l.status === "required").length;
  const details: string[] = [`${route.distanceKm} 公里`];
  if (required > 0) details.push(`${required} 個待轉路口`);
  else if (route.leftTurns.length > 0) details.push("不需待轉");
  if (route.stats.highOrExtreme > 0) details.push(`${route.stats.highOrExtreme} 個高風險路口`);

  return (
    <button className={`route-option ${selected ? "selected" : ""}`} onClick={onClick}>
      <div>
        <div className="route-option-name">
          <Icon size={16} strokeWidth={2.2} />
          {name}
        </div>
        <div className="route-option-sub">{details.join(" · ")}</div>
      </div>
      <div className="route-option-time">{route.durationMin} 分</div>
    </button>
  );
}
