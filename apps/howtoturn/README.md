# 毋機道 HowToTurn — 機車導航 Web App

台灣機車專屬的即時導航。除了帶你到目的地，還會在每個左轉路口告訴你**要不要兩段式待轉**：
需要待轉就提前提示靠右、進待轉格、等號誌；不需要就提示提前靠左直接左轉。
待轉格圖資來自本 repo 的 DieTurn 航拍辨識（1,344 格、757 個台北市路口）。

Mapbox GL JS + React + Vite，**純前端**：沒有自建後端，所有資料來自瀏覽器直接呼叫的 API 與靜態 GeoJSON。

## 啟動

```bash
cd apps/howtoturn
npm install
cp .env.example .env.local   # 填入 Mapbox public token
npm run dev                   # 桌機開發（模擬行駛可用）
npm run dev:phone             # 區網 HTTPS，手機才拿得到 GPS / 語音 / 螢幕常亮
```

`dev:phone` 用自簽憑證，手機第一次開要按「仍要前往」。用手機掃 terminal 印出的 Network 網址即可。

## 待轉判斷怎麼做

路由引擎（Mapbox Directions）不知道待轉這件事，判斷是我們疊在每個左轉 step 上的，見 `src/lib/twoStageLeft.ts`：

1. 從 Directions 取每個左轉的 maneuver 座標、進入方位 f、離開方位 e。
2. 依道交規則 §99「先直行至前方路口右側待轉區」，在路口 55 m 內找中心落在 **f 的前方右側象限**、軸線與道路平行的待轉格。
3. 找到 → `required`（提示靠右待轉）；沒找到但路口在 2,556 張航拍範圍內 → `direct`（提示靠左直接左轉）；不在範圍 → `unknown`（一般左轉，不敢說可以直接左轉）。

離線自我測試：`npm run check:twostage`。真實路線檢查：`npm run check:route -- "lng,lat" "lng,lat"`。

## 導航運行時

| 模組 | 做什麼 |
|---|---|
| `lib/location.ts` | 位置來源：`GpsProvider`（watchPosition 高精度）與 `SimulatedProvider`（沿路線模擬，可觸發偏離） |
| `lib/routeProgress.ts` | GPS 點投影到路線、沿線距離、目前 step、偏離判定（連續 3 筆 > 35 m） |
| `lib/guidance.ts` | 導引狀態機：播報時機、待轉四階段（靠右 → 進格 → 等燈 → 完成）、車道指引、速限、事故提醒 |
| `lib/voice.ts` | Web Speech 繁中語音，由「開始導航」手勢解鎖 |
| `components/Navigation.tsx` | 60 fps 內插 puck 與相機、偏離時以目前朝向重新規劃、抵達畫面 |
| `components/MapView.tsx` | 導航樣式（日/夜）、puck 與精度圈、路線漸層（走過變灰、路況上色）、轉彎箭頭、3D 建築、即時路況 |

## 資料更新

```bash
# 在 repo 根目錄，重跑 DieTurn 產出後
python3 geodata/export_app.py     # → public/geojson/taipei_waiting_zones.geojson + taipei_surveyed_intersections.geojson
```

## 部署到 GitHub Pages

`vite.config.ts` 使用 `base: './'`，`npm run build` 產出的 `dist/` 放在任何路徑下都能跑。
Mapbox token 是前端 public token，會出現在打包結果中，建議到 Mapbox 後台為 token 設定 URL 限制。

## 已知限制

- Mapbox Directions 沒有機車 profile，機車走 driving-traffic 路網；禁行機車路段、快速道路限制目前不會避開。
- 「避開待轉」是用繞行 waypoint 產生的替代路線再重新評分，不是路由引擎內建的成本；自架 OSRM 才能做到真正的最佳解。
- 待轉格只有台北市 757 個路口；其他地方左轉一律顯示「依路口標誌待轉」。
- Nominatim 官方政策不鼓勵逐字元 autocomplete，程式已設 600 ms debounce。
