import { getCurrentFix } from "./location";

export interface Place {
  id: string;
  name: string;
  address: string;
  lng: number;
  lat: number;
  source?: "osm" | "photon" | "mapbox";
}

type Proximity = { lng: number; lat: number };
type JsonRecord = Record<string, unknown>;

const REQUEST_TIMEOUT_MS = 8000;
const OSM_INTERVAL_MS = 1000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_LIMIT = 100;
const osmCache = new Map<string, { at: number; places: Place[] }>();
let osmQueue: Promise<void> = Promise.resolve();
let lastOsmRequestAt = 0;

declare global {
  interface Window {
    __HOWTURN_CONFIG__?: { nominatimEndpoint?: string; photonEndpoint?: string };
  }
}

function abortError() {
  return new DOMException("搜尋已取消", "AbortError");
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validPoint(lng: number, lat: number) {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

function uniquePlaces(places: Place[]) {
  const ids = new Set<string>();
  const points = new Set<string>();
  return places.filter((place) => {
    if (!validPoint(place.lng, place.lat)) return false;
    const point = `${place.name}:${place.lng.toFixed(5)},${place.lat.toFixed(5)}`;
    if (ids.has(place.id) || points.has(point)) return false;
    ids.add(place.id);
    points.add(point);
    return true;
  });
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// Serialize request starts. This is a client-side guard; a shared production
// proxy must enforce Nominatim's application-wide limit across all users.
async function reserveOsmRequest(signal?: AbortSignal) {
  const turn = osmQueue.then(async () => {
    checkAbort(signal);
    const delay = OSM_INTERVAL_MS - (Date.now() - lastOsmRequestAt);
    if (delay > 0) await pause(delay, signal);
    checkAbort(signal);
    lastOsmRequestAt = Date.now();
  });
  osmQueue = turn.catch(() => undefined);
  await turn;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  checkAbort(signal);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json: unknown = await response.json();
    checkAbort(signal);
    return json;
  } catch (error) {
    checkAbort(signal);
    if (timedOut) throw new Error("地點搜尋逾時，請再試一次");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Explicit, user-submitted place search. Nominatim handles Traditional
 * Chinese POIs, with Mapbox as an optional fallback. Pass a signal and abort
 * it when the query changes or the search UI closes.
 */
export async function searchPlaces(
  query: string,
  mapboxToken?: string,
  proximity?: Proximity,
  signal?: AbortSignal
): Promise<Place[]> {
  checkAbort(signal);
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  let failure: unknown;
  try {
    const places = await searchNominatim(normalized, signal);
    if (places.length) return places;
  } catch (error) {
    checkAbort(signal);
    failure = error;
  }
  if (mapboxToken?.trim()) {
    try {
      const places = await searchMapbox(normalized, mapboxToken, proximity, signal, false);
      if (places.length) return places;
    } catch (error) {
      checkAbort(signal);
      failure = error;
    }
  }
  checkAbort(signal);
  if (failure) {
    if (failure instanceof Error && failure.message.includes("逾時")) throw failure;
    throw new Error("無法連線至地點搜尋服務，請檢查網路後重試");
  }
  return [];
}

async function searchNominatim(query: string, signal?: AbortSignal): Promise<Place[]> {
  const endpoint = (typeof window !== "undefined" && window.__HOWTURN_CONFIG__?.nominatimEndpoint)
    || import.meta.env?.VITE_NOMINATIM_URL
    || "https://nominatim.openstreetmap.org/search";
  const key = `${endpoint}:${query.toLocaleLowerCase("zh-TW")}`;
  const cached = osmCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.places.map((place) => ({ ...place }));
  await reserveOsmRequest(signal);
  const url = new URL(endpoint, typeof window !== "undefined" ? window.location.href : undefined);
  const params = { q: query, format: "jsonv2", limit: "6", countrycodes: "tw", "accept-language": "zh-TW", addressdetails: "1" };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  const data = await fetchJson(url.toString(), signal);
  if (!Array.isArray(data)) throw new Error("地點搜尋服務回傳格式錯誤");
  const places = uniquePlaces(data.filter(isRecord).map((r): Place => {
    const parts = String(r.display_name ?? "").split(",").map((part) => part.trim());
    return {
      id: `osm-${r.osm_type ?? "place"}-${r.osm_id ?? r.place_id ?? `${r.lon},${r.lat}`}`,
      name: String(r.name || parts[0] || query),
      address: parts.slice(1).filter((part) => part && part !== "臺灣" && part !== "台灣").join(""),
      lng: typeof r.lon === "string" && r.lon.trim() ? Number(r.lon) : typeof r.lon === "number" ? r.lon : NaN,
      lat: typeof r.lat === "string" && r.lat.trim() ? Number(r.lat) : typeof r.lat === "number" ? r.lat : NaN,
      source: "osm",
    };
  }));
  if (data.length && !places.length) throw new Error("地點搜尋服務回傳無效座標");
  if (osmCache.size >= CACHE_LIMIT) osmCache.delete(osmCache.keys().next().value!);
  osmCache.set(key, { at: Date.now(), places });
  return places.map((place) => ({ ...place }));
}

/** Debounced type-ahead suggestions for place names and addresses. */
export async function suggestPlaces(
  query: string,
  mapboxToken?: string,
  proximity?: Proximity,
  signal?: AbortSignal,
): Promise<Place[]> {
  checkAbort(signal);
  const normalized = query.trim().replace(/\s+/g, " ");
  if (!normalized) return [];
  let failure: unknown;
  try {
    const places = await searchPhoton(normalized, proximity, signal);
    if (places.length) return places;
  } catch (error) {
    checkAbort(signal);
    failure = error;
  }
  if (mapboxToken?.trim()) {
    try {
      return await searchMapbox(normalized, mapboxToken, proximity, signal, true);
    } catch (error) {
      checkAbort(signal);
      failure = error;
    }
  }
  if (failure) throw new Error("無法連線至地點搜尋服務，請檢查網路後重試");
  return [];
}

async function searchPhoton(query: string, proximity?: Proximity, signal?: AbortSignal): Promise<Place[]> {
  const endpoint = (typeof window !== "undefined" && window.__HOWTURN_CONFIG__?.photonEndpoint)
    || import.meta.env?.VITE_PHOTON_URL
    || "https://photon.komoot.io/api/";
  const url = new URL(endpoint, typeof window !== "undefined" ? window.location.href : undefined);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "6");
  url.searchParams.set("countrycode", "TW");
  if (proximity && validPoint(proximity.lng, proximity.lat)) {
    url.searchParams.set("lon", String(proximity.lng));
    url.searchParams.set("lat", String(proximity.lat));
    url.searchParams.set("zoom", "13");
  }
  const data = await fetchJson(url.toString(), signal);
  if (!isRecord(data) || !Array.isArray(data.features)) throw new Error("地點搜尋服務回傳格式錯誤");
  const places = uniquePlaces(data.features.filter(isRecord).map((feature): Place => {
    const properties = isRecord(feature.properties) ? feature.properties : {};
    const geometry = isRecord(feature.geometry) ? feature.geometry : {};
    const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
    const street = [properties.street, properties.housenumber].filter(Boolean).map(String).join(" ");
    const parts = [street, properties.district, properties.city, properties.postcode]
      .filter(Boolean).map(String).filter((part, index, all) => all.indexOf(part) === index);
    const name = String(properties.name || street || query);
    return {
      id: `photon-${properties.osm_type ?? "place"}-${properties.osm_id ?? `${coordinates[0]},${coordinates[1]}`}`,
      name,
      address: parts.filter((part) => part !== name).join("、") || name,
      lng: typeof coordinates[0] === "number" ? coordinates[0] : NaN,
      lat: typeof coordinates[1] === "number" ? coordinates[1] : NaN,
      source: "photon",
    };
  }));
  if (data.features.length && !places.length) throw new Error("地點搜尋服務回傳無效座標");
  return places;
}

async function searchMapbox(
  query: string,
  token: string,
  proximity?: Proximity,
  signal?: AbortSignal,
  autocomplete = false,
): Promise<Place[]> {
  const params = new URLSearchParams({
    country: "TW", language: "zh-Hant", limit: "6", autocomplete: String(autocomplete), access_token: token,
  });
  if (proximity && validPoint(proximity.lng, proximity.lat)) params.set("proximity", `${proximity.lng},${proximity.lat}`);
  const data = await fetchJson(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`, signal);
  if (!isRecord(data) || !Array.isArray(data.features)) throw new Error("地點搜尋服務回傳格式錯誤");
  const places = uniquePlaces(data.features.filter(isRecord).map((f): Place => {
    const full = String(f.place_name ?? "");
    const center = Array.isArray(f.center) ? f.center : [];
    return {
      id: String(f.id ?? full),
      name: String(f.text ?? full),
      address: full.split(",").slice(1).join(",").replace(/,\s*台灣$/, "").trim() || full,
      lng: typeof center[0] === "number" ? center[0] : NaN,
      lat: typeof center[1] === "number" ? center[1] : NaN,
      source: "mapbox",
    };
  }));
  if (data.features.length && !places.length) throw new Error("地點搜尋服務回傳無效座標");
  return places;
}

/** Single best match — used when a query must resolve straight to a point. */
export async function geocode(query: string, token?: string, signal?: AbortSignal): Promise<Place | null> {
  const results = await searchPlaces(query, token, undefined, signal);
  return results[0] ?? null;
}

export async function getCurrentPosition(): Promise<{ lng: number; lat: number }> {
  const { lng, lat } = await getCurrentFix();
  return { lng, lat };
}
