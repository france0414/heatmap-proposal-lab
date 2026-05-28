# 圖片熱點預測器（提案模式）

不需 GA，可先做零數據預測。  
V2 支援「圖片 + DOM 融合」：貼網址時會抓可互動元素訊號，提升準確度。

## 功能
- 載入來源：
  - 上傳圖片
  - 圖片網址
  - 網頁網址（DOM 融合）
- 熱點圖生成（可下載 PNG）
- 提案報告輸出（可匯出 PDF）
- JSON 報告欄位：
  - `executiveSnapshot`
  - `keyMetrics`
  - `topHotspots`
  - `recommendations`
  - `domSummary`

## 重要部署差異
- `Vercel`：可用 `/api/page-signals`，可做網址 DOM 融合（建議主環境）。
- `GitHub Pages`：只有純前端，無法呼叫本專案 API。

## 新增 API
- `GET /api/page-signals?url=https://example.com`
- 回傳：
  - `signals[]`：可互動元素語意訊號（button/a/input）
  - `summary`
  - `screenshotUrl`
