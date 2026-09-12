import type { ActiveLayers } from "./MapView";

interface Props {
  layers: ActiveLayers;
  onChange: (l: ActiveLayers) => void;
  zoneCount: number;
}

export default function LayersSheet({ layers, onChange, zoneCount }: Props) {
  const items: { key: keyof ActiveLayers; label: string; note?: string }[] = [
    { key: "waitingZone", label: "待轉格", note: zoneCount ? `${zoneCount.toLocaleString()} 格` : "載入中" },
    { key: "traffic", label: "即時路況" },
    { key: "nightLighting", label: "夜間光線", note: "道路光暈與建築陰影" },
    { key: "buildings3d", label: "3D 建築" },
    { key: "crosswalk", label: "行人穿越道" },
  ];
  return (
    <>
      {items.map(({ key, label, note }) => (
        <div className="layer-item" key={key}>
          <div className="layer-item-left">
            {label}
            {note && <span className="layer-tag">{note}</span>}
          </div>
          <label className="switch">
            <input type="checkbox" aria-label={label} checked={layers[key]} onChange={(e) => onChange({ ...layers, [key]: e.target.checked })} />
            <span className="switch-track" />
          </label>
        </div>
      ))}
      <div className="sheet-note">
        待轉格由航拍影像辨識，涵蓋範圍與可靠度依地區而異；請以現場標誌為準。
      </div>
    </>
  );
}
