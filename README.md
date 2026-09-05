# DieTurn — 航拍圖辨識機車待轉格

用 YOLO26 OBB 從台北市航拍正射影像自動找出機車待轉格,轉成帶經緯度的圖資,供黑客松 Demo app 使用。

## 目錄

| 目錄 | 內容 | 進 git? |
|---|---|---|
| `datasets/labeled/` | 4 位標註者的原始標註(320 張 1024² 圖 + OBB label) | ✅ |
| `datasets/dist_v1/` | 當初分發給標註者的包,與 labeled 重複 | ❌ |
| `ml/` | 資料整併、訓練、推論、抽查工具 | 腳本 ✅;`dataset/` `runs/` `weights/` `archive/` ❌ |
| `imagery/` | 台北市 2556 個路口的 z21 航拍(都發局 2025 正射)與抓圖腳本 | 腳本與 `index.csv` ✅;圖片 ❌ |
| `geodata/` | 把偵測框轉成世界座標、去重、輸出 GeoJSON | ✅(含 `output/` 成品) |
| `apps/map-viewer/` | Mapbox GL 檢視頁 | ✅ |
| `apps/roadsense/` | 機車導航 Web App(真實 GPS 導航 + 兩段式左轉提示),見其 README | ✅(`node_modules/` `dist/` `.env.local` ❌) |

沒進 git 的東西都可以重生(見下方流程),或找 Sam 拿:`ml/weights/best_final.pt`(82 MB)、`imagery/taipei_z21/images/`(419 MB)。

## 環境

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

## 流程

```bash
# 1. 整併標註 → ml/dataset/(分層抽樣切 train/val,無標註圖當背景負樣本)
.venv/bin/python ml/prepare_dataset.py

# 2. 訓練(MPS,1024px,約 35 s/epoch;中斷後 --resume 續跑)
.venv/bin/python ml/train.py

# 3. 對航拍圖推論 → ml/runs/predict_taipei_full/(detections.csv + 標註圖)
.venv/bin/python ml/predict.py

# 4. 轉世界座標 + 跨圖去重 + 推算每格服務的左轉方向 → geodata/output/dieturn.geojson 等
.venv/bin/python geodata/build_geodata.py

# 4b. 匯出給導航 App(待轉格 + 有航拍的路口清單)
python3 geodata/export_app.py

# 5. 看結果
python3 -m http.server 8766 --bind 127.0.0.1     # 在 repo 根目錄
open http://localhost:8766/apps/map-viewer/       # 第一次貼上 Mapbox public token
```

抽查工具:`ml/crop_sheet.py`(放大裁切檢視高/中/低信心框)、`geodata/mapbox_check.py`(把某張圖的框疊在 Mapbox 衛星圖上,需 `MAPBOX_TOKEN` 環境變數)、`geodata/overview_map.py`(全台北總覽 PNG)。

## 目前成果(2026-09-05)

- 模型:`yolo26s-obb` 微調,epoch 144,val mAP50 0.968 / mAP50-95 0.892(val 僅 44 框,數字偏樂觀)
- 圖資:2556 張路口圖 → **1344 個待轉格**,分佈在 757 個路口;conf ≥ 0.8 自動接受 1099、0.5–0.8 待複核 245(`geodata/output/review.csv`)

## GeoJSON 欄位

每筆一個真實待轉格。`id` 為 `dt_` + 中心點 geohash(9 碼),重跑時位置不變就沿用。
`status`(auto/review)、`conf`、`n_detections`(跨圖偵測次數)、`heading_deg`(長軸方位 0–180)、`length_m`/`width_m`、`corner`(相對路口中心 NE/NW/SE/SW)、`intersection_id`(對應 `imagery/points_taipei_z21.csv`)、`src_image`/`src_px`(可回溯到原圖與像素框)、`serves_from_bearing`/`serves_to_bearing`/`serves_quality`(這格服務哪個進入方位的左轉,依「前方路口右側待轉區」的位置關係推算;偏移太小標 ambiguous)、`osm_node_id`(預留,尚未填)。
座標順序為 GeoJSON 慣例 `[lon, lat]`。
