# Image Heatmap Predictor (Proposal Mode)

This is a zero-data prediction tool for pre-sales/client proposal decks.
No GA required.

## What it does
- Load input from:
  - Local image upload
  - Image URL
  - Page URL (thumbnail screenshot service)
  - Clipboard paste
- Generate prediction heatmap overlay
- Export heatmap as PNG
- Export proposal PDF (browser print-to-PDF flow)
- Output fixed proposal JSON report:
  - `executiveSnapshot`
  - `keyMetrics` (3 key metrics)
  - `topHotspots`
  - `recommendations` (3 proposal suggestions)

## Deploy
- GitHub Pages: static deployment works directly.
- Vercel: static deployment works directly.

## Proposal report shape
```json
{
  "generatedAt": "2026-05-28T00:00:00.000Z",
  "executiveSnapshot": {
    "attentionScore": 78,
    "misTapRiskLevel": "Medium",
    "ctaVisibilityLevel": "High",
    "conclusion": "Predicted focus aligns with the primary call-to-action..."
  },
  "keyMetrics": {
    "primaryCtaFocusShare": "67%",
    "highRiskInteractiveElements": 2,
    "estimatedMisTapRate": "18%"
  },
  "topHotspots": [
    { "rank": 1, "x": 540, "y": 220, "score": 83.7 }
  ],
  "recommendations": [
    {
      "issue": "Primary CTA may not dominate visual hierarchy",
      "recommendation": "Increase color contrast and keep CTA in top-center scanning zone"
    }
  ]
}
```
