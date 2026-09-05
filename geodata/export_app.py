#!/usr/bin/env python3
"""把 geodata/output 的成品匯出成 apps/howtoturn 導航 App 讀的兩個 GeoJSON。

  apps/howtoturn/public/geojson/taipei_waiting_zones.geojson
      1344 個待轉格多邊形。屬性精簡成 App 需要的欄位(去掉像素框等稽核用資料)。
  apps/howtoturn/public/geojson/taipei_surveyed_intersections.geojson
      2556 個有航拍圖的路口中心點。App 用它判斷「這個路口我們看過了但沒有待轉格」
      (可直接左轉)與「這個路口不在航拍範圍」(無資料,不敢說可直接左轉)。

重跑 build_geodata.py 之後再跑這支,App 資料就同步。
"""
from __future__ import annotations

import csv
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "geodata/output/dieturn.geojson"
POINTS = ROOT / "imagery/points_taipei_z21.csv"
INDEX = ROOT / "imagery/taipei_z21/index.csv"
OUT_DIR = ROOT / "apps/howtoturn/public/geojson"

KEEP = (
    "id", "status", "conf", "n_detections", "heading_deg", "length_m", "width_m",
    "corner", "intersection_id", "intersection_dist_m",
    "serves_from_bearing", "serves_to_bearing", "serves_quality", "lat", "lon",
)


def main() -> None:
    src = json.loads(SRC.read_text())
    summary = json.loads((ROOT / "geodata/output/summary.json").read_text())
    today = date.today().isoformat()
    source = f"dieturn/{summary['model_version']}@{summary['imagery_source']}"

    zones = []
    for f in src["features"]:
        p = f["properties"]
        props = {k: p[k] for k in KEEP}
        props["confidence"] = "confirmed" if p["status"] == "auto" else "probable"
        props["source"] = source
        props["source_updated_at"] = today
        zones.append({"type": "Feature", "id": p["id"], "properties": props, "geometry": f["geometry"]})

    ok_images = {r["id"] for r in csv.DictReader(INDEX.open()) if r["status"] == "ok"}
    surveyed = []
    for r in csv.DictReader(POINTS.open()):
        if r["id"] not in ok_images:
            continue
        surveyed.append({
            "type": "Feature",
            "id": r["id"],
            "properties": {"id": r["id"], "n_nodes": int(r["n_nodes"])},
            "geometry": {"type": "Point", "coordinates": [float(r["lon"]), float(r["lat"])]},
        })

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "taipei_waiting_zones.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": zones}, ensure_ascii=False, separators=(",", ":"))
    )
    (OUT_DIR / "taipei_surveyed_intersections.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": surveyed}, ensure_ascii=False, separators=(",", ":"))
    )
    print(f"waiting zones: {len(zones)}  surveyed intersections: {len(surveyed)}  -> {OUT_DIR}")


if __name__ == "__main__":
    main()
