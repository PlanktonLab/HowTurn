import { useEffect, useRef, useState } from "react";
import { Bike, Footprints, Car, MapPin, Navigation2, ArrowUpDown } from "lucide-react";
import type { TravelMode } from "../lib/types";
import { searchPlaces, type Place } from "../lib/geocode";
import { MAPBOX_TOKEN } from "../lib/config";

export interface Endpoint {
  label: string;
  lng: number;
  lat: number;
  isCurrentLocation?: boolean;
}

interface Props {
  mode: TravelMode;
  onModeChange: (m: TravelMode) => void;
  origin: Endpoint | null;
  destination: Endpoint | null;
  onOriginChange: (e: Endpoint | null) => void;
  onDestinationChange: (e: Endpoint | null) => void;
  onUseCurrentLocation: () => void;
  onSearch: () => void;
  loading: boolean;
}

const MODES: { key: TravelMode; label: string; Icon: typeof Bike }[] = [
  { key: "motorcycle", label: "機車", Icon: Bike },
  { key: "car", label: "汽車", Icon: Car },
  { key: "walking", label: "步行", Icon: Footprints },
];

export default function SearchSheet({
  mode, onModeChange, origin, destination,
  onOriginChange, onDestinationChange, onUseCurrentLocation, onSearch, loading,
}: Props) {
  const [field, setField] = useState<"origin" | "destination">("destination");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<number | null>(null);

  // live suggestions while typing, debounced so we don't hammer the API
  useEffect(() => {
    const token = MAPBOX_TOKEN;
    if (debounce.current) window.clearTimeout(debounce.current);
    // 600ms idle, not per keystroke: Nominatim (the primary geocoder for
    // Chinese POI names) asks callers not to autocomplete on every key
    debounce.current = window.setTimeout(async () => {
      if (!token || query.trim().length < 1) {
        setResults([]);
        return;
      }
      setSearching(true);
      const places = await searchPlaces(query, token, origin ?? undefined);
      setResults(places);
      setSearching(false);
    }, 600);
    return () => {
      if (debounce.current) window.clearTimeout(debounce.current);
    };
  }, [query, origin]);

  function pick(place: Place) {
    const endpoint: Endpoint = { label: place.name, lng: place.lng, lat: place.lat };
    if (field === "origin") onOriginChange(endpoint);
    else onDestinationChange(endpoint);
    setQuery("");
    setResults([]);
  }

  function swap() {
    const o = origin;
    onOriginChange(destination);
    onDestinationChange(o);
  }

  const ready = !!origin && !!destination;

  return (
    <>
      <div className="endpoints">
        <div className="endpoint-rows">
          <button
            className={`endpoint-row ${field === "origin" ? "endpoint-row-active" : ""}`}
            onClick={() => setField("origin")}
          >
            <span className="dot dot-origin" />
            <span className={origin ? "endpoint-text" : "endpoint-text endpoint-placeholder"}>
              {origin?.label ?? "選擇起點"}
            </span>
          </button>
          <button
            className={`endpoint-row ${field === "destination" ? "endpoint-row-active" : ""}`}
            onClick={() => setField("destination")}
          >
            <span className="dot dot-dest" />
            <span className={destination ? "endpoint-text" : "endpoint-text endpoint-placeholder"}>
              {destination?.label ?? "你要去哪裡？"}
            </span>
          </button>
        </div>
        <button className="swap-button" onClick={swap} aria-label="對調起點與目的地">
          <ArrowUpDown size={17} strokeWidth={2} />
        </button>
      </div>

      <input
        className="search-input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={field === "origin" ? "搜尋起點" : "搜尋目的地"}
        autoFocus
      />

      <div className="result-list">
        {field === "origin" && (
          <button className="result-row" onClick={onUseCurrentLocation}>
            <Navigation2 size={17} strokeWidth={2.2} className="result-icon" />
            <div>
              <div className="result-name">目前位置</div>
              <div className="result-address">使用裝置定位</div>
            </div>
          </button>
        )}
        {searching && <div className="result-hint">搜尋中…</div>}
        {!searching && query && results.length === 0 && <div className="result-hint">找不到符合的地點</div>}
        {results.map((p) => (
          <button key={p.id} className="result-row" onClick={() => pick(p)}>
            <MapPin size={17} strokeWidth={2.2} className="result-icon" />
            <div>
              <div className="result-name">{p.name}</div>
              <div className="result-address">{p.address}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="segmented">
        {MODES.map(({ key, label, Icon }) => (
          <button key={key} className={mode === key ? "active" : ""} onClick={() => onModeChange(key)}>
            <Icon size={15} strokeWidth={2} />
            {label}
          </button>
        ))}
      </div>
      {mode === "motorcycle" && (
        <div className="mode-hint">機車模式會標示路線上需要兩段式左轉的路口。</div>
      )}

      <button className="btn btn-dark" disabled={!ready || loading} onClick={onSearch}>
        {loading ? "正在找路線…" : "規劃路線"}
      </button>
    </>
  );
}
