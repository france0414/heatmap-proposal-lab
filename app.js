const state = {
  image: null,
  report: null,
  sourceLabel: "未知來源",
  lastPoints: [],
  domSignals: [],
  domSummary: null,
};

const ui = {
  fileInput: document.getElementById("image-file"),
  imageUrlInput: document.getElementById("image-url"),
  pageUrlInput: document.getElementById("page-url"),
  loadImageUrlBtn: document.getElementById("load-image-url-btn"),
  loadPageUrlBtn: document.getElementById("load-page-url-btn"),
  predictBtn: document.getElementById("predict-btn"),
  downloadBtn: document.getElementById("download-btn"),
  exportPdfBtn: document.getElementById("export-pdf-btn"),
  hotspotCount: document.getElementById("hotspot-count"),
  heatRadius: document.getElementById("heat-radius"),
  centerBias: document.getElementById("center-bias"),
  domWeight: document.getElementById("dom-weight"),
  hotspotCountLabel: document.getElementById("hotspot-count-label"),
  heatRadiusLabel: document.getElementById("heat-radius-label"),
  centerBiasLabel: document.getElementById("center-bias-label"),
  domWeightLabel: document.getElementById("dom-weight-label"),
  outputJson: document.getElementById("output-json"),
  canvas: document.getElementById("preview-canvas"),
};

function updateSliderLabels() {
  ui.hotspotCountLabel.textContent = `${ui.hotspotCount.value} 個熱點`;
  ui.heatRadiusLabel.textContent = `${ui.heatRadius.value}px 半徑`;
  ui.centerBiasLabel.textContent = `${ui.centerBias.value}%`;
  ui.domWeightLabel.textContent = `${ui.domWeight.value}%`;
}

function createCanvasContext() {
  return ui.canvas.getContext("2d");
}

function fitCanvasToImage(img) {
  const maxWidth = 1040;
  const scale = Math.min(1, maxWidth / img.width);
  ui.canvas.width = Math.round(img.width * scale);
  ui.canvas.height = Math.round(img.height * scale);
  return scale;
}

function drawBaseImage() {
  if (!state.image) return;
  const ctx = createCanvasContext();
  const scale = fitCanvasToImage(state.image);
  ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
  ctx.drawImage(state.image, 0, 0, Math.round(state.image.width * scale), Math.round(state.image.height * scale));
}

function createImageFromUrl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("載入圖片失敗"));
    img.src = src;
  });
}

function makePlaceholderImageDataUrl(pageUrl) {
  const title = `網址預覽載入失敗`;
  const escaped = pageUrl.replace(/[<>&"]/g, "");
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900">
  <rect width="100%" height="100%" fill="#0f1620"/>
  <text x="70" y="140" fill="#e6edf9" font-size="48" font-family="Arial">Heatmap Preview Fallback</text>
  <text x="70" y="220" fill="#a6b4cc" font-size="30" font-family="Arial">${title}</text>
  <text x="70" y="290" fill="#7f91ad" font-size="24" font-family="Arial">${escaped}</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function proxiedImageUrl(remoteUrl) {
  return `/api/image-proxy?url=${encodeURIComponent(remoteUrl)}`;
}

async function fetchDomSignals(pageUrl) {
  const res = await fetch(`/api/page-signals?url=${encodeURIComponent(pageUrl)}`);
  if (!res.ok) throw new Error(`DOM 擷取失敗 (${res.status})`);
  const data = await res.json();
  return {
    signals: data.signals || [],
    summary: data.summary || null,
    previewCandidates: data.previewCandidates || [],
  };
}

async function setImageFromUrl(url, label = "圖片網址") {
  const img = await createImageFromUrl(url);
  state.image = img;
  state.report = null;
  state.lastPoints = [];
  state.sourceLabel = label;
  drawBaseImage();
}

function setImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await setImageFromUrl(reader.result, `上傳檔案：${file.name}`);
        state.domSignals = [];
        state.domSummary = null;
        ui.outputJson.textContent = "圖片已載入，請按「生成預測」。";
        resolve();
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("讀取檔案失敗"));
    reader.readAsDataURL(file);
  });
}

function scoreVisualPoint(x, y, width, height, centerBias) {
  const cx = width * 0.5;
  const cy = height * 0.42;
  const dx = (x - cx) / width;
  const dy = (y - cy) / height;
  const d = Math.sqrt(dx * dx + dy * dy);
  const centerScore = Math.max(0, 1 - d * 2.2) * (centerBias / 100);
  const topFoldScore = y < height * 0.65 ? 0.35 : 0.08;
  const leftToRightScan = x < width * 0.6 ? 0.15 : 0.05;
  return centerScore + topFoldScore + leftToRightScan + Math.random() * 0.12;
}

function generateVisualHotspots(width, height, count, centerBias) {
  const points = [];
  for (let i = 0; i < count * 20; i += 1) {
    const x = Math.round(Math.random() * width);
    const y = Math.round(Math.random() * height);
    points.push({ x, y, score: scoreVisualPoint(x, y, width, height, centerBias), source: "visual" });
  }
  points.sort((a, b) => b.score - a.score);

  const selected = [];
  for (const p of points) {
    const tooClose = selected.some((s) => {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      return Math.sqrt(dx * dx + dy * dy) < Math.min(width, height) * 0.06;
    });
    if (!tooClose) selected.push(p);
    if (selected.length >= count) break;
  }
  return selected;
}

function generateDomHotspots(width, height, signals, count) {
  if (!signals.length) return [];
  const ranked = [...signals].sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, count * 2);

  return ranked.map((s, idx) => {
    const ratio = typeof s.positionRatio === "number" ? s.positionRatio : idx / Math.max(1, ranked.length - 1);
    const y = Math.round(height * (0.08 + 0.84 * Math.min(1, Math.max(0, ratio))));
    let x = width * 0.52;
    if (s.kind === "a") x = width * 0.42;
    if (s.kind === "nav") x = width * 0.62;
    if (s.priority >= 5) x = width * 0.5;
    return {
      x: Math.round(x + (Math.random() - 0.5) * width * 0.08),
      y: Math.round(y + (Math.random() - 0.5) * height * 0.05),
      score: Math.min(1.4, 0.65 + (s.priority || 0) * 0.12),
      source: "dom",
      label: s.text || s.kind || "element",
    };
  });
}

function fusePoints(visualPoints, domPoints, domWeightPct, maxCount) {
  const domWeight = Math.min(1, Math.max(0, domWeightPct / 100));
  const visualWeight = 1 - domWeight;

  const weighted = [
    ...visualPoints.map((p) => ({ ...p, score: p.score * (0.6 + visualWeight) })),
    ...domPoints.map((p) => ({ ...p, score: p.score * (0.5 + domWeight) })),
  ].sort((a, b) => b.score - a.score);

  const picked = [];
  for (const p of weighted) {
    const tooClose = picked.some((s) => {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      return Math.sqrt(dx * dx + dy * dy) < 46;
    });
    if (!tooClose) picked.push(p);
    if (picked.length >= maxCount) break;
  }
  return picked;
}

function drawHeatmap(points, radius) {
  if (!state.image) return;
  drawBaseImage();
  const ctx = createCanvasContext();
  ctx.globalCompositeOperation = "lighter";
  for (const p of points) {
    const score = Math.max(0.12, Math.min(1.35, p.score));
    const outerR = Math.max(24, radius * (0.85 + score * 0.6));
    const coreR = Math.max(12, radius * (0.3 + score * 0.35));

    const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, outerR);
    g.addColorStop(0, `rgba(255,255,210,${0.46 + score * 0.2})`);
    g.addColorStop(0.18, `rgba(255,182,66,${0.42 + score * 0.2})`);
    g.addColorStop(0.42, `rgba(255,96,42,${0.34 + score * 0.2})`);
    g.addColorStop(0.72, `rgba(224,48,36,${0.18 + score * 0.14})`);
    g.addColorStop(1, "rgba(224,48,36,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, outerR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = `rgba(255,236,170,${0.22 + score * 0.2})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, coreR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

function levelFromValue(v) {
  if (v >= 75) return "高";
  if (v >= 45) return "中";
  return "低";
}

function buildProposalReport(points) {
  const sorted = [...points].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, 3);
  const attentionScore = Math.min(100, Math.round((top.reduce((acc, p) => acc + p.score * 36, 0) / 3) * 1.35));
  const ctaVisibility = Math.min(100, Math.round((top[0]?.score || 0) * 88));
  const misTapRisk = Math.max(0, 100 - ctaVisibility + Math.round(Math.random() * 10));
  const domCount = state.domSignals.length;

  return {
    generatedAt: new Date().toISOString(),
    executiveSnapshot: {
      attentionScore,
      misTapRiskLevel: levelFromValue(misTapRisk),
      ctaVisibilityLevel: levelFromValue(ctaVisibility),
      conclusion:
        domCount > 0
          ? "本次已使用 DOM + 圖片融合，CTA 覆蓋更接近真實互動。"
          : "本次為純圖片預測，建議加上網址 DOM 融合可提高準確度。",
    },
    keyMetrics: {
      primaryCtaFocusShare: `${Math.min(95, Math.max(18, Math.round(ctaVisibility * 0.85)))}%`,
      highRiskInteractiveElements: Math.max(1, Math.round(misTapRisk / 24)),
      estimatedMisTapRate: `${Math.max(3, Math.round(misTapRisk * 0.42))}%`,
      domSignals: domCount,
    },
    topHotspots: top.map((p, idx) => ({
      rank: idx + 1,
      x: p.x,
      y: p.y,
      score: Number((p.score * 100).toFixed(1)),
      source: p.source,
      label: p.label || null,
    })),
    recommendations: [
      { issue: "主要 CTA 視覺主導性不足", recommendation: "提高 CTA 對比，放在上方偏中央操作路徑" },
      { issue: "互動區過密，可能增加誤觸", recommendation: "點擊區至少 44x44，並增加按鈕間距" },
      { issue: "首屏焦點競爭，路徑不夠單一", recommendation: "降低裝飾干擾，保留明確單一 CTA" },
    ],
    domSummary: state.domSummary,
  };
}

function drawRiskOverlayImage(points) {
  if (!state.image) return "";
  const overlay = document.createElement("canvas");
  overlay.width = ui.canvas.width;
  overlay.height = ui.canvas.height;
  const ctx = overlay.getContext("2d");
  ctx.drawImage(ui.canvas, 0, 0);
  const topPoints = [...points].sort((a, b) => b.score - a.score).slice(0, 3);

  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffffff";
  ctx.fillStyle = "rgba(14,21,30,0.78)";
  ctx.font = "bold 14px Arial";
  topPoints.forEach((p, idx) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(String(idx + 1), p.x - 4, p.y + 5);
    ctx.fillStyle = "rgba(14,21,30,0.78)";
  });
  return overlay.toDataURL("image/png");
}

function exportProposalPdf() {
  if (!state.image || !state.report) {
    ui.outputJson.textContent = "請先生成預測，再匯出 PDF。";
    return;
  }

  const originalCanvas = document.createElement("canvas");
  originalCanvas.width = ui.canvas.width;
  originalCanvas.height = ui.canvas.height;
  const octx = originalCanvas.getContext("2d");
  octx.drawImage(state.image, 0, 0, ui.canvas.width, ui.canvas.height);

  const r = state.report;
  const originalPng = originalCanvas.toDataURL("image/png");
  const heatmapPng = ui.canvas.toDataURL("image/png");
  const riskPng = drawRiskOverlayImage(state.lastPoints);

  const html = `
  <!doctype html><html><head><meta charset="UTF-8" /><title>熱點提案報告</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #122b26; }
    h1, h2 { margin: 0 0 8px; }
    .meta { color: #5b6a64; margin-bottom: 14px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; margin: 14px 0; }
    .card { border: 1px solid #d8ded4; border-radius: 8px; padding: 10px; }
    .label { color: #5b6a64; font-size: 12px; }
    .value { font-size: 20px; font-weight: 700; margin-top: 2px; }
    img { width: 100%; border: 1px solid #d8ded4; border-radius: 8px; margin: 8px 0 14px; }
    .list { border: 1px solid #d8ded4; border-radius: 8px; padding: 10px; margin-bottom: 8px; }
  </style></head><body>
    <h1>熱點提案報告</h1>
    <div class="meta">來源：${state.sourceLabel} | 產生時間：${new Date(r.generatedAt).toLocaleString()}</div>
    <h2>摘要總覽</h2>
    <div class="grid">
      <div class="card"><div class="label">注意力分數</div><div class="value">${r.executiveSnapshot.attentionScore}</div></div>
      <div class="card"><div class="label">誤觸風險</div><div class="value">${r.executiveSnapshot.misTapRiskLevel}</div></div>
      <div class="card"><div class="label">CTA 可見度</div><div class="value">${r.executiveSnapshot.ctaVisibilityLevel}</div></div>
    </div>
    <div class="list"><strong>結論：</strong>${r.executiveSnapshot.conclusion}</div>
    <h2>三大指標</h2>
    <div class="grid">
      <div class="card"><div class="label">主 CTA 焦點占比</div><div class="value">${r.keyMetrics.primaryCtaFocusShare}</div></div>
      <div class="card"><div class="label">高風險互動元件數</div><div class="value">${r.keyMetrics.highRiskInteractiveElements}</div></div>
      <div class="card"><div class="label">預估誤觸率</div><div class="value">${r.keyMetrics.estimatedMisTapRate}</div></div>
    </div>
    <h2>視覺輸出</h2>
    <div class="label">1) 原始畫面</div><img src="${originalPng}" />
    <div class="label">2) 熱點疊圖</div><img src="${heatmapPng}" />
    <div class="label">3) 風險標記</div><img src="${riskPng}" />
  </body></html>`;

  const win = window.open("", "_blank");
  if (!win) {
    ui.outputJson.textContent = "瀏覽器封鎖彈出視窗，請允許後再匯出。";
    return;
  }
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
}

function predict() {
  if (!state.image) {
    ui.outputJson.textContent = "請先載入圖片或網址。";
    return;
  }

  const count = Number(ui.hotspotCount.value);
  const radius = Number(ui.heatRadius.value);
  const centerBias = Number(ui.centerBias.value);
  const domWeight = Number(ui.domWeight.value);

  const visualPoints = generateVisualHotspots(ui.canvas.width, ui.canvas.height, count, centerBias);
  const domPoints = generateDomHotspots(ui.canvas.width, ui.canvas.height, state.domSignals, count);
  const points = fusePoints(visualPoints, domPoints, domWeight, count);

  drawHeatmap(points, radius);
  state.lastPoints = points;
  state.report = buildProposalReport(points);
  ui.outputJson.textContent = JSON.stringify(state.report, null, 2);
}

function downloadHeatmap() {
  if (!ui.canvas.width || !ui.canvas.height) return;
  const link = document.createElement("a");
  link.href = ui.canvas.toDataURL("image/png");
  link.download = `heatmap-proposal-${Date.now()}.png`;
  link.click();
}

async function loadPreviewFromCandidates(candidates, pageUrl) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (const c of list) {
    try {
      await setImageFromUrl(proxiedImageUrl(c), `網頁網址：${pageUrl}`);
      return true;
    } catch {
      // Try next candidate
    }
  }
  await setImageFromUrl(makePlaceholderImageDataUrl(pageUrl), `網頁網址：${pageUrl}（fallback）`);
  return false;
}

async function loadPageWithDom() {
  const pageUrl = ui.pageUrlInput.value.trim();
  if (!pageUrl) return;
  ui.outputJson.textContent = "載入網址與 DOM 訊號中...";

  const domData = await fetchDomSignals(pageUrl);
  state.domSignals = domData.signals;
  state.domSummary = domData.summary;
  const ok = await loadPreviewFromCandidates(domData.previewCandidates, pageUrl);
  ui.outputJson.textContent = ok
    ? `網址已載入，抓到 ${state.domSignals.length} 個 DOM 訊號，請按「生成預測」。`
    : `DOM 已抓取 (${state.domSignals.length} 個)，但外站圖片被擋，已使用 fallback 畫面。`;
}

function wireEvents() {
  ui.hotspotCount.addEventListener("input", updateSliderLabels);
  ui.heatRadius.addEventListener("input", updateSliderLabels);
  ui.centerBias.addEventListener("input", updateSliderLabels);
  ui.domWeight.addEventListener("input", updateSliderLabels);

  ui.fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await setImageFromFile(file);
    } catch (err) {
      ui.outputJson.textContent = `載入錯誤：${err.message}`;
    }
  });

  ui.loadImageUrlBtn.addEventListener("click", async () => {
    const url = ui.imageUrlInput.value.trim();
    if (!url) return;
    try {
      state.domSignals = [];
      state.domSummary = null;
      await setImageFromUrl(proxiedImageUrl(url), `圖片網址：${url}`);
      ui.outputJson.textContent = "圖片網址已載入，請按「生成預測」。";
    } catch (err) {
      ui.outputJson.textContent = `圖片網址載入失敗：${err.message}`;
    }
  });

  ui.loadPageUrlBtn.addEventListener("click", async () => {
    try {
      await loadPageWithDom();
    } catch (err) {
      ui.outputJson.textContent = `網址載入失敗：${err.message}`;
    }
  });

  ui.predictBtn.addEventListener("click", predict);
  ui.downloadBtn.addEventListener("click", downloadHeatmap);
  ui.exportPdfBtn.addEventListener("click", exportProposalPdf);
}

function bootstrap() {
  updateSliderLabels();
  wireEvents();
  ui.outputJson.textContent = "系統已就緒，請先載入圖片或網頁網址。";
}

bootstrap();
