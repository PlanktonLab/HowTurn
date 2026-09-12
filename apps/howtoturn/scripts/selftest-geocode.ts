/** Offline regression checks. No requests leave this process. */
import assert from "node:assert/strict";
import { searchPlaces, suggestPlaces } from "../src/lib/geocode";

const originalFetch = globalThis.fetch;
const calls: Array<{ url: URL; at: number }> = [];
let reply: (url: URL, init?: RequestInit) => Promise<Response> = async () => Response.json([]);
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push({ url, at: Date.now() });
  return reply(url, init);
};
const osm = (name: string, id = 1) => ({ osm_type: "node", osm_id: id, name, display_name: `${name}, 信義區, 臺灣`, lon: "121.5654", lat: "25.0330" });
const assertAborted = (promise: Promise<unknown>) => assert.rejects(promise, (error: unknown) => error instanceof Error && error.name === "AbortError");

try {
  assert.deepEqual(await searchPlaces("  "), []);
  assert.equal(calls.length, 0, "blank input must not contact a provider");

  reply = async () => Response.json([osm("台北101"), osm("台北101", 2), { ...osm("壞座標", 3), lon: "121.5junk" }, { ...osm("越界", 4), lat: "91" }]);
  const places = await searchPlaces(" 台北101 ");
  assert.equal(places.length, 1, "duplicates and invalid points are discarded");
  assert.equal(places[0].source, "osm");
  assert.equal(places[0].address, "信義區");
  assert.equal(calls[0].url.searchParams.get("accept-language"), "zh-TW");
  places[0].name = "caller mutation";
  assert.equal((await searchPlaces("台北101"))[0].name, "台北101", "cache must not share mutable Place objects");
  assert.equal(calls.length, 1, "same query should use the cache");

  reply = async () => Response.json([]);
  assert.deepEqual(await searchPlaces("不存在的地點"), []);
  assert.equal(calls.length, 2, "missing Mapbox token must not trigger fallback");
  assert.ok(calls[1].at - calls[0].at >= 995, "OSM request starts must be spaced one second apart");

  reply = async (url) => url.host.includes("mapbox")
    ? Response.json({ features: [{ id: "poi.one", text: "車站", place_name: "車站, 台北, 台灣", center: [121.5, 25] }] })
    : Response.json([]);
  const fallback = await searchPlaces("Mapbox fallback", "test-token", { lng: 121.5, lat: 25 });
  assert.equal(fallback[0].source, "mapbox");
  assert.equal(calls.at(-1)!.url.searchParams.get("autocomplete"), "false");
  assert.equal(calls.at(-1)!.url.searchParams.get("proximity"), "121.5,25");

  reply = async (url) => url.host.includes("photon")
    ? Response.json({ type: "FeatureCollection", features: [{ properties: { osm_type: "W", osm_id: 5, name: "師大", street: "和平東路", district: "大安區", city: "臺北市" }, geometry: { type: "Point", coordinates: [121.529, 25.026] } }] })
    : Response.json({ features: [] });
  const callCountBeforeSuggestion = calls.length;
  const suggestions = await suggestPlaces(" 師 大 ", "test-token", { lng: 121.5, lat: 25 });
  assert.equal(suggestions[0].name, "師大");
  assert.equal(suggestions[0].source, "photon");
  assert.equal(suggestions[0].address, "和平東路、大安區、臺北市");
  assert.equal(calls.length, callCountBeforeSuggestion + 1, "a successful Photon suggestion must not call a fallback");
  assert.equal(calls.at(-1)!.url.host, "photon.komoot.io");
  assert.equal(calls.at(-1)!.url.searchParams.get("q"), "師 大");
  assert.equal(calls.at(-1)!.url.searchParams.get("countrycode"), "TW");
  assert.equal(calls.at(-1)!.url.searchParams.get("lon"), "121.5");
  assert.equal(calls.at(-1)!.url.searchParams.get("lat"), "25");

  reply = async (url) => url.host.includes("photon")
    ? Response.json({ type: "FeatureCollection", features: [] })
    : Response.json({ features: [{ id: "address.live", text: "忠孝東路", place_name: "忠孝東路, 台北, 台灣", center: [121.54, 25.04] }] });
  const fallbackSuggestions = await suggestPlaces("忠孝東路", "test-token", { lng: 121.5, lat: 25 });
  assert.equal(fallbackSuggestions[0].source, "mapbox");
  assert.equal(calls.at(-1)!.url.host, "api.mapbox.com");
  assert.equal(calls.at(-1)!.url.searchParams.get("autocomplete"), "true");
  assert.equal(calls.at(-1)!.url.searchParams.get("proximity"), "121.5,25");

  reply = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(searchPlaces("service failure"), /無法連線/, "service failure cannot appear as no matches");
  reply = async () => Response.json({ broken: true });
  await assert.rejects(searchPlaces("malformed response"), /無法連線/);
  reply = async () => Response.json([{ ...osm("invalid"), lat: null }]);
  await assert.rejects(searchPlaces("all invalid coordinates"), /無法連線/);

  const cancelled = new AbortController();
  cancelled.abort();
  const beforeCancel = calls.length;
  await assertAborted(searchPlaces("台北101", undefined, undefined, cancelled.signal));
  assert.equal(calls.length, beforeCancel, "aborted cached searches must not produce results");

  const inFlight = new AbortController();
  reply = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    inFlight.abort();
  });
  await assertAborted(searchPlaces("cancel request", "test-token", undefined, inFlight.signal));
  assert.equal(calls.at(-1)!.url.host, "nominatim.openstreetmap.org", "cancel must not fall through to Mapbox");

  reply = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  await assert.rejects(searchPlaces("timeout"), /逾時/);
  console.log("geocode selftest: cache, provider fallback, coordinate validation, throttling, errors, cancellation and timeout passed");
} finally {
  globalThis.fetch = originalFetch;
}
