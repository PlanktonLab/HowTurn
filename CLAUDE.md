# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

先讀 `docs/PIPELINE.md`(整體流程與 GeoJSON 欄位定義)與 `apps/roadsense/README.md`(App 細節);根目錄 `README.md` 是對外的產品說明,截圖在 `docs/screenshots/`。本檔補充跨檔案才看得出來的架構與地雷。

## 常用指令

Python 端有**兩種執行環境**,不要混用:

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # torch / ultralytics / shapely
```

```bash
# 需要 venv(torch / ultralytics / shapely / PIL)
.venv/bin/python ml/prepare_dataset.py        # datasets/labeled → ml/dataset(分層抽樣 + 產 yaml)
.venv/bin/python ml/train.py                  # MPS,1024px;中斷用 --resume 續跑
.venv/bin/python ml/predict.py                # → ml/runs/predict_taipei_full/detections.csv
.venv/bin/python geodata/build_geodata.py     # 像素框 → geodata/output/*.geojson
```

```bash
# 純標準庫,系統 python3 即可
python3 geodata/export_app.py                                  # geodata/output → apps/roadsense/public/geojson
python3 -m http.server 8766 --bind 127.0.0.1                   # repo 根目錄;開 /apps/map-viewer/
```

RoadSense(`apps/roadsense/`):

```bash
npm install && cp .env.example .env.local     # 填 VITE_MAPBOX_TOKEN(public token)
npm run dev                                   # 桌機;模擬行駛可用
npm run dev:phone                             # 區網 HTTPS;手機要 GPS/語音/螢幕常亮就得用這個
npm run check:twostage                        # 離線自我一致性測試(唯一的自動化測試)
npm run check:route -- "121.5288,25.0259" "121.5170,25.0478"   # 真實路線逐 step 檢查
npm run lint                                  # oxlint
npm run build                                 # tsc -b && vite build
```

`.claude/launch.json` 已定義 `dieturn-map`(port 8765,根目錄靜態伺服)與 `roadsense`(port 5173)兩個 preview 設定。

沒有 pytest / vitest 之類的測試框架。驗證手段是 `check:twostage`、`check:route`,以及 `ml/crop_sheet.py`、`geodata/mapbox_check.py`、`geodata/overview_map.py` 這幾支人工抽查工具。

## 架構

兩個半邊,中間只有一道窄門:

```
imagery/  抓圖 ──→ ml/  訓練+推論 ──→ geodata/  轉世界座標 ──→ export_app.py ──→ apps/roadsense/
(index.csv)        (detections.csv)   (dieturn.geojson)        (2 個 GeoJSON)     (純前端)
```

**地理定位的唯一依據是 `imagery/taipei_z21/index.csv`。** 每列的 `tile_x0`/`tile_y0` 是那張 4×4 拼接圖左上角的 z21 瓦片座標;`geodata/build_geodata.py:px2ll()` 用它把像素反算成經緯度。這個檔進 git、圖片(419 MB)不進。動到抓圖流程就等於動到全部圖資的座標基準。

`build_geodata.py` 的三件事:(1) 用等距圓柱投影(原點 25.05/121.55)把框投到公制平面算長寬與方位角;(2) 相鄰路口的航拍圖會重疊,同一格會被偵測多次,用 STRtree + UnionFind 依 IoU/中心距去重;(3) 每格編 `dt_` + 9 碼 geohash 當**穩定 ID** —— 重跑時位置沒變 ID 就不變,下游可以安心引用。conf ≥ 0.8 標 `auto`、0.5–0.8 標 `review`、以下丟棄。

`geodata/export_app.py` 是 pipeline 與 App 之間唯一的橋樑,把稽核欄位(`src_px` 等)剝掉後輸出兩個檔:待轉格多邊形,以及 **2,556 個「看過的路口」點位**。後者是安全語意的關鍵 —— App 靠它區分「這裡我們看過、沒有待轉格」與「這裡沒有資料」。

RoadSense 是**純前端**,沒有自家後端:Mapbox Directions / Nominatim 都由瀏覽器直呼,靜態 GeoJSON 從 `public/geojson/` 讀。分層:

- `lib/mapboxDirections.ts` 路由(機車走 driving-traffic profile,Mapbox 沒有機車 profile)
- `lib/twoStageLeft.ts` 待轉判斷 —— 核心
- `lib/location.ts` → `lib/routeProgress.ts` → `lib/guidance.ts` 是導航運行時的三段管線:位置來源(GPS / 模擬)→ 投影到路線算進度與偏離 → 有狀態的導引引擎(播報去重、待轉四階段)
- `components/MapView.tsx`(933 行)集中所有 Mapbox source/layer 接線;`components/Navigation.tsx` 管相機、內插與重新規劃

## 改動時要注意

**兩段式左轉的規則寫了兩次,改一邊要想另一邊。** 道交規則 §99「先直行至前方路口右側待轉區」在兩處實作:離線的 `geodata/build_geodata.py:serves_bearings()`(從格子相對路口中心的位移,推算它服務哪個進入方位,寫進 `serves_from_bearing`),線上的 `apps/roadsense/src/lib/twoStageLeft.ts`(從路線的左轉 step 反過來找前方右象限 55 m 內的格子)。`npm run check:twostage` 就是拿前者當 ground truth 驗後者,改任一邊都要重跑它。

**判斷單位是「左轉 step」不是「格子」。** 待轉格不是路線「經過」的東西,是服務某個特定進入方向的設施。三種狀態的安全預設是刻意的:找到格子 → `required`;沒找到但路口在航拍範圍內 → `direct`;不在範圍 → `unknown`(不敢說可以直接左轉 —— 說錯要罰單,多等一個燈只是慢一點)。

**改 GeoJSON 欄位要同步三處**:`geodata/build_geodata.py` 的 `props`、`geodata/export_app.py` 的 `KEEP`、`apps/roadsense/src/lib/types.ts` 的 `WaitingZoneProps`。沒有 codegen,漏掉不會編譯錯。

**turf 要 import 個別套件**(`@turf/buffer`),不要 `@turf/turf` —— 整包會在 dev 拖慢首次載入、build 多出好幾 MB(`lib/routeAnalysis.ts` 開頭有記錄)。

**`datasets/` 不進 git,只有 `ANNOTATION_GUIDE.md` 例外。** 訓練影像有 200 張來自臺北市都發局,授權不允許轉供第三方流通,所以影像與標註檔都只留在本機(`.gitignore` 用 `datasets/*` + 白名單)。這個 repo 預計開源,新增檔案到 `datasets/` 前先確認授權。標註者目錄一律用 `labeler_1`～`labeler_4` 匿名編號,不要放真名;名單寫死在 `ml/prepare_dataset.py:LABELERS`。

**不在 git**:`ml/weights/*.pt`、`ml/dataset/`、`ml/runs/`、`imagery/taipei_z21/images/`、`datasets/labeled/`、`datasets/dist_v1/`。前四項可重生,`datasets/` 底下的不行(要另外索取)。`geodata/output/` 的成品**有**進 git。

**幾處註解已過時**,別當真:`lib/waitingZoneAnalysis.ts` 說待轉格資料「currently empty」(其實已有 1,344 筆),`lib/config.ts` 與 `lib/geocode.ts` 提到的 `DATA_SOURCES.md` / `app/README.md` 不存在。

Mapbox token 是 public token,打包後會出現在 `dist/`,靠 Mapbox 後台的 URL 限制保護,不要當祕密處理。

## Commit 規範

用 [Conventional Commits](https://www.conventionalcommits.org/):`<type>(<scope>): <描述>`。type 與 scope 用英文小寫,描述與 body 用繁體中文(維持既有 commit 風格)。

```
feat(roadsense): 兩段式左轉提示分 required / direct / unknown 三種狀態

- 依 Directions 每個左轉的進入/離開方位，在路口 55 m 內找前方右側象限的待轉格
- 不在航拍範圍的路口一律 unknown，不主張可直接左轉

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

- **type**:`feat` `fix` `refactor` `perf` `docs` `style` `test` `build` `chore` `revert`
- **scope**(選填,對應目錄):`roadsense` `map-viewer` `ml` `imagery` `geodata` `datasets`
- 描述用祈使句、不加句號,標題盡量 ≤ 72 字元
- 破壞性變更在 type/scope 後加 `!`(例:`feat(geodata)!: 移除 dieturn.geojson 的 src_px 欄位`),並在 body 寫 `BREAKING CHANGE: <說明>`
- 圖資重跑產生的 `geodata/output/` 與 `apps/roadsense/public/geojson/` 更新用 `chore(geodata): 重跑圖資`,不要跟程式修改混在同一個 commit
