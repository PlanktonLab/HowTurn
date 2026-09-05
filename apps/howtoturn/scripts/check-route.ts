/**
 * CLI sanity check for the two-stage-left-turn logic against real routes.
 *   npx tsx scripts/check-route.ts "121.5288,25.0259" "121.5170,25.0478"
 * Reads the Mapbox token from .env.local and the GeoJSON from public/.
 */
import { readFileSync } from "node:fs";
import { fetchRoutes } from "../src/lib/mapboxDirections";
import { annotateLeftTurns } from "../src/lib/twoStageLeft";
import { phraseForStep, leftTurnAdvice } from "../src/lib/instructions";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const token = env.match(/VITE_MAPBOX_TOKEN=(\S+)/)?.[1];
if (!token) throw new Error("no token in .env.local");

const zones = JSON.parse(readFileSync(new URL("../public/geojson/taipei_waiting_zones.geojson", import.meta.url), "utf8"));
const surveyed = JSON.parse(readFileSync(new URL("../public/geojson/taipei_surveyed_intersections.geojson", import.meta.url), "utf8"));

const [a, b] = process.argv.slice(2);
const parse = (s: string) => { const [lng, lat] = s.split(",").map(Number); return { lng, lat }; };
const origin = parse(a ?? "121.5288,25.0259");
const dest = parse(b ?? "121.5170,25.0478");

const routes = await fetchRoutes(origin, dest, "motorcycle", token);
routes.forEach((r, ri) => {
  console.log(`\n=== route ${ri}: ${r.distanceKm} km, ${r.durationMin} min, ${r.steps.length} steps, congestion=${r.congestion.length} maxspeed=${r.maxspeedKph.filter(Boolean).length}`);
  const lts = annotateLeftTurns(r, { zones, surveyed });
  r.steps.forEach((s, i) => {
    const lt = lts.find((l) => l.stepIndex === i);
    const lanes = s.lanes ? ` lanes=[${s.lanes.map((l) => `${l.valid ? "*" : ""}${l.indications.join("|")}`).join(" ")}]`: "";
    const tag = lt ? `  <-- ${lt.status.toUpperCase()} ${lt.zone ? lt.zone.properties.id + " " + lt.zone.properties.corner + " q=" + lt.zone.properties.serves_quality : ""} | ${leftTurnAdvice(lt).short}` : "";
    console.log(`${String(i).padStart(2)} ${s.maneuverType.padEnd(12)} ${(s.modifier ?? "").padEnd(12)} ${Math.round(s.bearingBefore).toString().padStart(3)}→${Math.round(s.bearingAfter).toString().padStart(3)} ${s.location.map((c) => c.toFixed(5)).join(",")} ${phraseForStep(s, lt)}${lanes}${tag}`);
  });
});
