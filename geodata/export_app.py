#!/usr/bin/env python3
"""把 build_geodata.py 的成品匯出成 apps/howtoturn 導航 App 讀的兩個 GeoJSON。

  <prefix>_waiting_zones.geojson
      待轉格多邊形。屬性精簡成 App 需要的欄位(去掉像素框等稽核用資料)。
  <prefix>_surveyed_intersections.geojson
      有航拍圖的路口中心點。App 用它判斷「這個路口我們看過了但沒有待轉格」
      與「這個路口不在航拍範圍」(無資料,不敢說可直接左轉)。

可以一次併入多個資料集。每個路口點都帶著 survey_recall —— 那批影像實測到的
recall,讓 App 知道這個路口的「沒找到框」有多可信。高解析度影像的沉默才能
當成「可直接左轉」的證據;低解析度的沉默只能說「不知道」。

台北(預設,都發局 z21):
    python geodata/export_app.py

全台(台北用 z21,其餘用 NLSC z20):
    python geodata/export_app.py --prefix taiwan \\
        --add geodata/output/dieturn.geojson imagery/taipei_z21/index.csv 1.0 \\
        --add ../scan/geodata/output_taiwan_z20/dieturn.geojson \\
              ../scan/imagery/taiwan_z20/index.csv 0.517 \\
        --exclude-county 臺北市

--exclude-county 只作用在 index.csv 有 county 欄的資料集(全台那份有、台北那份
沒有),把已被高解析度資料集涵蓋的區域從低解析度那份剔除,兩份合起來才不會在
同一個路口出現兩套框。z20 的 0.517 出自 docs/PHASE0_Z20.md。

重跑 build_geodata.py 之後再跑這支,App 資料就同步。
"""
from __future__ import annotations

import argparse
import csv
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

KEEP = (
    "id", "status", "conf", "n_detections", "heading_deg", "length_m", "width_m",
    "corner", "intersection_id", "intersection_dist_m",
    "serves_from_bearing", "serves_to_bearing", "serves_quality", "lat", "lon",
)


def load_dataset(src: Path, index: Path, recall: float, exclude: set[str],
                 today: str) -> tuple[list[dict], list[dict], str]:
    """讀一個資料集,回傳 (待轉格, 路口點, 來源字串)。"""
    summary = json.loads((src.parent / "summary.json").read_text(encoding="utf-8"))
    imagery = summary["imagery_source"]
    source = f"dieturn/{summary['model_version']}@{imagery}"

    # index.csv 同時提供路口座標、status 篩選,以及(若有)county
    keep_ids, surveyed = set(), []
    for r in csv.DictReader(index.open(encoding="utf-8")):
        if r["status"] != "ok":
            continue
        if exclude and r.get("county") and any(c in r["county"] for c in exclude):
            continue
        keep_ids.add(r["id"])
        surveyed.append({
            "type": "Feature",
            "id": r["id"],
            "properties": {
                "id": r["id"],
                "n_nodes": int(r["n_nodes"]),
                # App 用這兩欄決定「看過但沒框」能不能當成可直接左轉
                "imagery": imagery,
                "survey_recall": recall,
            },
            "geometry": {"type": "Point", "coordinates": [float(r["lon"]), float(r["lat"])]},
        })

    zones = []
    for f in json.loads(src.read_text(encoding="utf-8"))["features"]:
        p = f["properties"]
        if p["intersection_id"] not in keep_ids:
            continue          # 路口被 --exclude-county 剔除,它的框也要一起剔除
        props = {k: p[k] for k in KEEP}
        props["confidence"] = "confirmed" if p["status"] == "auto" else "probable"
        props["source"] = source
        props["source_updated_at"] = today
        zones.append({"type": "Feature", "id": p["id"], "properties": props, "geometry": f["geometry"]})

    return zones, surveyed, imagery


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--add", nargs=3, action="append", metavar=("SRC", "INDEX", "RECALL"),
                    help="要併入的資料集:dieturn.geojson、index.csv、該批影像實測 recall。"
                         "可重複;省略時用台北 z21 那組。")
    ap.add_argument("--out-dir", type=Path, default=ROOT / "apps/howtoturn/public/geojson")
    ap.add_argument("--prefix", default="taipei", help="輸出檔名前綴")
    ap.add_argument("--exclude-county", action="append", default=[],
                    help="從有 county 欄的資料集剔除這些縣市(避免與高解析度資料集重疊)")
    args = ap.parse_args()

    datasets = args.add or [[
        str(ROOT / "geodata/output/dieturn.geojson"),
        str(ROOT / "imagery/taipei_z21/index.csv"),
        "1.0",
    ]]

    today = date.today().isoformat()
    all_zones: list[dict] = []
    all_surveyed: list[dict] = []
    for src, index, recall in datasets:
        # 第一個資料集不剔除(它是解析度最高的那份),後續的才剔除重疊區域
        exclude = set(args.exclude_county) if all_zones or all_surveyed else set()
        z, s, imagery = load_dataset(Path(src), Path(index), float(recall), exclude, today)
        all_zones += z
        all_surveyed += s
        print(f"  {imagery}: {len(z)} 框 / {len(s)} 路口  recall={recall}"
              + (f"  (剔除 {'、'.join(sorted(exclude))})" if exclude else ""))

    seen = set()
    dupes = [f["id"] for f in all_zones if f["id"] in seen or seen.add(f["id"])]
    if dupes:
        raise SystemExit(f"待轉格 id 重複 {len(dupes)} 筆(資料集區域重疊?):{dupes[:5]}")

    args.out_dir.mkdir(parents=True, exist_ok=True)
    zones_path = args.out_dir / f"{args.prefix}_waiting_zones.geojson"
    surveyed_path = args.out_dir / f"{args.prefix}_surveyed_intersections.geojson"
    zones_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": all_zones}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    surveyed_path.write_text(
        json.dumps({"type": "FeatureCollection", "features": all_surveyed}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nwaiting zones: {len(all_zones)} ({zones_path.stat().st_size / 2**20:.1f} MB)")
    print(f"surveyed intersections: {len(all_surveyed)} ({surveyed_path.stat().st_size / 2**20:.1f} MB)")
    print(f"-> {args.out_dir}")


if __name__ == "__main__":
    main()
