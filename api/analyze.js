function analyze(events = [], elements = []) {
  const clicks = events.filter((e) => e.type === "click");
  const deadClicks = clicks.filter((e) => !e.interactive).length;
  let rageClicks = 0;

  for (let i = 1; i < clicks.length; i += 1) {
    const prev = clicks[i - 1];
    const curr = clicks[i];
    if (curr.id === prev.id && curr.t - prev.t < 700) rageClicks += 1;
  }

  const byId = new Map();
  for (const c of clicks) {
    byId.set(c.id, (byId.get(c.id) || 0) + 1);
  }

  const risks = elements
    .map((el) => {
      const clickCount = byId.get(el.id) || 0;
      const tooSmall = (el.w || 0) < 44 || (el.h || 0) < 44;
      const sizePenalty = tooSmall ? 45 : 0;
      const densePenalty = clickCount > 7 ? 15 : 0;
      const deadZonePenalty = !el.isInteractive && clickCount > 0 ? 30 : 0;
      const score = Math.min(100, sizePenalty + densePenalty + deadZonePenalty);
      return {
        id: el.id,
        label: el.label || el.id,
        clickCount,
        tooSmall,
        score,
        level: score >= 70 ? "high" : score >= 30 ? "medium" : "low",
      };
    })
    .sort((a, b) => b.score - a.score);

  return {
    summary: {
      totalClicks: clicks.length,
      deadClicks,
      rageClicks,
      riskElements: risks.filter((r) => r.score >= 30).length,
    },
    risks,
    generatedAt: new Date().toISOString(),
  };
}

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST is supported" });
  }
  const payload = req.body || {};
  const output = analyze(payload.events || [], payload.elements || []);
  return res.status(200).json(output);
}
