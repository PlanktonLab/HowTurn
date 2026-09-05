#!/usr/bin/env python3
"""把 Labeled/ 下各標註者的資料整併成 YOLO OBB 訓練用的 train/val 目錄。

來源結構: datasets/labeled/<labeler>/images/*.jpg  +  Labeled/<labeler>/labels/train/<stem>.txt
輸出結構: ml/dataset/images/{train,val}/*.jpg    +  ml/dataset/labels/{train,val}/*.txt

沒有對應 .txt 的圖片視為純背景負樣本(輸出空的 .txt)。
"""
from __future__ import annotations

import argparse
import random
import re
import shutil
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# labeler_3 是原 原標註者 那批 80 張圖的重標版(對應 dataset_v1/labeler_3),
# 原標註者 只標了 2/80 未標完,已由使用者移除,改用 labeler_3。
LABELERS = ["labeler_3", "labeler_2", "labeler_4", "labeler_1"]
CLASS_NAMES = {0: "DieTurn"}


def scene_of(stem: str) -> str:
    """A_taipei_urban_hires_042 -> A_taipei_urban_hires"""
    return re.sub(r"_\d+$", "", stem)


def collect(src: Path) -> list[tuple[Path, Path | None]]:
    items = []
    for labeler in LABELERS:
        img_dir = src / labeler / "images"
        lbl_dir = src / labeler / "labels" / "train"
        if not img_dir.is_dir():
            raise SystemExit(f"找不到 {img_dir}")
        for img in sorted(img_dir.glob("*.jpg")):
            lbl = lbl_dir / f"{img.stem}.txt"
            items.append((img, lbl if lbl.is_file() and lbl.stat().st_size else None))
    return items


def check_label(lbl: Path) -> int:
    """驗證 OBB 標註格式: class x1 y1 x2 y2 x3 y3 x4 y4 (正規化座標)。回傳框數。"""
    n = 0
    for i, line in enumerate(lbl.read_text().splitlines(), 1):
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 9:
            raise SystemExit(f"{lbl}:{i} 欄位數 {len(parts)} != 9,不是 OBB 格式")
        cls = int(parts[0])
        if cls not in CLASS_NAMES:
            raise SystemExit(f"{lbl}:{i} 未知類別 {cls}")
        coords = [float(v) for v in parts[1:]]
        if any(not (-0.01 <= v <= 1.01) for v in coords):
            raise SystemExit(f"{lbl}:{i} 座標未正規化: {coords}")
        n += 1
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, default=ROOT / "datasets" / "labeled")
    ap.add_argument("--out", type=Path, default=ROOT / "ml" / "dataset")
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--copy", action="store_true", help="複製圖片而非建立 symlink")
    args = ap.parse_args()

    items = collect(args.src)
    if not items:
        raise SystemExit("沒有收集到任何圖片")

    # 依 (場景, 有無標註) 分層抽樣,確保 val 也涵蓋各場景的正負樣本
    strata: dict[tuple[str, bool], list] = {}
    for img, lbl in items:
        strata.setdefault((scene_of(img.stem), lbl is not None), []).append((img, lbl))

    rng = random.Random(args.seed)
    split: dict[str, list] = {"train": [], "val": []}
    for key in sorted(strata):
        group = sorted(strata[key], key=lambda p: p[0].stem)
        rng.shuffle(group)
        n_val = round(len(group) * args.val_frac)
        # 正樣本組至少留 1 張給 val,且不能整組被抽走
        if key[1] and len(group) > 1:
            n_val = min(max(n_val, 1), len(group) - 1)
        split["val"] += group[:n_val]
        split["train"] += group[n_val:]

    for sub in ("images", "labels"):
        for s in ("train", "val"):
            d = args.out / sub / s
            if d.exists():
                shutil.rmtree(d)
            d.mkdir(parents=True)

    stats = {s: Counter() for s in split}
    for s, group in split.items():
        for img, lbl in sorted(group, key=lambda p: p[0].stem):
            dst_img = args.out / "images" / s / img.name
            if args.copy:
                shutil.copy2(img, dst_img)
            else:
                dst_img.symlink_to(img.resolve())
            dst_lbl = args.out / "labels" / s / f"{img.stem}.txt"
            if lbl is None:
                dst_lbl.write_text("")
                stats[s]["background"] += 1
            else:
                stats[s]["boxes"] += check_label(lbl)
                stats[s]["labeled"] += 1
                shutil.copy2(lbl, dst_lbl)
            stats[s]["images"] += 1

    yaml_path = args.out / "dieturn_obb.yaml"
    names = "\n".join(f"  {k}: {v}" for k, v in sorted(CLASS_NAMES.items()))
    yaml_path.write_text(
        f"# 自動產生,請勿手動編輯 — 由 scripts/prepare_dataset.py 產生\n"
        f"path: {args.out.resolve()}\n"
        f"train: images/train\n"
        f"val: images/val\n"
        f"names:\n{names}\n"
    )

    print(f"標註者: {', '.join(LABELERS)}")
    for s in ("train", "val"):
        c = stats[s]
        print(
            f"{s:>5}: {c['images']:>3} 張 "
            f"({c['labeled']} 張有標註 / {c['background']} 張背景), {c['boxes']} 個框"
        )
    print(f"\n資料集設定檔: {yaml_path}")


if __name__ == "__main__":
    main()
