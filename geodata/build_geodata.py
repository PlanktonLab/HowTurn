#!/usr/bin/env python3
"""把推論結果轉成世界座標的待轉格圖資:跨圖去重、編穩定 ID、輸出 GeoJSON。

輸入: ml/runs/<predict>/detections.csv(像素框) + imagery/<area>/index.csv(圖片地理定位)
輸出: geodata/output/dieturn.geojson        每筆一個真實待轉格(多邊形)
      geodata/output/dieturn_points.geojson 同上,但幾何是中心點(給地圖縮小時 cluster 用)
      geodata/output/review.csv             信心 0.5~0.8、需要人工複核的清單
      geodata/output/detections_geo.csv     每一次偵測的稽核紀錄,含歸屬的 dieturn_id
      geodata/output/summary.json           統計
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

from shapely.geometry import Polygon
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parent.parent
Z = 21  # 圖資瓦片層級
# 台北範圍的局部公制座標:以此為原點做等距圓柱投影,幾十公里內誤差可忽略
LAT0, LON0 = 25.05, 121.55
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))

AUTO_CONF = 0.80  # 以上自動接受
REVIEW_CONF = 0.50  # 以上進入複核;以下丟棄(抽查顯示幾乎全是誤報)
MERGE_IOU = 0.30  # 跨圖同一個待轉格的合併門檻
MERGE_DIST_M = 1.5


def px2ll(rec: dict, px: float, py: float) -> tuple[float, float]:
    n = 2**Z
    X = int(rec["tile_x0"]) + px / 256
    Y = int(rec["tile_y0"]) + py / 256
    lon = X / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * Y / n))))
    return lon, lat


def to_m(lon: float, lat: float) -> tuple[float, float]:
    return (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT


def to_ll(x: float, y: float) -> tuple[float, float]:
    return x / M_PER_DEG_LON + LON0, y / M_PER_DEG_LAT + LAT0


_B32 = "0123456789bcdefghjkmnpqrstuvwxyz"


def geohash(lat: float, lon: float, precision: int = 9) -> str:
    """標準 geohash;9 碼約 4.8 m × 4.8 m,當穩定 ID 用。"""
    lat_i, lon_i = [-90.0, 90.0], [-180.0, 180.0]
    bits = (16, 8, 4, 2, 1)
    out, bit, ch, even = [], 0, 0, True
    while len(out) < precision:
        interval, val = (lon_i, lon) if even else (lat_i, lat)
        mid = (interval[0] + interval[1]) / 2
        if val > mid:
            ch |= bits[bit]
            interval[0] = mid
        else:
            interval[1] = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            out.append(_B32[ch])
            bit, ch = 0, 0
    return "".join(out)


def serves_bearings(dx: float, dy: float, heading_deg: float) -> tuple[float | None, float | None, str]:
    """推算這個待轉格服務哪個方向的左轉。

    道交規則 §99:兩段式左轉「先直行至前方路口右側待轉區」。所以對「以方位 f
    進入路口」的騎士,待轉格在他的前方且右側(偏移向量落在 f 到 f+90° 的象限),
    等候時面向 e = f - 90°。
    偵測到的格子 3.3 × 2.2 m,寬大於深(並排停車),長軸是「垂直」於面向方向,
    所以 f 只能是格子軸線的四個方向之一 {h, h+90, h+180, h+270},取偏移向量落在
    其前方右側象限的那個;沒有任何一個成立(格子恰在軸線上)就取最接近的,標 ambiguous。
    dx, dy:待轉格中心相對路口中心的公制位移(東、北)。
    """
    best = None
    for k in range(4):
        from_b = (heading_deg + 90.0 * k) % 360.0
        fx, fy = math.sin(math.radians(from_b)), math.cos(math.radians(from_b))
        ahead = dx * fx + dy * fy
        right = dx * fy - dy * fx  # 右側單位向量 = (fy, -fx)
        margin = min(ahead, right)
        if best is None or margin > best[0]:
            best = (margin, from_b, ahead, right)
    assert best is not None
    from_b = best[1]
    quality = "good" if best[0] >= 2.0 else "ambiguous"
    return round(from_b, 1), round((from_b - 90.0) % 360.0, 1), quality


class UnionFind:
    def __init__(self, n: int):
        self.p = list(range(n))

    def find(self, a: int) -> int:
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[rb] = ra


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--detections", type=Path, default=ROOT / "ml/runs/predict_taipei_full/detections.csv")
    ap.add_argument("--index", type=Path, default=ROOT / "imagery/taipei_z21/index.csv")
    ap.add_argument("--out", type=Path, default=ROOT / "geodata/output")
    ap.add_argument("--model-version", default="yolo26s-obb_ep144")
    ap.add_argument("--imagery-source", default="taipei_udd_ortho_2025")
    args = ap.parse_args()

    idx = {r["id"]: r for r in csv.DictReader(args.index.open())}
    dets = []
    for r in csv.DictReader(args.detections.open()):
        conf = float(r["conf"])
        if conf < REVIEW_CONF:
            continue
        img_id = r["image"][:-4]
        rec = idx[img_id]
        px_pts = [tuple(map(float, p.split(","))) for p in r["corners"].split(";")]
        ll = [px2ll(rec, x, y) for x, y in px_pts]
        m = [to_m(*p) for p in ll]
        poly = Polygon(m)
        if not poly.is_valid or poly.area < 1.0:
            continue
        # 邊長與長軸方位角(矩形對稱,方位角取 0~180)
        d01 = math.dist(m[0], m[1])
        d12 = math.dist(m[1], m[2])
        if d01 >= d12:
            length, width, vec = d01, d12, (m[1][0] - m[0][0], m[1][1] - m[0][1])
        else:
            length, width, vec = d12, d01, (m[2][0] - m[1][0], m[2][1] - m[1][1])
        heading = math.degrees(math.atan2(vec[0], vec[1])) % 180.0
        c = poly.centroid
        dets.append(
            {
                "image": img_id,
                "conf": conf,
                "src_px": r["corners"],
                "ll": ll,
                "poly": poly,
                "cx": c.x,
                "cy": c.y,
                "length_m": length,
                "width_m": width,
                "heading_deg": heading,
            }
        )

    # --- 跨圖去重:相鄰路口的圖會重疊,同一個待轉格會被偵測多次 ---
    polys = [d["poly"] for d in dets]
    tree = STRtree(polys)
    uf = UnionFind(len(dets))
    for i, p in enumerate(polys):
        for j in tree.query(p.buffer(MERGE_DIST_M)):
            j = int(j)
            if j <= i:
                continue
            q = polys[j]
            inter = p.intersection(q).area
            iou = inter / (p.area + q.area - inter) if inter else 0.0
            cdist = math.dist((dets[i]["cx"], dets[i]["cy"]), (dets[j]["cx"], dets[j]["cy"]))
            if iou >= MERGE_IOU or cdist <= MERGE_DIST_M:
                uf.union(i, j)

    clusters: dict[int, list[int]] = defaultdict(list)
    for i in range(len(dets)):
        clusters[uf.find(i)].append(i)

    features, point_features, review_rows, det_rows = [], [], [], []
    used_ids: Counter = Counter()
    status_count: Counter = Counter()
    for members in clusters.values():
        members.sort(key=lambda k: -dets[k]["conf"])
        best = dets[members[0]]
        lon_c, lat_c = to_ll(best["cx"], best["cy"])
        # 所屬路口:成員來源圖片中,中心離這個待轉格最近的那張
        cands = {dets[k]["image"] for k in members}
        inter_id, inter_dist = min(
            ((img, math.dist((best["cx"], best["cy"]), to_m(float(idx[img]["lon"]), float(idx[img]["lat"])))) for img in cands),
            key=lambda t: t[1],
        )
        ix, iy = to_m(float(idx[inter_id]["lon"]), float(idx[inter_id]["lat"]))
        corner = ("N" if best["cy"] > iy else "S") + ("E" if best["cx"] > ix else "W")
        serves_from, serves_to, serves_quality = serves_bearings(best["cx"] - ix, best["cy"] - iy, best["heading_deg"])

        gid = "dt_" + geohash(lat_c, lon_c)
        used_ids[gid] += 1
        if used_ids[gid] > 1:
            gid = f"{gid}-{used_ids[gid]}"
        status = "auto" if best["conf"] >= AUTO_CONF else "review"
        status_count[status] += 1

        props = {
            "id": gid,
            "status": status,
            "conf": round(best["conf"], 4),
            "n_detections": len(members),
            "heading_deg": round(best["heading_deg"], 1),
            "length_m": round(best["length_m"], 2),
            "width_m": round(best["width_m"], 2),
            "corner": corner,
            "intersection_id": inter_id,
            "intersection_dist_m": round(inter_dist, 1),
            "osm_node_id": None,
            "serves_from_bearing": serves_from,
            "serves_to_bearing": serves_to,
            "serves_quality": serves_quality,
            "imagery_source": args.imagery_source,
            "model_version": args.model_version,
            "src_image": best["image"],
            "src_px": best["src_px"],
            "lat": round(lat_c, 7),
            "lon": round(lon_c, 7),
        }
        ring = [[round(x, 7), round(y, 7)] for x, y in best["ll"]]
        ring.append(ring[0])
        features.append({"type": "Feature", "id": gid, "properties": props, "geometry": {"type": "Polygon", "coordinates": [ring]}})
        point_features.append({"type": "Feature", "id": gid, "properties": props, "geometry": {"type": "Point", "coordinates": [props["lon"], props["lat"]]}})
        if status == "review":
            review_rows.append({k: props[k] for k in ("id", "conf", "lat", "lon", "intersection_id", "corner", "src_image", "n_detections")})
        for k in members:
            d = dets[k]
            det_rows.append({"dieturn_id": gid, "image": d["image"], "conf": round(d["conf"], 4), "src_px": d["src_px"], "is_representative": k == members[0]})

    features.sort(key=lambda f: -f["properties"]["conf"])
    point_features.sort(key=lambda f: -f["properties"]["conf"])
    review_rows.sort(key=lambda r: -r["conf"])

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "dieturn.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False))
    (args.out / "dieturn_points.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": point_features}, ensure_ascii=False))
    with (args.out / "review.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(review_rows[0].keys()) if review_rows else ["id"])
        w.writeheader()
        w.writerows(review_rows)
    with (args.out / "detections_geo.csv").open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["dieturn_id", "image", "conf", "src_px", "is_representative"])
        w.writeheader()
        w.writerows(det_rows)

    n_multi = sum(1 for f in features if f["properties"]["n_detections"] > 1)
    summary = {
        "images": len(idx),
        "detections_kept": len(dets),
        "dieturn_total": len(features),
        "auto": status_count["auto"],
        "review": status_count["review"],
        "merged_from_multiple_images": n_multi,
        "intersections_with_dieturn": len({f["properties"]["intersection_id"] for f in features}),
        "corner_distribution": dict(Counter(f["properties"]["corner"] for f in features)),
        "serves_quality": dict(Counter(f["properties"]["serves_quality"] for f in features)),
        "model_version": args.model_version,
        "imagery_source": args.imagery_source,
        "thresholds": {"auto": AUTO_CONF, "review": REVIEW_CONF, "merge_iou": MERGE_IOU, "merge_dist_m": MERGE_DIST_M},
    }
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\n輸出目錄: {args.out}")


if __name__ == "__main__":
    main()
