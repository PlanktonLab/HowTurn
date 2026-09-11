#!/usr/bin/env python3
"""Phase 0 — 量化 NLSC z20 相對於都發局 z21 的偵測損失。

以台北市為對照區:同一批路口有兩套影像(z21 6.8 cm/px、z20 13.5 cm/px),
z21 跑出來的 auto 框(conf >= 0.8)當 ground truth,量 z20 找回多少。

判準見 docs/PLAN_TAIWAN_SCAN.md 第 5 節:
  recall >= 0.75        沿用 v0.5 權重,只調門檻
  0.50 <= recall < 0.75 需要補 z20 標註做 fine-tune
  recall < 0.50         z20 不足以支撐產品語意

路徑預設值假設 repo/ 與 scan/ 並存於同一個母目錄(開發時的佈局);
其他佈局用 --z21 / --z20 / --z20-index / --report 指定。

用法: python ml/phase0_z20_vs_z21.py --z20 ../scan/geodata/output_taiwan_z20/dieturn.geojson ...
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent      # repo/
WORK = REPO.parent                                  # repo/ 與 scan/ 的母目錄

# 台北局部公制投影(與 build_geodata.py 同一套)
LAT0, LON0 = 25.05, 121.55
M_PER_DEG_LAT = 110_574.0
M_PER_DEG_LON = 111_320.0 * math.cos(math.radians(LAT0))


def to_m(lon: float, lat: float) -> tuple[float, float]:
    return (lon - LON0) * M_PER_DEG_LON, (lat - LAT0) * M_PER_DEG_LAT


def heading_delta(a: float, b: float) -> float:
    """兩個 0~180 方位角的最小夾角。"""
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


def load_zones(path: Path) -> list[dict]:
    fc = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for f in fc["features"]:
        p = f["properties"]
        x, y = to_m(p["lon"], p["lat"])
        out.append({"x": x, "y": y, "conf": p["conf"], "status": p["status"],
                    "heading": p["heading_deg"], "id": p["id"]})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hit-m", type=float, default=3.0, help="中心距多少公尺內算命中")
    ap.add_argument("--coverage-m", type=float, default=60.0,
                    help="z21 框離最近的 z20 取樣點超過這個距離,視為 z20 沒拍到")
    ap.add_argument("--z21", type=Path, default=REPO / "geodata/output/dieturn.geojson")
    ap.add_argument("--z20", type=Path, default=WORK / "scan/geodata/output_taiwan_z20/dieturn.geojson")
    ap.add_argument("--z20-index", type=Path, default=WORK / "scan/imagery/taiwan_z20/index.csv")
    ap.add_argument("--report", type=Path, default=REPO / "docs/PHASE0_Z20.md")
    args = ap.parse_args()
    for p in (args.z21, args.z20, args.z20_index):
        if not p.is_file():
            raise SystemExit(f"找不到 {p} — 用 --z21 / --z20 / --z20-index 指定路徑")

    # z20 的台北切片:靠 index.csv 的 county 欄挑出臺北市的圖,再取這些圖上的框
    taipei_ids, taipei_pts = set(), []
    for r in csv.DictReader(args.z20_index.open(encoding="utf-8")):
        if "臺北市" in r["county"] or "台北市" in r["county"]:
            taipei_ids.add(r["id"])
            taipei_pts.append(to_m(float(r["lon"]), float(r["lat"])))

    z21 = load_zones(args.z21)
    gt = [z for z in z21 if z["status"] == "auto"]

    # 比對對象用全台的框,不靠 county 篩。40 m 聚合會把邊界路口歸給鄰縣,
    # 先篩 county 會把那些框排掉、低估 recall;3 m 的命中判準本來就夠嚴。
    z20_all = json.loads(args.z20.read_text(encoding="utf-8"))["features"]
    z20, z20_taipei = [], 0
    for f in z20_all:
        p = f["properties"]
        x, y = to_m(p["lon"], p["lat"])
        if abs(x) > 40_000 or abs(y) > 40_000:   # 離台北 40 km 以外的不可能命中
            continue
        tp = p["intersection_id"] in taipei_ids
        z20.append({"x": x, "y": y, "conf": p["conf"], "status": p["status"],
                    "heading": p["heading_deg"], "id": p["id"], "taipei": tp})
        z20_taipei += tp

    # 涵蓋檢查:z21 的框如果根本不在 z20 掃描範圍內,算涵蓋缺口而不是偵測失敗
    def covered(z: dict) -> bool:
        return any(math.dist((z["x"], z["y"]), p) <= args.coverage_m for p in taipei_pts)

    gt_cov = [z for z in gt if covered(z)]
    n_uncov = len(gt) - len(gt_cov)

    # 對每個 ground truth 框找最近的 z20 框
    matches = []
    for g in gt_cov:
        best, bd = None, 1e9
        for c in z20:
            d = math.dist((g["x"], g["y"]), (c["x"], c["y"]))
            if d < bd:
                best, bd = c, d
        matches.append((g, best, bd))

    hits = [(g, c, d) for g, c, d in matches if d <= args.hit_m]

    lines = []
    def out(s: str = "") -> None:
        print(s)
        lines.append(s)

    out("# Phase 0 — NLSC z20 對照都發局 z21")
    out()
    out(f"對照區:臺北市。ground truth = z21 的 `auto` 框(conf ≥ 0.8),"
        f"命中判準 = 中心距 ≤ {args.hit_m:g} m。")
    out()
    out("## 資料量")
    out()
    out("| 項目 | 數量 |")
    out("|---|---|")
    out(f"| z21 全部框 | {len(z21)} |")
    out(f"| z21 `auto` 框(ground truth) | {len(gt)} |")
    out(f"| 其中落在 z20 掃描範圍內 | {len(gt_cov)} |")
    out(f"| 涵蓋缺口(z20 沒拍到) | {n_uncov} |")
    out(f"| z20 台北取樣點 | {len(taipei_pts)} |")
    out(f"| z20 台北偵測到的框 | {z20_taipei} |")
    out(f"| 納入比對的 z20 框(北台灣 40 km 內) | {len(z20)} |")
    out()

    recall = len(hits) / len(gt_cov) if gt_cov else 0.0
    out("## 結果")
    out()
    out(f"**Recall = {recall:.3f}**({len(hits)} / {len(gt_cov)})")
    out()

    if hits:
        ds = sorted(d for _, _, d in hits)
        q = lambda f: ds[min(int(len(ds) * f), len(ds) - 1)]
        out(f"- 定位誤差:中位數 **{q(0.5):.2f} m**,P95 **{q(0.95):.2f} m**,最大 {ds[-1]:.2f} m")
        hd = sorted(heading_delta(g["heading"], c["heading"]) for g, c, _ in hits)
        qh = lambda f: hd[min(int(len(hd) * f), len(hd) - 1)]
        out(f"- `heading_deg` 誤差:中位數 **{qh(0.5):.1f}°**,P95 **{qh(0.95):.1f}°**")
    out()

    # 門檻掃描:z20 的信心分佈整體下移,原本的 0.80 不一定是最佳切點
    out("## conf 門檻掃描")
    out()
    out("| z20 conf 門檻 | 台北保留框 | 命中 | Recall | 台北未命中的多餘框 |")
    out("|---|---|---|---|---|")
    for th in (0.50, 0.60, 0.70, 0.80, 0.90):
        # 多餘框只算臺北市內的,才和台北的 ground truth 同一個範圍
        kept_tp = [c for c in z20 if c["conf"] >= th and c["taipei"]]
        hit_ids = {id(c) for g, c, d in matches if d <= args.hit_m and c is not None and c["conf"] >= th}
        n_hit = len(hit_ids)
        extra = sum(1 for c in kept_tp if id(c) not in hit_ids)
        out(f"| {th:.2f} | {len(kept_tp)} | {n_hit} | {n_hit/len(gt_cov):.3f} | {extra} |")
    out()

    verdict = ("沿用 v0.5 權重,只調門檻(Phase 3 縮成 3 天)" if recall >= 0.75
               else "需要補 z20 標註做 fine-tune(Phase 3 約 2 週)" if recall >= 0.50
               else "z20 不足以支撐產品語意,改走降級策略(計畫第 13 節)")
    out("## 判定")
    out()
    out(f"Recall {recall:.3f} → **{verdict}**")
    out()
    out("> 「未命中的多餘框」同時包含 z20 的誤報與 z21 本身漏掉的真框,")
    out("> 不等於 false positive,要目視抽查才能分開。")
    out()
    out("## 對產品的影響")
    out()
    out(f"`VERIFICATION_LEVELS.md` 第 4 節把 **absent 的可信度綁在該批影像量測到的 recall** 上:")
    out(f"模型在 z20 影像上沒找到框,只有 {recall:.0%} 的機率代表那裡真的沒有待轉格。")
    out()
    if recall < 0.75:
        out("因此 **z20-only 區域的「沒找到框」必須表達成 `unknown`,不能給 `direct`**。")
        out("說錯要罰單,多等一個燈只是慢一點 —— 低解析度區域的取捨應該更保守。")
    else:
        out("recall 已達門檻,z20-only 區域可沿用既有的 `direct` 政策。")
    out()
    out(f"定位精度不是問題:命中的框中位誤差 {(sorted(d for _, _, d in hits)[len(hits)//2] if hits else 0):.2f} m,"
        "遠小於待轉格本身的尺寸。z20 的損失集中在「有沒有找到」,不在「找得準不準」。")

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"\n報告寫到 {args.report}")


if __name__ == "__main__":
    main()
