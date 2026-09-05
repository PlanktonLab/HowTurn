#!/usr/bin/env python3
"""訓練 YOLO26 OBB 模型辨識航拍圖中的待轉格。"""
from __future__ import annotations

import argparse
from pathlib import Path

import torch
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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=str(ROOT / "ml" / "weights" / "yolo26s-obb.pt"), help="預訓練權重(DOTAv1);檔案不存在時交給 Ultralytics 依檔名下載")
    ap.add_argument("--data", type=Path, default=ROOT / "ml" / "dataset" / "dieturn_obb.yaml")
    ap.add_argument("--epochs", type=int, default=400)
    ap.add_argument("--patience", type=int, default=100)
    ap.add_argument("--imgsz", type=int, default=1024)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--name", default="dieturn_obb")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument(
        "--resume",
        nargs="?",
        const="auto",
        default=None,
        help="從 checkpoint 續跑;不給路徑則用 runs/<name>/weights/last.pt",
    )
    args = ap.parse_args()

    if not args.data.is_file():
        raise SystemExit(f"找不到 {args.data},請先執行 ml/prepare_dataset.py")

    resume = args.resume
    if resume == "auto":
        resume = ROOT / "ml" / "runs" / args.name / "weights" / "last.pt"
    if resume:
        resume = Path(resume)
        if not resume.is_file():
            raise SystemExit(f"找不到 checkpoint {resume}")
        # Ultralytics 收到 resume=True 時會自行 glob 最近的 last.pt,可能挑到別的 run;
        # 給明確路徑才會續跑指定的這一個。
        args.model = str(resume)
        resume = str(resume)

    if not Path(args.model).exists():
        args.model = Path(args.model).name  # 交給 Ultralytics 下載

    device = pick_device(args.device)
    print(f"device={device}  torch={torch.__version__}  model={args.model}", flush=True)

    model = YOLO(args.model)
    model.train(
        data=str(args.data),
        epochs=args.epochs,
        patience=args.patience,
        imgsz=args.imgsz,
        batch=args.batch,
        workers=args.workers,
        device=device,
        project=str(ROOT / "ml" / "runs"),
        name=args.name,
        exist_ok=bool(resume),
        resume=resume or False,
        seed=args.seed,
        # 資料量小(191 張訓練圖 / 124 個框),整張快取進記憶體省 IO
        cache="ram",
        cos_lr=True,
        # 待轉格在航拍圖中可能是任意角度,OBB 需要完整旋轉增強
        degrees=180.0,
        fliplr=0.5,
        flipud=0.5,
        scale=0.5,
        translate=0.1,
        shear=2.0,
        mosaic=1.0,
        close_mosaic=25,
        plots=True,
    )

    save_dir = Path(model.trainer.save_dir)
    print(f"\n最佳權重: {save_dir / 'weights' / 'best.pt'}", flush=True)
    print(f"訓練曲線與圖表: {save_dir}", flush=True)


if __name__ == "__main__":
    main()
