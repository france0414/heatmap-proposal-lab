export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Only GET is supported");
  }

  const url = String(req.query?.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).send("Invalid url");
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 HeatmapProposalBot/1.0",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).send(`Upstream image error (${upstream.status})`);
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).send(`Proxy failed: ${error.message}`);
  }
}
