import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, LoaderCircle, LocateFixed, MapPin, Route, Search, X } from "lucide-react";
import { suggestPlaces, type Place } from "../lib/geocode";
import { MAPBOX_TOKEN } from "../lib/config";

export interface Endpoint {
  label: string;
  lng: number;
  lat: number;
  isCurrentLocation?: boolean;
}

type Field = "origin" | "destination";

interface Props {
  origin: Endpoint | null;
  destination: Endpoint | null;
  onOriginChange: (endpoint: Endpoint | null) => void;
  onDestinationChange: (endpoint: Endpoint | null) => void;
  onUseCurrentLocation: () => Promise<Endpoint | null>;
  onPlan: (origin: Endpoint, destination: Endpoint) => void;
  planning: boolean;
}

const SEARCH_DELAY_MS = 280;

export default function SearchBar({
  origin,
  destination,
  onOriginChange,
  onDestinationChange,
  onUseCurrentLocation,
  onPlan,
  planning,
}: Props) {
  const [field, setField] = useState<Field>(origin ? "destination" : "origin");
  const [draft, setDraft] = useState<Partial<Record<Field, string>>>({});
  const [results, setResults] = useState<Place[]>([]);
  const [status, setStatus] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [locating, setLocating] = useState(false);
  const [focused, setFocused] = useState(false);
  const locationIntent = useRef(0);
  const request = useRef<AbortController | null>(null);
  const destinationInput = useRef<HTMLInputElement>(null);

  const endpoints = { origin, destination };
  const value = (key: Field) => draft[key] ?? endpoints[key]?.label ?? "";
  const activeQuery = draft[field];

  useEffect(() => {
    request.current?.abort();
    request.current = null;

    const query = activeQuery?.trim() ?? "";
    if (!query) return;

    const controller = new AbortController();
    request.current = controller;
    const timer = window.setTimeout(async () => {
      try {
        const places = await suggestPlaces(
          query,
          MAPBOX_TOKEN,
          field === "destination" ? origin ?? undefined : undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setResults(places);
        setStatus("done");
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "目前無法搜尋地點，請稍後再試。");
        setStatus("error");
      }
    }, SEARCH_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [activeQuery, field, origin]);

  useEffect(() => () => { request.current?.abort(); locationIntent.current++; }, []);

  function activate(key: Field, input: HTMLInputElement) {
    setFocused(true);
    if (field !== key) {
      request.current?.abort();
      setResults([]);
      setError("");
      setStatus(draft[key]?.trim() ? "searching" : "idle");
    }
    setField(key);
    if (endpoints[key] && draft[key] === undefined) input.select();
  }

  function change(key: Field, text: string) {
    locationIntent.current++;
    request.current?.abort();
    setField(key);
    setResults([]);
    setError("");
    setStatus(text.trim() ? "searching" : "idle");
    if (key === "origin") {
      if (origin) onOriginChange(null);
      if (destination) onDestinationChange(null);
      setDraft((current) => ({ ...current, origin: text, destination: undefined }));
    } else {
      setDraft((current) => ({ ...current, destination: text }));
      if (destination) onDestinationChange(null);
    }
  }

  function pick(place: Place) {
    const endpoint: Endpoint = { label: place.name, lng: place.lng, lat: place.lat };
    selectEndpoint(endpoint, field);
  }

  function selectEndpoint(endpoint: Endpoint, target: Field) {
    locationIntent.current++;
    request.current?.abort();
    setResults([]);
    setStatus("idle");
    setError("");
    setFocused(false);
    (document.activeElement as HTMLElement | null)?.blur();

    if (target === "origin") {
      onOriginChange(endpoint);
      setDraft((current) => ({ ...current, origin: undefined }));
      setField("destination");
      return;
    }

    onDestinationChange(endpoint);
    setDraft((current) => ({ ...current, destination: undefined }));
    if (origin) onPlan(origin, endpoint);
  }

  function clear(key: Field) {
    locationIntent.current++;
    request.current?.abort();
    setResults([]);
    setStatus("idle");
    setError("");
    setFocused(true);
    setDraft((current) => ({ ...current, [key]: "" }));
    if (key === "origin") {
      onOriginChange(null);
      onDestinationChange(null);
      setDraft({ origin: "", destination: undefined });
      setField("origin");
    } else {
      onDestinationChange(null);
      setField("destination");
      window.requestAnimationFrame(() => destinationInput.current?.focus());
    }
  }

  async function handleCurrentLocation(previewFromHere = false) {
    if (locating || planning) return;
    const intent = ++locationIntent.current;
    const target = field;
    const selectedPlace = origin;
    setLocating(true);
    setError("");
    try {
      const here = await onUseCurrentLocation();
      if (intent !== locationIntent.current) return;
      if (!here) { setError("無法取得位置，請確認定位權限後再試。"); return; }
      if (previewFromHere && selectedPlace) {
        onOriginChange(here);
        onDestinationChange(selectedPlace);
        setDraft({});
        setFocused(false);
        onPlan(here, selectedPlace);
      } else {
        selectEndpoint(here, target);
      }
    } finally {
      setLocating(false);
    }
  }

  const showDestination = origin != null;
  const showResults = results.length > 0;
  const searching = status === "searching";
  const showCurrent = focused && !value(field).trim();
  const showSuggestions = focused && (showCurrent || !!activeQuery?.trim());
  const canPreviewFromHere = !!origin && !origin.isCurrentLocation && !destination && !value("destination").trim();

  return (
    <section className="home-search" aria-label="規劃路線" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    }}>
      <form onSubmit={(event) => { event.preventDefault(); if (results[0]) pick(results[0]); }}>
        <div className={`home-search-row ${field === "origin" ? "home-search-row-active" : ""}`}>
          <Search size={19} strokeWidth={2.2} aria-hidden="true" />
          <label>
            <span className="sr-only">搜尋起點</span>
            <input
              value={value("origin")}
              onChange={(event) => change("origin", event.target.value)}
              onFocus={(event) => activate("origin", event.target)}
              placeholder="搜尋地點"
              autoComplete="off"
              enterKeyHint="search"
              role="combobox"
              aria-expanded={field === "origin" && showSuggestions}
              aria-controls="home-place-results"
            />
          </label>
          {field === "origin" && searching && <LoaderCircle size={18} className="spin" aria-label="搜尋中" />}
          {value("origin") && !searching && (
            <button type="button" className="home-search-clear" onClick={() => clear("origin")} aria-label="清除出發地點">
              <X size={17} />
            </button>
          )}
        </div>

        {showDestination && (
          <div className={`home-search-row home-destination-row ${field === "destination" ? "home-search-row-active" : ""}`}>
            <MapPin size={19} strokeWidth={2.2} aria-hidden="true" />
            <label>
              <span className="sr-only">搜尋目的地</span>
              <input
                ref={destinationInput}
                value={value("destination")}
                onChange={(event) => change("destination", event.target.value)}
                onFocus={(event) => activate("destination", event.target)}
                placeholder="選擇目的地"
                autoComplete="off"
                enterKeyHint="search"
                role="combobox"
                aria-expanded={field === "destination" && showSuggestions}
                aria-controls="home-place-results"
              />
            </label>
            {field === "destination" && searching && <LoaderCircle size={18} className="spin" aria-label="搜尋中" />}
            {value("destination") && !searching && (
              <button type="button" className="home-search-clear" onClick={() => clear("destination")} aria-label="清除目的地">
                <X size={17} />
              </button>
            )}
          </div>
        )}
      </form>

      {showSuggestions && (
        <div className="home-search-results" id="home-place-results" role="listbox" aria-label={`${field === "origin" ? "出發地" : "目的地"}搜尋建議`}>
          {showCurrent && <button type="button" className="home-result" role="option" aria-selected="false" disabled={locating} onClick={() => void handleCurrentLocation()}>
            <span className="home-result-icon">{locating ? <LoaderCircle size={17} className="spin" /> : <LocateFixed size={17} />}</span>
            <span className="home-result-copy"><strong>{locating ? "正在取得位置…" : "現在的位置"}</strong></span>
          </button>}
          {showResults && results.map((place) => (
            <button type="button" className="home-result" key={place.id} onClick={() => pick(place)} role="option">
              <span className="home-result-icon"><MapPin size={17} /></span>
              <span className="home-result-copy">
                <strong>{place.name}</strong>
                <small>{place.address}</small>
              </span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          ))}
          {status === "done" && !showCurrent && !showResults && <p className="home-search-message">找不到符合的地點，請換個名稱或加入縣市。</p>}
          {error && <p className="home-search-message home-search-error" role="alert">{error}</p>}
          {showResults && (
            <p className="home-search-attribution">
              {results.some((place) => place.source === "photon" || place.source === "osm")
                ? <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
                : <a href="https://www.mapbox.com/about/maps" target="_blank" rel="noreferrer">© Mapbox</a>}
            </p>
          )}
        </div>
      )}

      {canPreviewFromHere && createPortal(<section className="quick-start-panel" aria-label="從現在的位置規劃路線">
        <div className="quick-start-copy"><strong>{origin.label}</strong><span>從現在的位置出發</span></div>
        {error && !focused && <p className="home-search-error" role="alert">{error}</p>}
        <button type="button" className="btn btn-dark" disabled={locating || planning} onClick={() => void handleCurrentLocation(true)}>
          {locating ? <LoaderCircle size={18} className="spin" /> : <Route size={18} />} {locating ? "正在定位…" : "查看路線"}
        </button>
      </section>, document.body)}

      {planning && (
        <div className="home-planning-status" role="status">
          <LoaderCircle size={16} className="spin" />正在規劃路線…
        </div>
      )}
    </section>
  );
}
