const state = {
  image: null,
  report: null,
  sourceLabel: "未知來源",
  lastPoints: [],
  domSignals: [],
  domSummary: null,
  saliencyMap: null,
};

const ui = {
  fileInput: document.getElementById("image-file"),
  pageUrlInput: document.getElementById("page-url"),
  loadPageUrlBtn: document.getElementById("load-page-url-btn"),
  domOnlyBtn: document.getElementById("dom-only-btn"),
  pasteBtn: document.getElementById("paste-btn"),
  predictBtn: document.getElementById("predict-btn"),
  downloadBtn: document.getElementById("download-btn"),
  exportPdfBtn: document.getElementById("export-pdf-btn"),
  marketingKitBtn: document.getElementById("marketing-kit-btn"),
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
  const domCount = state.domSignals.length;
  ui.domWeightLabel.textContent = domCount > 0
    ? `${ui.domWeight.value}%（已載入 ${domCount} 個 DOM 訊號）`
    : `${ui.domWeight.value}%（未載入 DOM 訊號）`;
}

function createCanvasContext() {
  return ui.canvas.getContext("2d");
}

function fitCanvasToImage(img) {
  const maxWidth = 1920;
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

function createImageFromUrl(src, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => reject(new Error("圖片載入逾時")), timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("載入圖片失敗")); };
    img.src = src;
  });
}

function makePlaceholderImageDataUrl(pageUrl) {
  const escaped = pageUrl.replace(/[<>&"]/g, "");
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900">
  <rect width="100%" height="100%" fill="#0f1620"/>
  <text x="70" y="140" fill="#e6edf9" font-size="48" font-family="Arial">Heatmap Preview Fallback</text>
  <text x="70" y="220" fill="#a6b4cc" font-size="30" font-family="Arial">網址預覽載入失敗</text>
  <text x="70" y="290" fill="#7f91ad" font-size="24" font-family="Arial">${escaped}</text>
</svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function proxiedImageUrl(remoteUrl) {
  return `/api/image-proxy?url=${encodeURIComponent(remoteUrl)}`;
}

// ── Loading state ────────────────────────────────────────────────────────────

function setLoading(active) {
  [ui.loadPageUrlBtn, ui.domOnlyBtn, ui.pasteBtn, ui.predictBtn, ui.marketingKitBtn].forEach((btn) => {
    btn.disabled = active;
  });
}

// ── Image saliency analysis ──────────────────────────────────────────────────

async function fetchSaliencyFromApi(width, height) {
  try {
    const dataUrl = ui.canvas.toDataURL("image/jpeg", 0.85);
    const res = await fetch("/api/saliency", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.points?.length) return null;

    const scaleX = width / data.width;
    const scaleY = height / data.height;
    const canvasStep = Math.max(6, Math.round(data.step * (scaleX + scaleY) / 2));
    const map = new Map();
    for (const p of data.points) {
      const cx = Math.round((p.x * scaleX) / canvasStep) * canvasStep;
      const cy = Math.round((p.y * scaleY) / canvasStep) * canvasStep;
      const key = `${cx},${cy}`;
      if ((map.get(key) || 0) < p.s) map.set(key, p.s);
    }
    return { map, step: canvasStep };
  } catch {
    return null;
  }
}

function buildSaliencyMap(width, height) {
  const ctx = createCanvasContext();
  let imageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    return null; // canvas tainted, skip
  }
  const data = imageData.data;
  const step = Math.max(6, Math.round(Math.min(width, height) / 90));
  const map = new Map();

  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      map.set(`${x},${y}`, computePixelSaliency(data, x, y, width, step));
    }
  }
  return { map, step };
}

function computePixelSaliency(data, x, y, width, step) {
  const getPixel = (px, py) => {
    const i = (py * width + px) * 4;
    return [data[i] / 255, data[i + 1] / 255, data[i + 2] / 255];
  };

  const [r, g, b] = getPixel(x, y);
  const luma = r * 0.299 + g * 0.587 + b * 0.114;

  // Local contrast against 6 neighbors
  const offsets = [[-step, 0], [step, 0], [0, -step], [0, step], [-step, -step], [step, step]];
  let contrast = 0;
  for (const [dx, dy] of offsets) {
    const [nr, ng, nb] = getPixel(x + dx, y + dy);
    const nLuma = nr * 0.299 + ng * 0.587 + nb * 0.114;
    contrast += Math.abs(luma - nLuma);
  }
  contrast /= offsets.length;

  const saturation = Math.max(r, g, b) - Math.min(r, g, b);
  const warmth = Math.max(0, r - Math.max(g, b)); // reds/warm tones attract attention

  return Math.min(1, contrast * 0.5 + saturation * 0.3 + warmth * 0.2);
}

// ── Hotspot generation ───────────────────────────────────────────────────────

function scoreVisualPoint(x, y, width, height, centerBias) {
  const cx = width * 0.5;
  const cy = height * 0.42;
  const dx = (x - cx) / width;
  const dy = (y - cy) / height;
  const d = Math.sqrt(dx * dx + dy * dy);
  const centerScore = Math.max(0, 1 - d * 2.2) * (centerBias / 100);
  const topFoldScore = y < height * 0.65 ? 0.35 : 0.08;
  const leftToRightScan = x < width * 0.6 ? 0.15 : 0.05;
  return centerScore + topFoldScore + leftToRightScan;
}

function generateVisualHotspots(width, height, count, centerBias) {
  const saliency = state.saliencyMap;
  const points = [];

  for (let i = 0; i < count * 20; i++) {
    const x = Math.round(Math.random() * width);
    const y = Math.round(Math.random() * height);
    const geoScore = scoreVisualPoint(x, y, width, height, centerBias);

    let imageScore = 0;
    if (saliency) {
      const sx = Math.round(x / saliency.step) * saliency.step;
      const sy = Math.round(y / saliency.step) * saliency.step;
      imageScore = saliency.map.get(`${sx},${sy}`) || 0;
    }

    // When image data is available, weight it 65% vs 35% geometric
    const score = saliency
      ? geoScore * 0.35 + imageScore * 0.65 + Math.random() * 0.04
      : geoScore + Math.random() * 0.12;

    points.push({ x, y, score, source: "visual" });
  }

  points.sort((a, b) => b.score - a.score);
  const minDist = Math.min(width, height) * 0.06;
  const selected = [];
  for (const p of points) {
    const tooClose = selected.some((s) => {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      return Math.sqrt(dx * dx + dy * dy) < minDist;
    });
    if (!tooClose) selected.push(p);
    if (selected.length >= count) break;
  }
  return selected;
}

function generateDomHotspots(width, height, signals, count) {
  if (!signals.length) return [];
  const ranked = [...signals].sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, count * 2);

  // Track nav index to spread nav items horizontally
  let navCount = 0;
  const navTotal = ranked.filter((s) => s.xHint === "nav").length;

  return ranked.map((s) => {
    const ratio = typeof s.positionRatio === "number" ? s.positionRatio : 0.5;
    const y = Math.round(height * Math.min(0.97, Math.max(0.02, ratio)));

    let x;
    switch (s.xHint) {
      case "nav":
        // Spread nav items evenly across the top bar
        x = width * (0.1 + (navCount++ / Math.max(1, navTotal - 1)) * 0.8);
        break;
      case "left":
        x = width * (0.18 + Math.random() * 0.12);
        break;
      case "right":
        x = width * (0.7 + Math.random() * 0.12);
        break;
      default:
        // Center with slight spread based on priority
        x = width * (0.38 + Math.random() * 0.24);
    }

    return {
      x: Math.round(Math.max(20, Math.min(width - 20, x))),
      y: Math.round(y + (Math.random() - 0.5) * height * 0.02),
      score: Math.min(1.4, 0.7 + (s.priority || 0) * 0.12),
      source: "dom",
      label: s.text || s.kind || "element",
    };
  });
}

function fusePoints(visualPoints, domPoints, domWeightPct, maxCount) {
  const domWeight = Math.min(1, Math.max(0, domWeightPct / 100));
  const visualWeight = 1 - domWeight;
  const minDist = Math.max(36, Math.min(ui.canvas.width, ui.canvas.height) * 0.04);

  const weighted = [
    ...visualPoints.map((p) => ({ ...p, score: p.score * (0.6 + visualWeight) })),
    ...domPoints.map((p) => ({ ...p, score: p.score * (0.5 + domWeight) })),
  ].sort((a, b) => b.score - a.score);

  const picked = [];
  for (const p of weighted) {
    const tooClose = picked.some((s) => {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      return Math.sqrt(dx * dx + dy * dy) < minDist;
    });
    if (!tooClose) picked.push(p);
    if (picked.length >= maxCount) break;
  }
  return picked;
}

// ── Heatmap rendering ────────────────────────────────────────────────────────

function thermalColor(t) {
  // blue → cyan → green → yellow → orange → red (no white blowout)
  const stops = [
    [30, 30, 220],
    [0, 160, 255],
    [0, 210, 80],
    [255, 230, 0],
    [255, 100, 0],
    [220, 10, 10],
  ];
  const idx = Math.min(0.9999, t) * (stops.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(stops.length - 1, lo + 1);
  const f = idx - lo;
  return stops[lo].map((v, i) => Math.round(v + (stops[hi][i] - v) * f));
}

function drawHeatmap(points, radius) {
  if (!state.image) return;
  drawBaseImage();
  const ctx = createCanvasContext();
  const W = ui.canvas.width;
  const H = ui.canvas.height;

  // Step 1: accumulate into Float32 directly — bypasses canvas premult-alpha issues
  const intensity = new Float32Array(W * H);
  for (const p of points) {
    const score = Math.max(0.1, Math.min(1.2, p.score));
    const r = Math.max(50, Math.min(radius * 2.0, W * 0.11)) * (0.7 + score * 0.3);
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(p.x - r));
    const x1 = Math.min(W - 1, Math.ceil(p.x + r));
    const y0 = Math.max(0, Math.floor(p.y - r));
    const y1 = Math.min(H - 1, Math.ceil(p.y + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - p.x) ** 2 + (y - p.y) ** 2;
        if (d2 > r2) continue;
        intensity[y * W + x] += score * Math.exp((-d2 / r2) * 3.5);
      }
    }
  }

  // Step 2: p85 of non-zero pixels as ceiling so colours spread from blue to red
  const sample = [];
  const stride = Math.max(1, Math.floor(W * H / 80000));
  for (let i = 0; i < intensity.length; i += stride) {
    if (intensity[i] > 0.005) sample.push(intensity[i]);
  }
  sample.sort((a, b) => a - b);
  const normMax = Math.max(0.001, sample.length ? sample[Math.floor(sample.length * 0.85)] : 1);

  // Step 3: paint thermal colour into ImageData
  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = W;
  colorCanvas.height = H;
  const colorCtx = colorCanvas.getContext("2d");
  const colorData = colorCtx.createImageData(W, H);

  for (let i = 0; i < intensity.length; i++) {
    const linear = Math.min(1, intensity[i] / normMax);
    const t = Math.pow(linear, 0.55);
    if (t < 0.018) continue;
    const [cr, cg, cb] = thermalColor(Math.min(0.99, t));
    const idx = i * 4;
    colorData.data[idx]     = cr;
    colorData.data[idx + 1] = cg;
    colorData.data[idx + 2] = cb;
    colorData.data[idx + 3] = Math.min(205, Math.round(t * 218));
  }
  colorCtx.putImageData(colorData, 0, 0);

  // Step 4: composite thermal layer over base image
  ctx.drawImage(colorCanvas, 0, 0);
}

// ── Report ───────────────────────────────────────────────────────────────────

function levelFromValue(v) {
  if (v >= 75) return "高";
  if (v >= 45) return "中";
  return "低";
}

function formatReport(r) {
  const time = new Date(r.generatedAt).toLocaleString("zh-Hant", { hour12: false });
  const divider = "─".repeat(40);
  const snap = r.executiveSnapshot;
  const km = r.keyMetrics;

  const hotspotLines = r.topHotspots.map((p) => {
    const label = p.label ? `  ${p.label}` : "";
    const src = p.source === "dom" ? "DOM 元素" : "視覺分析";
    return `  #${p.rank}  分數 ${p.score}  位置 (${p.x}, ${p.y})  來源：${src}${label}`;
  });

  const recLines = r.recommendations.map((rec, i) =>
    `  ${i + 1}. 問題：${rec.issue}\n     建議：${rec.recommendation}`
  );

  const domLine = r.domSummary
    ? `  按鈕 ${r.domSummary.buttonCount} 個 ／ 連結 ${r.domSummary.linkCount} 個 ／ 輸入框 ${r.domSummary.inputCount} 個`
    : "  （未載入 DOM 訊號）";

  return [
    divider,
    `  熱點提案報告　${time}`,
    divider,
    "",
    "【摘要】",
    `  注意力分數　　${snap.attentionScore} / 100`,
    `  誤觸風險　　　${snap.misTapRiskLevel}`,
    `  CTA 可見度　　${snap.ctaVisibilityLevel}`,
    `  ${snap.conclusion}`,
    "",
    "【關鍵指標】",
    `  主 CTA 焦點占比　　${km.primaryCtaFocusShare}`,
    `  高風險互動元件數　${km.highRiskInteractiveElements} 個`,
    `  預估誤觸率　　　　${km.estimatedMisTapRate}`,
    "",
    "【DOM 結構】",
    domLine,
    "",
    "【前三熱點】",
    ...hotspotLines,
    "",
    "【優化建議】",
    ...recLines,
    "",
    divider,
  ].join("\n");
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

// ── Marketing Kit ────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function ctaColorClass(level) {
  if (level === "高") return "metric-accent-green";
  if (level === "低") return "metric-accent-red";
  return "metric-accent-yellow";
}

function deriveMarketingCopy(domSignals, report, domain) {
  const topCtaTexts = [...domSignals]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .filter((s) => (s.priority || 0) >= 4 && s.text && s.text.length > 1 && !/^(nav|a|button|input)$/i.test(s.text))
    .slice(0, 5)
    .map((s) => s.text);

  const allText = domSignals.map((s) => s.text || "").join(" ").toLowerCase();
  let industryTag = "";
  if (/shop|buy|cart|purchase|order|產品|購買|加入購物/.test(allText)) industryTag = "電商";
  else if (/book|appointment|schedule|demo|預約|諮詢/.test(allText)) industryTag = "預約服務";
  else if (/join|sign.?up|register|member|加入|註冊|會員/.test(allText)) industryTag = "會員平台";
  else if (/contact|partner|聯絡|合作/.test(allText)) industryTag = "企業服務";
  else if (/start|free|trial|免費|開始|試用/.test(allText)) industryTag = "SaaS / 免費試用";

  const attScore = report.executiveSnapshot.attentionScore;
  const ctaFocus = report.keyMetrics.primaryCtaFocusShare;

  return {
    headline: `讓 ${domain} 的每位訪客都完成轉換`,
    tagline: industryTag
      ? `${industryTag}熱點分析 — 精準找到用戶最關注的互動點`
      : `透過熱點分析，優化您的用戶體驗與轉換漏斗`,
    benefits: [
      {
        title: "精準 CTA 定位",
        desc: topCtaTexts.length > 0
          ? `識別出「${topCtaTexts[0]}」為最高優先 CTA`
          : "優化按鈕視覺層級，確保主 CTA 優先被注意",
      },
      {
        title: `注意力評分 ${attScore} / 100`,
        desc: attScore >= 75
          ? "頁面注意力集中，用戶行為路徑清晰"
          : attScore >= 50
          ? "注意力尚可，仍有提升首屏轉換的空間"
          : "注意力分散，建議簡化視覺層級與訊息結構",
      },
      {
        title: "首屏焦點優化",
        desc: `主 CTA 焦點占比 ${ctaFocus}，確保關鍵行動呼籲出現在首屏視野內`,
      },
    ],
    ctas: [
      { context: "首屏主要 CTA", text: topCtaTexts[0] || "立即開始" },
      { context: "內文次要 CTA", text: topCtaTexts[1] || "了解更多" },
      { context: "社群廣告 CTA", text: topCtaTexts[2] || `探索 ${domain}` },
    ],
  };
}

function generateMarketingKit() {
  if (!state.image || !state.report) {
    ui.outputJson.textContent = "請先生成預測，再匯出行銷套件。";
    return;
  }

  const r = state.report;
  const heatmapPng = ui.canvas.toDataURL("image/png");

  const pageUrl = ui.pageUrlInput.value.trim();
  let domain = state.sourceLabel;
  try { if (pageUrl) domain = new URL(pageUrl).hostname.replace(/^www\./, ""); } catch {}

  const now = new Date().toLocaleDateString("zh-Hant", { year: "numeric", month: "2-digit", day: "2-digit" });
  const copy = deriveMarketingCopy(state.domSignals, r, domain);

  // CTA cards
  const topCtaSignals = [...state.domSignals]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, 6)
    .filter((s) => (s.priority || 0) >= 3);

  const ctaCardsHtml = topCtaSignals.length > 0
    ? topCtaSignals.map((s) => {
        const pct = Math.min(100, Math.round(((s.priority || 0) / 10) * 100));
        const kind = s.kind === "button" ? "按鈕" : s.kind === "input" ? "表單" : "連結";
        const zone = (s.positionRatio || 0) < 0.1 ? "導覽列" : (s.positionRatio || 0) < 0.4 ? "首屏" : (s.positionRatio || 0) < 0.8 ? "中段" : "底部";
        return `<div class="cta-card">
          <div class="cta-type">${kind}</div>
          <div class="cta-text">${escHtml((s.text || s.kind || "").slice(0, 50))}</div>
          <div class="cta-meta">${zone} · 優先度 ${s.priority || 0}/10</div>
          <div class="cta-bar"><div class="cta-bar-fill" style="width:${pct}%"></div></div>
        </div>`;
      }).join("")
    : "<p class='empty-state'>未載入 DOM 訊號，請輸入網址後按「只抓 DOM 訊號」。</p>";

  // Attention fold split
  const CH = ui.canvas.height;
  const aboveFold = state.lastPoints.filter((p) => p.y < CH * 0.5).length;
  const abovePct = Math.round((aboveFold / Math.max(1, state.lastPoints.length)) * 100);

  // Top hotspots rows
  const hotspotsHtml = r.topHotspots.map((p) => `
    <div class="hotspot-row">
      <span class="hotspot-rank">#${p.rank}</span>
      <span class="hotspot-label">${escHtml(p.label || (p.source === "dom" ? "DOM 元素" : "視覺焦點"))}</span>
      <span class="hotspot-score">${p.score} 分</span>
      <span class="hotspot-pos">(${p.x}, ${p.y})</span>
    </div>`).join("");

  // Recommendations
  const recsHtml = r.recommendations.map((rec, i) => `
    <div class="rec-item">
      <div class="rec-num">${i + 1}</div>
      <div>
        <div class="rec-issue">${escHtml(rec.issue)}</div>
        <div class="rec-fix">${escHtml(rec.recommendation)}</div>
      </div>
    </div>`).join("");

  // Benefits grid
  const benefitsHtml = copy.benefits.map((b) => `
    <div class="benefit-item">
      <div class="benefit-title">${escHtml(b.title)}</div>
      <div class="benefit-desc">${escHtml(b.desc)}</div>
    </div>`).join("");

  const ctasHtml = copy.ctas.map((c) => `
    <div class="benefit-item">
      <div class="benefit-title">${escHtml(c.context)}</div>
      <div class="benefit-cta">${escHtml(c.text)}</div>
    </div>`).join("");

  const html = `<!doctype html>
<html lang="zh-Hant"><head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>行銷套件 · ${escHtml(domain)}</title>
<style>
*,*::before,*::after{box-sizing:border-box}
body{font-family:Inter,"Noto Sans TC",Arial,sans-serif;margin:0;background:#0d1117;color:#e6edf3;line-height:1.5}
.page{max-width:900px;margin:0 auto;padding:48px 32px;page-break-after:always}
.kit-header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid #30363d;padding-bottom:24px;margin-bottom:36px}
.kit-brand{font-size:11px;font-weight:700;letter-spacing:.12em;color:#58a6ff;text-transform:uppercase}
.kit-title{font-size:26px;font-weight:800;color:#e6edf3;margin-top:4px}
.kit-meta{font-size:12px;color:#8b949e;text-align:right}
.section-header{font-size:16px;font-weight:700;color:#e6edf3;margin:32px 0 14px;padding-left:12px;border-left:3px solid #58a6ff}
.metrics-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:8px}
.metric-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px}
.metric-value{font-size:28px;font-weight:800;color:#58a6ff}
.metric-label{font-size:11px;color:#8b949e;margin-top:4px}
.metric-accent-green .metric-value{color:#3fb950}
.metric-accent-yellow .metric-value{color:#d29922}
.metric-accent-red .metric-value{color:#f85149}
.heatmap-wrap{border-radius:10px;overflow:hidden;border:1px solid #30363d;margin-bottom:8px}
.heatmap-wrap img{width:100%;display:block}
.cta-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
.cta-card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px}
.cta-type{font-size:10px;font-weight:700;letter-spacing:.08em;color:#58a6ff;text-transform:uppercase;margin-bottom:6px}
.cta-text{font-size:14px;font-weight:600;color:#e6edf3;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cta-meta{font-size:11px;color:#8b949e;margin-bottom:8px}
.cta-bar{height:4px;background:#21262d;border-radius:2px}
.cta-bar-fill{height:100%;background:linear-gradient(90deg,#388bfd,#79c0ff);border-radius:2px}
.fold-split{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:8px}
.fold-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;text-align:center}
.fold-pct{font-size:44px;font-weight:800;color:#3fb950}
.fold-pct.low{color:#8b949e}
.fold-label{font-size:13px;color:#8b949e;margin-top:6px}
.hotspot-row{display:flex;align-items:center;gap:12px;padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:8px}
.hotspot-rank{font-size:11px;font-weight:700;color:#58a6ff;width:28px}
.hotspot-label{flex:1;font-size:13px;color:#e6edf3;font-weight:500}
.hotspot-score{font-size:13px;font-weight:600;color:#3fb950}
.hotspot-pos{font-size:11px;color:#8b949e}
.rec-item{display:flex;gap:16px;align-items:flex-start;padding:16px;background:#161b22;border:1px solid #30363d;border-radius:10px;margin-bottom:10px}
.rec-num{width:28px;height:28px;border-radius:50%;background:#58a6ff;color:#0d1117;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.rec-issue{font-size:14px;font-weight:600;color:#e6edf3}
.rec-fix{font-size:13px;color:#8b949e;margin-top:4px}
.copy-card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:14px}
.copy-label{font-size:10px;font-weight:700;letter-spacing:.1em;color:#58a6ff;text-transform:uppercase;margin-bottom:10px}
.copy-headline{font-size:22px;font-weight:800;color:#e6edf3;margin-bottom:8px}
.copy-sub{font-size:14px;color:#8b949e}
.benefits-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
.benefit-item{background:#0d1117;border-radius:8px;padding:14px}
.benefit-title{font-size:12px;font-weight:600;color:#e6edf3}
.benefit-desc{font-size:12px;color:#8b949e;margin-top:4px}
.benefit-cta{font-size:15px;font-weight:700;color:#58a6ff;margin-top:6px}
.empty-state{color:#8b949e;font-size:13px;font-style:italic;padding:16px}
.kit-footer{margin-top:40px;padding-top:20px;border-top:1px solid #30363d;display:flex;justify-content:space-between;font-size:11px;color:#8b949e}
@media print{
  body{background:#fff;color:#111}
  .metric-card,.cta-card,.fold-card,.hotspot-row,.rec-item,.copy-card,.benefit-item{background:#f6f8fa;border-color:#d0d7de}
  .metric-value,.fold-pct,.hotspot-score,.benefit-cta{color:#0969da}
  .metric-accent-green .metric-value{color:#1a7f37}
  .e6edf3,.kit-title,.rec-issue,.hotspot-label,.benefit-title,.copy-headline{color:#1f2328}
  .8b949e,.kit-meta,.kit-brand,.metric-label,.cta-meta,.fold-label,.hotspot-pos,.rec-fix,.benefit-desc,.copy-sub{color:#636c76}
}
</style>
</head>
<body>

<div class="page">
  <div class="kit-header">
    <div>
      <div class="kit-brand">Heatmap Prediction Lab</div>
      <div class="kit-title">行銷熱點套件 Marketing Kit</div>
    </div>
    <div class="kit-meta">${escHtml(domain)}<br>${now}</div>
  </div>

  <div class="section-header">熱點圖預覽</div>
  <div class="heatmap-wrap"><img src="${heatmapPng}" alt="Heatmap"/></div>

  <div class="section-header">關鍵指標</div>
  <div class="metrics-grid">
    <div class="metric-card">
      <div class="metric-value">${r.executiveSnapshot.attentionScore}</div>
      <div class="metric-label">注意力評分 / 100</div>
    </div>
    <div class="metric-card ${ctaColorClass(r.executiveSnapshot.ctaVisibilityLevel)}">
      <div class="metric-value">${r.keyMetrics.primaryCtaFocusShare}</div>
      <div class="metric-label">主 CTA 焦點占比</div>
    </div>
    <div class="metric-card metric-accent-green">
      <div class="metric-value">${state.domSignals.length || "—"}</div>
      <div class="metric-label">DOM 訊號數量</div>
    </div>
    <div class="metric-card metric-accent-yellow">
      <div class="metric-value">${r.keyMetrics.estimatedMisTapRate}</div>
      <div class="metric-label">預估誤觸率</div>
    </div>
  </div>

  <div class="kit-footer">
    <span>圖片熱點預測器 自動生成</span>
    <span>${escHtml(domain)} · ${now}</span>
  </div>
</div>

<div class="page">
  <div class="kit-header">
    <div>
      <div class="kit-brand">Heatmap Prediction Lab</div>
      <div class="kit-title">CTA 元素分析</div>
    </div>
    <div class="kit-meta">${escHtml(domain)}<br>${now}</div>
  </div>

  <div class="section-header">偵測到的可互動元素</div>
  <div class="cta-grid">${ctaCardsHtml}</div>

  <div class="section-header">注意力分布（首屏 vs 全頁）</div>
  <div class="fold-split">
    <div class="fold-card">
      <div class="fold-pct">${abovePct}%</div>
      <div class="fold-label">首屏熱點占比<br>（頁面前半段）</div>
    </div>
    <div class="fold-card">
      <div class="fold-pct${abovePct > 60 ? " low" : ""}">${100 - abovePct}%</div>
      <div class="fold-label">下方熱點占比<br>（頁面後半段）</div>
    </div>
  </div>

  <div class="section-header">前三熱點</div>
  ${hotspotsHtml}

  <div class="kit-footer">
    <span>圖片熱點預測器 自動生成</span>
    <span>${escHtml(domain)} · ${now}</span>
  </div>
</div>

<div class="page">
  <div class="kit-header">
    <div>
      <div class="kit-brand">Heatmap Prediction Lab</div>
      <div class="kit-title">優化建議 &amp; 文案套件</div>
    </div>
    <div class="kit-meta">${escHtml(domain)}<br>${now}</div>
  </div>

  <div class="section-header">優化建議</div>
  ${recsHtml}

  <div class="section-header">行銷文案建議</div>
  <div class="copy-card">
    <div class="copy-label">主標題 Headline</div>
    <div class="copy-headline">${escHtml(copy.headline)}</div>
    <div class="copy-sub">${escHtml(copy.tagline)}</div>
  </div>
  <div class="copy-card">
    <div class="copy-label">核心優勢 Benefits</div>
    <div class="benefits-grid">${benefitsHtml}</div>
  </div>
  <div class="copy-card">
    <div class="copy-label">呼籲行動 CTA Copy</div>
    <div class="benefits-grid">${ctasHtml}</div>
  </div>

  <div class="kit-footer">
    <span>圖片熱點預測器 自動生成</span>
    <span>${escHtml(domain)} · ${now}</span>
  </div>
</div>

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
  setTimeout(() => win.print(), 600);
}

// ── PDF export ───────────────────────────────────────────────────────────────

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

// ── Core actions ─────────────────────────────────────────────────────────────

async function predict() {
  if (!state.image) {
    ui.outputJson.textContent = "請先載入圖片或網址。";
    return;
  }

  const count = Number(ui.hotspotCount.value);
  const radius = Number(ui.heatRadius.value);
  const centerBias = Number(ui.centerBias.value);
  const domWeight = Number(ui.domWeight.value);

  drawBaseImage();
  ui.outputJson.textContent = "圖片分析中（Sobel 邊緣偵測）...";

  const apiSaliency = await fetchSaliencyFromApi(ui.canvas.width, ui.canvas.height);
  state.saliencyMap = apiSaliency || buildSaliencyMap(ui.canvas.width, ui.canvas.height);
  const saliencySource = apiSaliency ? "Python API" : "Canvas fallback";

  const visualPoints = generateVisualHotspots(ui.canvas.width, ui.canvas.height, count, centerBias);
  const domPoints = generateDomHotspots(ui.canvas.width, ui.canvas.height, state.domSignals, count);
  const points = fusePoints(visualPoints, domPoints, domWeight, count);

  drawHeatmap(points, radius);
  state.lastPoints = points;
  state.report = buildProposalReport(points);
  state.report._saliencySource = saliencySource;
  ui.outputJson.textContent = formatReport(state.report);
}

function downloadHeatmap() {
  if (!ui.canvas.width || !ui.canvas.height) return;
  const link = document.createElement("a");
  link.href = ui.canvas.toDataURL("image/png");
  link.download = `heatmap-proposal-${Date.now()}.png`;
  link.click();
}

async function setImageFromUrl(url, label = "圖片網址") {
  const img = await createImageFromUrl(url);
  state.image = img;
  state.report = null;
  state.lastPoints = [];
  state.saliencyMap = null;
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
        updateSliderLabels();
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

async function loadPreviewFromCandidates(candidates, pageUrl) {
  const list = Array.isArray(candidates) ? candidates : [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const serviceLabel = i === 0 ? "thum.io" : i === 1 ? "WordPress mshots" : i === 2 ? "microlink" : "og:image";
    ui.outputJson.textContent = `嘗試截圖服務 ${serviceLabel}（${i + 1}/${list.length}）...`;
    try {
      await setImageFromUrl(proxiedImageUrl(c), `網頁網址：${pageUrl}`);
      return serviceLabel;
    } catch {
      // Try next candidate
    }
  }
  await setImageFromUrl(makePlaceholderImageDataUrl(pageUrl), `網頁網址：${pageUrl}（fallback）`);
  return null;
}

async function pasteScreenshot() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith("image/"));
      if (imageType) {
        const blob = await item.getType(imageType);
        const url = URL.createObjectURL(blob);
        await setImageFromUrl(url, "剪貼簿截圖");
        URL.revokeObjectURL(url);
        state.domSignals = [];
        state.domSummary = null;
        updateSliderLabels();
        ui.outputJson.textContent = "截圖已貼上，請按「生成預測」。若需 DOM 訊號，請在網頁網址欄貼上網址後按「只抓 DOM 訊號」。";
        return;
      }
    }
    ui.outputJson.textContent = "剪貼簿中沒有圖片，請先截圖（Win+Shift+S 或 Cmd+Shift+4）再貼上。";
  } catch {
    ui.outputJson.textContent = "無法讀取剪貼簿，請確認已授權瀏覽器存取剪貼簿權限，或改用「上傳圖片」。";
  }
}

async function loadDomOnly() {
  const pageUrl = ui.pageUrlInput.value.trim();
  if (!pageUrl) return;
  if (!state.image) {
    ui.outputJson.textContent = "請先上傳截圖（步驟 1），再按「只抓 DOM 訊號」。";
    return;
  }
  ui.outputJson.textContent = "抓取 DOM 訊號中...";
  const domData = await fetchDomSignals(pageUrl);
  state.domSignals = domData.signals;
  state.domSummary = domData.summary;
  updateSliderLabels();
  ui.outputJson.textContent = `DOM 訊號已載入（${state.domSignals.length} 個），截圖保留不變，請按「生成預測」。`;
}

async function loadPageWithDom() {
  const pageUrl = ui.pageUrlInput.value.trim();
  if (!pageUrl) return;
  ui.outputJson.textContent = "載入網址與 DOM 訊號中...";

  const domData = await fetchDomSignals(pageUrl);
  state.domSignals = domData.signals;
  state.domSummary = domData.summary;
  updateSliderLabels();

  const screenshotService = await loadPreviewFromCandidates(domData.previewCandidates, pageUrl);
  if (screenshotService) {
    ui.outputJson.textContent = `網址已載入（截圖來源：${screenshotService}），抓到 ${state.domSignals.length} 個 DOM 訊號，請按「生成預測」。`;
  } else {
    ui.outputJson.textContent = `DOM 已抓取（${state.domSignals.length} 個訊號），但所有截圖服務均失敗，已使用空白畫面。\n建議：手動截圖後使用「上傳圖片」功能，再搭配 DOM 訊號生成更準確的熱點圖。`;
  }
}

// ── Event wiring ─────────────────────────────────────────────────────────────

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

  ui.loadPageUrlBtn.addEventListener("click", async () => {
    setLoading(true);
    try {
      await loadPageWithDom();
    } catch (err) {
      ui.outputJson.textContent = `網址載入失敗：${err.message}`;
    } finally {
      setLoading(false);
    }
  });

  ui.pasteBtn.addEventListener("click", async () => {
    setLoading(true);
    try {
      await pasteScreenshot();
    } finally {
      setLoading(false);
    }
  });

  // 全域 Ctrl+V 貼圖支援
  document.addEventListener("paste", async (e) => {
    const imageFile = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith("image/"));
    if (!imageFile) return;
    e.preventDefault();
    setLoading(true);
    try {
      await setImageFromFile(imageFile);
      ui.outputJson.textContent = "截圖已貼上，請按「生成預測」。若需 DOM 訊號，請在網頁網址欄貼上網址後按「只抓 DOM 訊號」。";
    } catch (err) {
      ui.outputJson.textContent = `貼上失敗：${err.message}`;
    } finally {
      setLoading(false);
    }
  });

  ui.domOnlyBtn.addEventListener("click", async () => {
    setLoading(true);
    try {
      await loadDomOnly();
    } catch (err) {
      ui.outputJson.textContent = `DOM 抓取失敗：${err.message}`;
    } finally {
      setLoading(false);
    }
  });

  ui.predictBtn.addEventListener("click", async () => {
    setLoading(true);
    try {
      await predict();
    } catch (err) {
      ui.outputJson.textContent = `分析失敗：${err.message}`;
    } finally {
      setLoading(false);
    }
  });
  ui.downloadBtn.addEventListener("click", downloadHeatmap);
  ui.exportPdfBtn.addEventListener("click", exportProposalPdf);
  ui.marketingKitBtn.addEventListener("click", generateMarketingKit);
}

function bootstrap() {
  updateSliderLabels();
  wireEvents();
  ui.outputJson.textContent = "系統已就緒，請先載入圖片或網頁網址。";
}

bootstrap();
