export interface Place {
  id: string;
  name: string;
  address: string;
  lng: number;
  lat: number;
}

/**
 * Place search for the destination field.
 *
 * Mapbox's geocoder is poor at Taiwanese Chinese POI names — "台北101"
 * resolves to street numbers in 三峽/花蓮 rather than the tower — so OSM's
 * Nominatim is the primary source (it returns the right answer for 台北101,
 * 台北車站, 師大夜市, 桃園機場) with Mapbox kept as a fallback. Both run
 * straight from the browser; there is no backend of ours in the path.
 *
 * Nominatim asks callers not to fire a request per keystroke, so the caller
 * debounces (see SearchSheet) and the browser's own Referer header identifies
 * the app. A production deployment should move to a self-hosted Nominatim or
 * a paid geocoder — noted in app/README.md.
 */
export async function searchPlaces(
  query: string,
  mapboxToken: string,
  proximity?: { lng: number; lat: number }
): Promise<Place[]> {
  if (!query.trim()) return [];
  const viaOsm = await searchNominatim(query).catch(() => []);
  if (viaOsm.length) return viaOsm;
  return searchMapbox(query, mapboxToken, proximity).catch(() => []);
}

async function searchNominatim(query: string): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "6",
    countrycodes: "tw",
    "accept-language": "zh-TW",
    addressdetails: "1",
  });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data as any[]).map((r): Place => {
    const parts: string[] = String(r.display_name ?? "").split(",").map((s) => s.trim());
    return {
      id: `osm-${r.osm_type}-${r.osm_id}`,
      name: r.name || parts[0] || query,
      address: parts.slice(1).filter((p) => p && p !== "臺灣").join("").slice(0, 40),
      lng: parseFloat(r.lon),
      lat: parseFloat(r.lat),
    };
  });
}

async function searchMapbox(
  query: string,
  token: string,
  proximity?: { lng: number; lat: number }
): Promise<Place[]> {
  const params = new URLSearchParams({
    country: "TW",
    language: "zh-Hant",
    limit: "6",
    access_token: token,
  });
  if (proximity) params.set("proximity", `${proximity.lng},${proximity.lat}`);

  const res = await fetch(
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${params}`
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.features ?? []).map((f: any): Place => {
    const full: string = f.place_name ?? "";
    return {
      id: f.id ?? full,
      name: f.text ?? full,
      address: full.split(",").slice(1).join(",").replace(/,\s*台灣$/, "").trim() || full,
      lng: f.center[0],
      lat: f.center[1],
    };
  });
}

/** Single best match — used when a query must resolve straight to a point. */
export async function geocode(query: string, token: string): Promise<Place | null> {
  const results = await searchPlaces(query, token);
  return results[0] ?? null;
}

export function getCurrentPosition(): Promise<{ lng: number; lat: number }> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("此裝置不支援定位"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
      () => reject(new Error("無法取得目前位置")),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}
