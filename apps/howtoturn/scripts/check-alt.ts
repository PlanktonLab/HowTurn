/** Debug: how many alternatives Mapbox gives and what midpoint detours look like. */
import { readFileSync } from "node:fs";
import along from "@turf/along";
import { feature } from "@turf/helpers";
import { fetchRoutes } from "../src/lib/mapboxDirections";
import { generateDetourRoutes } from "../src/lib/alternativeRoute";

const token = readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/VITE_MAPBOX_TOKEN=(\S+)/)![1];
const parse = (s: string) => { const [lng, lat] = s.split(",").map(Number); return { lng, lat }; };
const o = parse(process.argv[2] ?? "121.5262,25.0936");
const d = parse(process.argv[3] ?? "121.5200,25.0823");
const routes = await fetchRoutes(o, d, "motorcycle", token);
const ut = (r: { steps: { modifier?: string }[] }) => r.steps.filter((s) => s.modifier === "uturn").length;
console.log("api routes:", routes.map((r) => `${r.distanceKm}km/${r.durationMin}min/${r.geometry.coordinates.length}pts uturns=${ut(r)}`));
const base = routes[0];
const mid = along(feature(base.geometry), base.distanceKm / 2, { units: "kilometers" }).geometry.coordinates as [number, number];
const overlap = (a: number[][], b: number[][]) => { const set = new Set(a.map((c) => c.join(","))); return b.filter((c) => set.has(c.join(","))).length / b.length; };
for (const off of [120, 250, 350]) {
  const det = await generateDetourRoutes(o, d, base, [mid], "motorcycle", token, off);
  console.log(`offset ${off}m:`, det.map((r) => `${r.distanceKm}km/${r.durationMin}min overlap=${overlap(base.geometry.coordinates, r.geometry.coordinates).toFixed(2)} uturns=${ut(r)}`));
}
