function stripTags(input = "") {
  return input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function scoreSignal(kind, text, attrs) {
  const value = `${text} ${attrs}`.toLowerCase();
  let score = 1;
  if (kind === "button") score += 2;
  if (kind === "input" && /submit|button/.test(value)) score += 2;
  if (/btn|button|cta|primary/.test(value)) score += 2;
  if (/contact|start|book|demo|buy|shop|partner|join|立即|聯絡|開始|諮詢|購買|註冊|方案/.test(value)) score += 3;
  if (/read more|learn more|explore|discover|了解|更多|探索/.test(value)) score += 1;
  return Math.min(10, score);
}

function detectSections(html) {
  const lower = html.toLowerCase();
  return {
    headerEnd: Math.max(
      lower.lastIndexOf("</header>"),
      lower.lastIndexOf("</nav>"),
      0
    ),
    footerStart: (() => {
      const idx = lower.indexOf("<footer");
      return idx > 0 ? idx : Math.floor(html.length * 0.88);
    })(),
    heroEnd: (() => {
      for (const kw of ["hero", "banner", "jumbotron", "slider", "carousel"]) {
        const i = lower.indexOf(kw);
        if (i > 0) {
          const close = lower.indexOf("</section>", i);
          if (close > 0) return close;
        }
      }
      return Math.floor(html.length * 0.2);
    })(),
  };
}

function xHintFromContext(index, attrs, sections, html) {
  const lower = (attrs || "").toLowerCase();
  if (index < sections.headerEnd) return "nav";
  if (/hero|banner|jumbotron|cta|call-to-action/.test(lower)) return "center";
  if (/\bcol-\w*-?[1-4]\b|left|float-left/.test(lower)) return "left";
  if (/\bcol-\w*-?[8-9]\b|\bcol-\w*-1[0-2]\b|right|float-right/.test(lower)) return "right";
  if (index < sections.heroEnd) return "center";
  return "center";
}

function extractSignals(html) {
  const signals = [];
  const totalLen = Math.max(1, html.length);
  const sections = detectSections(html);
  const mainLen = Math.max(1, sections.footerStart - sections.headerEnd);

  const buttonRe = /<(button)\b([^>]*)>([\s\S]*?)<\/button>/gi;
  const linkRe = /<(a)\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const inputRe = /<(input)\b([^>]*)\/?>/gi;

  function pushFromMatch(kind, attrs, body, index) {
    const text = stripTags(body || "");
    const attrsText = stripTags(attrs || "");
    const priority = scoreSignal(kind, text, attrsText);

    let positionRatio;
    if (index < sections.headerEnd) {
      positionRatio = (index / Math.max(1, sections.headerEnd)) * 0.06;
    } else if (index > sections.footerStart) {
      positionRatio = 0.92 + ((index - sections.footerStart) / Math.max(1, totalLen - sections.footerStart)) * 0.08;
    } else {
      positionRatio = 0.06 + ((index - sections.headerEnd) / mainLen) * 0.86;
    }

    signals.push({
      kind,
      text: text || attrsText || kind,
      priority,
      positionRatio,
      xHint: xHintFromContext(index, attrs, sections, html),
    });
  }

  let m;
  while ((m = buttonRe.exec(html))) pushFromMatch("button", m[2], m[3], m.index);
  while ((m = linkRe.exec(html))) pushFromMatch("a", m[2], m[3], m.index);
  while ((m = inputRe.exec(html))) pushFromMatch("input", m[2], m[2], m.index);

  const merged = signals
    .filter((s) => s.text && s.text.length <= 120)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 140);

  return merged;
}

function uniqueUrls(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || !/^https?:\/\//i.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function pickPreviewCandidates(html, pageUrl) {
  const head = html.slice(0, 200000);
  const candidates = [];
  const encoded = encodeURIComponent(pageUrl);

  // Multiple screenshot services tried in order — fullpage variants first
  candidates.push(`https://image.thum.io/get/width/1400/fullpage/noanimate/${encoded}`);
  candidates.push(`https://api.microlink.io/?url=${encoded}&screenshot=true&meta=false&embed=screenshot.url&fullPage=true`);
  candidates.push(`https://image.thum.io/get/width/1400/noanimate/${encoded}`);
  candidates.push(`https://s.wordpress.com/mshots/v1/${encoded}?w=1400&h=900`);

  const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = metaRe.exec(head))) {
    try {
      const abs = new URL(m[1], pageUrl).toString();
      candidates.push(abs);
    } catch {
      // ignore malformed URL
    }
  }
  return uniqueUrls(candidates);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Only GET is supported" });
  }

  const url = String(req.query?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "Invalid url" });
  }

  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 HeatmapProposalBot/1.0" },
    });
    const html = await response.text();
    const signals = extractSignals(html);
    const summary = {
      totalSignals: signals.length,
      buttonCount: signals.filter((s) => s.kind === "button").length,
      linkCount: signals.filter((s) => s.kind === "a").length,
      inputCount: signals.filter((s) => s.kind === "input").length,
    };

    return res.status(200).json({
      signals,
      summary,
      previewCandidates: pickPreviewCandidates(html, url),
    });
  } catch (error) {
    return res.status(500).json({
      error: "Failed to fetch page",
      detail: error.message,
    });
  }
}
