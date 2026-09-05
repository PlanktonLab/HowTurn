#!/usr/bin/env python3
"""從 detections.csv 產生放大裁切的檢視圖,比全幅縮圖容易判讀對錯。"""
from __future__ import annotations

import argparse
import csv
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent


def build(rows: list[dict], images: Path, out: Path, cols: int, cell: int, pad: int) -> None:
    rows = rows[: cols * ((len(rows) + cols - 1) // cols)]
    n_rows = (len(rows) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, n_rows * cell), "black")
    label = ImageDraw.Draw(sheet)
    for i, r in enumerate(rows):
        pts = [tuple(map(float, p.split(","))) for p in r["corners"].split(";")]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        img = Image.open(images / r["image"]).convert("RGB")
        l, t = max(0, min(xs) - pad), max(0, min(ys) - pad)
        rt, b = min(img.width, max(xs) + pad), min(img.height, max(ys) + pad)
        crop = img.crop((int(l), int(t), int(rt), int(b)))
        sc = cell / max(crop.size)
        crop = crop.resize((int(crop.width * sc), int(crop.height * sc)), Image.LANCZOS)
        ImageDraw.Draw(crop).polygon(
            [((x - l) * sc, (y - t) * sc) for x, y in pts], outline=(0, 255, 255), width=3
        )
        ox, oy = (i % cols) * cell, (i // cols) * cell
        sheet.paste(crop, (ox, oy))
        label.text((ox + 6, oy + 6), f"{r['image'][:-4]}  {r['conf']}", fill=(255, 255, 0))
    sheet.save(out, quality=92)
    print(f"{out}  ({len(rows)} 個框)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=Path, default=ROOT / "ml" / "runs" / "predict_taipei_full")
    ap.add_argument("--images", type=Path, default=ROOT / "imagery" / "taipei_z21" / "images")
    ap.add_argument("--n", type=int, default=12, help="每張檢視圖放幾個框")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--cell", type=int, default=420)
    ap.add_argument("--pad", type=int, default=110, help="框外要多留幾 px 的環境")
    args = ap.parse_args()

    with (args.run / "detections.csv").open() as fh:
        rows = sorted(csv.DictReader(fh), key=lambda r: -float(r["conf"]))

    build(rows[: args.n], args.images, args.run / "sheet_high_conf.jpg", args.cols, args.cell, args.pad)
    mid = len(rows) // 2
    build(rows[mid : mid + args.n], args.images, args.run / "sheet_mid_conf.jpg", args.cols, args.cell, args.pad)
    build(rows[-args.n :], args.images, args.run / "sheet_low_conf.jpg", args.cols, args.cell, args.pad)


if __name__ == "__main__":
    main()
