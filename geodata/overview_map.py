#!/usr/bin/env python3
"""把 geodata/output/dieturn_points.geojson 全部畫在一張 Mapbox 靜態底圖上,輸出全台北總覽 PNG。

底圖用 Static Images API 抓一張(不帶 overlay,避免 URL 太長),點位自己用 Web Mercator 算像素位置畫上去。
token 從環境變數 MAPBOX_TOKEN 讀。
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
COLOR = {"auto": (34, 211, 238), "review": (245, 158, 11)}


def merc(lon: float, lat: float) -> tuple[float, float]:
    x = (lon + 180) / 360
    y = (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2
    return x, y


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--points", type=Path, default=ROOT / "geodata/output/dieturn_points.geojson")
    ap.add_argument("--out", type=Path, default=ROOT / "geodata/output/overview_taipei.png")
    ap.add_argument("--style", default="dark-v11")
    ap.add_argument("--size", type=int, default=1280, help="CSS px,實際輸出 @2x")
    ap.add_argument("--zoom", type=float, default=0, help="0 = 自動貼合資料範圍")
    args = ap.parse_args()
    token = os.environ.get("MAPBOX_TOKEN") or exit("請設定 MAPBOX_TOKEN")

    fc = json.loads(args.points.read_text())
    pts = [(f["geometry"]["coordinates"], f["properties"]["status"]) for f in fc["features"]]
    lons = [p[0][0] for p in pts]
    lats = [p[0][1] for p in pts]
    clon, clat = (min(lons) + max(lons)) / 2, (min(lats) + max(lats)) / 2

    # 自動縮放:讓資料範圍佔畫面 90%
    zoom = args.zoom
    if not zoom:
        x0, y0 = merc(min(lons), max(lats))
        x1, y1 = merc(max(lons), min(lats))
        span = max(x1 - x0, y1 - y0)  # 世界座標 0~1
        zoom = math.log2(0.9 * args.size / (512 * span))
        zoom = math.floor(zoom * 10) / 10

    url = (
        f"https://api.mapbox.com/styles/v1/mapbox/{args.style}/static/"
        f"{clon:.6f},{clat:.6f},{zoom},0/{args.size}x{args.size}@2x?access_token={token}&logo=false"
    )
    resp = requests.get(url, timeout=60)
    resp.raise_for_status()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.out.with_suffix(".base.png")
    tmp.write_bytes(resp.content)
    img = Image.open(tmp).convert("RGBA")
    tmp.unlink()

    W = img.width  # = size*2
    scale = 512 * (2**zoom) * 2  # 世界座標 -> 輸出像素
    cx, cy = merc(clon, clat)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    r = 5
    # 先畫 review 再畫 auto,讓高信心的在上層
    for (lon, lat), status in sorted(pts, key=lambda p: p[1] == "auto"):
        mx, my = merc(lon, lat)
        px = W / 2 + (mx - cx) * scale
        py = W / 2 + (my - cy) * scale
        d.ellipse((px - r, py - r, px + r, py + r), fill=COLOR[status] + (230,), outline=(0, 0, 0, 200))
    img.alpha_composite(layer)

    # 圖例
    d = ImageDraw.Draw(img)
    font = ImageFont.load_default()
    # PingFang.ttc 在 PIL 載不起來,改用 Heiti TC;都沒有就退回預設(中文會變豆腐)
    for path in ("/System/Library/Fonts/STHeiti Medium.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc"):
        try:
            font = ImageFont.truetype(path, 34)
            break
        except OSError:
            continue
    n_auto = sum(1 for _, s in pts if s == "auto")
    n_rev = len(pts) - n_auto
    lines = [("auto", f"自動接受 (conf ≥ 0.8): {n_auto}"), ("review", f"待複核 (0.5–0.8): {n_rev}")]
    box_h = 60 * len(lines) + 70
    d.rectangle((30, 30, 700, 30 + box_h), fill=(17, 24, 39, 220))
    d.text((50, 45), f"台北市待轉格 · 共 {len(pts)} 個", fill=(229, 231, 235), font=font)
    for i, (s, txt) in enumerate(lines):
        y = 110 + i * 60
        d.ellipse((50, y + 8, 78, y + 36), fill=COLOR[s])
        d.text((95, y), txt, fill=(229, 231, 235), font=font)
    img.convert("RGB").save(args.out, quality=92)
    print(f"zoom={zoom}  center=({clat:.5f},{clon:.5f})  -> {args.out}")


if __name__ == "__main__":
    main()
