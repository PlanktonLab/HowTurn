# HowTurn — 機車導航 App

台灣機車專屬的即時導航。除了帶你到目的地，還會在每個左轉路口告訴你**要不要兩段式待轉**：
需要待轉就提前提示靠右、進待轉格、等號誌；不需要就提示提前靠左直接左轉。
待轉格圖資來自本 repo 的 DieTurn 航拍辨識，依地區記錄涵蓋範圍與可靠度。

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
3. 只有高信心待轉格的 `serves_from_bearing` 符合 f、`serves_to_bearing` 符合 e，而且服務方向不模糊，才標為 `required`（提示靠右待轉並列入不待轉路線成本）。
4. 同路口但服務其他方向的格子不影響這次轉彎；方向或偵測信心不足時標為 `unknown`。只有沒有相關候選、且航拍覆蓋可靠度足夠時，才標為 `direct`。

離線自我測試：`npm run check:twostage`。真實路線檢查：`npm run check:route -- "lng,lat" "lng,lat"`。

## 導航運行時

| 模組 | 做什麼 |
|---|---|
| `lib/location.ts` | 位置來源：`GpsProvider`（watchPosition 高精度）與 `SimulatedProvider`（沿路線模擬，可觸發偏離） |
| `lib/routeProgress.ts` | GPS 點投影到路線、沿線距離、目前 step、偏離判定（連續 3 筆 > 35 m） |
| `lib/guidance.ts` | 導引狀態機：播報時機、待轉四階段（靠右 → 進格 → 等燈 → 完成）、車道指引、速限 |
| `lib/voice.ts` | 瀏覽器使用 Web Speech，Android 使用原生 TextToSpeech |
| `components/Navigation.tsx` | 60 fps 內插 puck 與相機、偏離時以目前朝向重新規劃、抵達畫面 |
| `components/MapView.tsx` | 導航樣式（日/夜）、puck 與精度圈、路線漸層（走過變灰、路況上色）、轉彎箭頭、3D 建築、即時路況 |

## 資料更新

```bash
# 在 repo 根目錄，重跑 DieTurn 產出後
python3 geodata/export_app.py     # → public/geojson/taiwan_waiting_zones.geojson + taiwan_surveyed_intersections.geojson
```

## 部署到 GitHub Pages

`vite.config.ts` 使用 `base: './'`，`npm run build` 產出的 `dist/` 放在任何路徑下都能跑。
Mapbox token 是前端 public token，會出現在打包結果中，建議到 Mapbox 後台為 token 設定 URL 限制。

## 已知限制

- Mapbox 沒有機車專用 profile；目前排除 motorway、ferry，仍不能保證涵蓋所有禁行機車限制。
- 不待轉優先比較服務提供的路線與有限的繞行候選，不能保證找到完全免待轉路線；找不到更少待轉方案時仍保留模式，沿用建議路線並清楚說明。
- 資料範圍或可靠度不足的路口標為未知，不能把未辨識到待轉格當成一定可直接左轉。
- Nominatim 公共服務禁止 autocomplete；目前改由搜尋按鈕或 Enter 明確送出，正式發佈限制見下方。

## Android 與共用介面

App 名稱為 **HowTurn**。React 介面共用於瀏覽器與 Android，Android 透過 Capacitor 包成可安裝 APK；完整建置步驟與本機產物位置見 [ANDROID.md](ANDROID.md)。iOS 尚未建立原生專案或驗證。

起點、目的地可以直接輸入，按搜尋或鍵盤搜尋鍵後再選結果。正在編輯的文字不會被當成已選定座標；清除、換欄位及新搜尋會取消過期請求。汽車／步行選單及事故熱點圖層、統計與導航警示已移除。

路線先顯示基本結果，只有可能減少待轉時才額外查詢最多兩個候選，不強制製造第二條路線。候選必須通過時間、距離、迴轉、重複路線與未知待轉資料檢查。Mapbox 沒有機車專用 profile；目前使用 driving-traffic 排除 motorway、ferry，其他禁行機車限制仍以現場標誌為準。

### 地點服務

目前保留既有 Nominatim 優先／Mapbox 備援。搜尋只由按鈕或 Enter 觸發，不做 Nominatim 自動完成；每台裝置有一秒節流及短期快取，結果顯示來源。此設定供本機開發少量測試；[Nominatim 使用政策](https://operations.osmfoundation.org/policies/nominatim/) 的每秒上限計算全 App 所有使用者，正式發佈需代理服務提供全 App 限流、快取、識別，並能遠端切換服務。

可以設定 `VITE_NOMINATIM_URL` 為自己的搜尋代理，或在 App 啟動前由遠端配置設定 `window.__HOWTURN_CONFIG__.nominatimEndpoint`。僅修改環境變數再重打 APK 不等於遠端切換。不要在公開儲存庫放私密金鑰。

### 搜尋與路線驗證

```bash
npm run check:places
npm run check:routing
```

以上使用 mock 回應，涵蓋搜尋取消、節流、逾時、無結果與連線失敗，以及候選排序、去重、繞路限制、請求數量和路線取消；不會呼叫付費 API。
