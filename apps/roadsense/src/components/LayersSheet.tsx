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
    { key: "buildings3d", label: "3D 建築" },
    { key: "motorcycle", label: "機車事故熱點" },
    { key: "pedestrian", label: "行人事故熱點" },
    { key: "intersection", label: "高事故路口" },
    { key: "roadSegment", label: "高事故路段" },
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
            <input type="checkbox" checked={layers[key]} onChange={(e) => onChange({ ...layers, [key]: e.target.checked })} />
            <span className="switch-track" />
          </label>
        </div>
      ))}
      <div className="sheet-note">
        待轉格為 DieTurn 以 2025 年台北市航拍正射影像辨識，涵蓋 757 個路口。
        事故資料為全台 22 縣市 114 年（2025）警政署統計，互動圖層目前涵蓋台北市。
      </div>
    </>
  );
}
