#!/usr/bin/env python3
"""用訓練好的 OBB 權重對航拍圖跑推論,輸出標註圖、統計與 CSV。

每張圖的 lat/lon 會從 imagery/<area>/index.csv 帶進結果,方便回頭定位。
"""
from __future__ import annotations

import argparse
import csv
import random
from collections import Counter
from pathlib import Path

import torch
from PIL import Image
from ultralytics import YOLO

ROOT = Path(__file__).resolve().parent.parent


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "0"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_geo(index_csv: Path) -> dict[str, tuple[str, str]]:
    if not index_csv.is_file():
        return {}
    with index_csv.open() as fh:
        return {r["id"]: (r["lat"], r["lon"]) for r in csv.DictReader(fh)}


def contact_sheet(paths: list[Path], out: Path, cols: int = 4, cell: int = 512) -> None:
    """把數張標註圖拼成一張總覽圖。"""
    if not paths:
        return
    rows = (len(paths) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), "black")
    for i, p in enumerate(paths):
        img = Image.open(p).convert("RGB").resize((cell, cell), Image.LANCZOS)
        sheet.paste(img, ((i % cols) * cell, (i // cols) * cell))
    sheet.save(out, quality=88)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", type=Path, default=ROOT / "ml" / "weights" / "best_final.pt")
    ap.add_argument("--source", type=Path, default=ROOT / "imagery" / "taipei_z21" / "images")
    ap.add_argument("--index", type=Path, default=ROOT / "imagery" / "taipei_z21" / "index.csv")
    ap.add_argument("--out", type=Path, default=ROOT / "ml" / "runs" / "predict_taipei_full")
    ap.add_argument("--sample", type=int, default=0, help="隨機抽樣張數,0=全部")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=1024)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--sheet", type=int, default=16, help="總覽圖要放幾張")
    ap.add_argument("--device", default="auto")
    args = ap.parse_args()

    images = sorted(args.source.glob("*.jpg"))
    if not images:
        raise SystemExit(f"{args.source} 裡沒有 jpg")
    if args.sample and args.sample < len(images):
        images = sorted(random.Random(args.seed).sample(images, args.sample))

    geo = load_geo(args.index)
    det_dir = args.out / "detections"
    det_dir.mkdir(parents=True, exist_ok=True)

    device = pick_device(args.device)
    print(f"權重={args.weights.name}  device={device}  {len(images)} 張圖  conf={args.conf}", flush=True)
    model = YOLO(args.weights)

    rows: list[dict] = []
    per_image: list[tuple[float, int, Path]] = []  # (最高信心, 框數, 標註圖路徑)
    hist = Counter()

    for i in range(0, len(images), args.batch):
        chunk = images[i : i + args.batch]
        for res in model.predict(
            chunk, imgsz=args.imgsz, conf=args.conf, device=device, verbose=False
        ):
            src = Path(res.path)
            obb = res.obb
            n = 0 if obb is None else len(obb)
            hist[min(n, 5)] += 1
            if n == 0:
                continue
            confs = obb.conf.tolist()
            # xyxyxyxy: 每個框 4 個角點的像素座標
            for conf, corners in zip(confs, obb.xyxyxyxy.tolist()):
                lat, lon = geo.get(src.stem, ("", ""))
                rows.append(
                    {
                        "image": src.name,
                        "lat": lat,
                        "lon": lon,
                        "conf": round(float(conf), 4),
                        "corners": ";".join(f"{x:.1f},{y:.1f}" for x, y in corners),
                    }
                )
            out_img = det_dir / src.name
            Image.fromarray(res.plot(line_width=3, font_size=20)[..., ::-1]).save(out_img, quality=90)
            per_image.append((max(confs), n, out_img))
        print(f"  {min(i + args.batch, len(images))}/{len(images)}", end="\r", flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    csv_path = args.out / "detections.csv"
    with csv_path.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["image", "lat", "lon", "conf", "corners"])
        w.writeheader()
        w.writerows(sorted(rows, key=lambda r: -r["conf"]))

    per_image.sort(key=lambda t: -t[0])
    contact_sheet([p for _, _, p in per_image[: args.sheet]], args.out / "top_detections.jpg")
    if len(per_image) > args.sheet:
        contact_sheet(
            [p for _, _, p in per_image[-args.sheet :]], args.out / "lowest_confidence.jpg"
        )

    n_hit = len(per_image)
    print(f"\n\n{len(images)} 張圖 -> {n_hit} 張有偵測 ({n_hit / len(images):.1%}), 共 {len(rows)} 個框")
    print("每張圖框數分佈:", ", ".join(f"{k}{'+' if k == 5 else ''}框 {v} 張" for k, v in sorted(hist.items())))
    if rows:
        cs = sorted(r["conf"] for r in rows)
        q = lambda f: cs[min(int(len(cs) * f), len(cs) - 1)]
        print(f"信心分佈: 中位數 {q(0.5):.3f}  P25 {q(0.25):.3f}  P75 {q(0.75):.3f}  最高 {cs[-1]:.3f}")
        print(f"  conf>=0.5: {sum(c >= 0.5 for c in cs)} 框   conf>=0.7: {sum(c >= 0.7 for c in cs)} 框")
    print(f"\n標註圖: {det_dir}\nCSV: {csv_path}\n總覽圖: {args.out / 'top_detections.jpg'}")


if __name__ == "__main__":
    main()
