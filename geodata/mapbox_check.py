#!/usr/bin/env python3
"""把某張圖的偵測框轉成 WGS84,疊在 Mapbox 衛星圖上輸出 PNG,用來驗證定位。

token 從環境變數 MAPBOX_TOKEN 讀,不落地。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import os
import urllib.parse

import requests  # 自帶 certifi,避開 python.org 版 Python 沒有系統 CA 的問題
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
Z = 21  # 圖資瓦片層級


def px2ll(rec: dict, px: float, py: float) -> tuple[float, float]:
    n = 2**Z
    X = int(rec["tile_x0"]) + px / 256
    Y = int(rec["tile_y0"]) + py / 256
    lon = X / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * Y / n))))
    return round(lon, 7), round(lat, 7)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("image_ids", nargs="+", help="例如 TPS_00171")
    ap.add_argument("--detections", type=Path, default=ROOT / "ml/runs/predict_taipei_full/detections.csv")
    ap.add_argument("--index", type=Path, default=ROOT / "imagery/taipei_z21/index.csv")
    ap.add_argument("--out", type=Path, default=ROOT / "geodata/output/mapbox_check")
    ap.add_argument("--zoom", type=float, default=19.5)
    ap.add_argument("--size", default="1000x1000")
    ap.add_argument("--style", default="satellite-v9")
    args = ap.parse_args()

    token = os.environ.get("MAPBOX_TOKEN")
    if not token:
        raise SystemExit("請設定環境變數 MAPBOX_TOKEN")

    idx = {r["id"]: r for r in csv.DictReader(args.index.open())}
    dets: dict[str, list[dict]] = {}
    for r in csv.DictReader(args.detections.open()):
        dets.setdefault(r["image"][:-4], []).append(r)
    args.out.mkdir(parents=True, exist_ok=True)

    for img_id in args.image_ids:
        rec = idx[img_id]
        feats = []
        for r in dets.get(img_id, []):
            pts = [tuple(map(float, p.split(","))) for p in r["corners"].split(";")]
            ring = [px2ll(rec, x, y) for x, y in pts]
            ring.append(ring[0])
            feats.append(
                {
                    "type": "Feature",
                    # simplestyle-spec,Static API 會照這些畫
                    "properties": {"stroke": "#00ffff", "stroke-width": 3, "fill-opacity": 0},
                    "geometry": {"type": "Polygon", "coordinates": [ring]},
                }
            )
        # 圖片中心點(路口)畫個十字準星當參考
        feats.append(
            {
                "type": "Feature",
                "properties": {"marker-color": "#ff0000", "marker-size": "small"},
                "geometry": {"type": "Point", "coordinates": [float(rec["lon"]), float(rec["lat"])]},
            }
        )
        gj = json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":"))
        overlay = "geojson(" + urllib.parse.quote(gj, safe="") + ")"
        url = (
            f"https://api.mapbox.com/styles/v1/mapbox/{args.style}/static/{overlay}/"
            f"{rec['lon']},{rec['lat']},{args.zoom},0/{args.size}@2x?access_token={token}"
        )
        out = args.out / f"{img_id}_{args.style}_z{args.zoom}.png"
        resp = requests.get(url, headers={"User-Agent": "DieTurn-check/0.1"}, timeout=60)
        if resp.ok:
            out.write_bytes(resp.content)
            print(f"{img_id}: {len(feats) - 1} 框 -> {out}")
        else:
            print(f"{img_id}: HTTP {resp.status_code} {resp.text[:300]}")


if __name__ == "__main__":
    main()
