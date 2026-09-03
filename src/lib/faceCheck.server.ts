/**
 * Real face validation via AI Gateway vision model.
 * Contract mirrors the Express pipeline hook: { count, largestRatio }.
 */

export type FaceResult = { count: number; largestRatio: number; skipped?: boolean };

const MODEL = process.env["AI_VISION_MODEL"] || "google/gemini-3.7-flash";

const PROMPT = `You are a strict photo-validation service for a portrait upload flow.
Look at the image and answer ONLY with a compact JSON object, no markdown, no prose:
{"count": <integer number of clearly visible HUMAN faces>, "largestRatio": <number 0-1, the fraction of the total image area covered by the bounding box of the largest human face>}
Rules:
- Only count real human faces. Animals, statues, drawings, posters, and faces on screens do NOT count.
- If there are no human faces at all, return {"count": 0, "largestRatio": 0}.
- largestRatio must be 0 when count is 0.`;

export async function detectFacesWithAI(
  bytes: ArrayBuffer,
  mime: string,
): Promise<FaceResult> {
  const key = process.env["AI_API_KEY"] || process.env["OPENAI_API_KEY"] || process.env["LOVABLE_API_KEY"];
  // Fail open when the gateway is unavailable — never block a legit upload on infra.
  if (!key) return { count: 1, largestRatio: 0.25, skipped: true };

  // The vision model reads JPEG/PNG/WebP. HEIC is not decodable here.
  const usable = ["image/jpeg", "image/jpg", "image/png", "image/webp"];
  if (!usable.includes(mime.toLowerCase())) return { count: 1, largestRatio: 0.25, skipped: true };

  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  const dataUrl = `data:${mime};base64,${btoa(binary)}`;

  try {
    const baseUrl = process.env["AI_GATEWAY_URL"] || "https://ai.gateway.lovable.dev/v1/chat/completions";
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error("face-check gateway error", res.status, await res.text().catch(() => ""));
      return { count: 1, largestRatio: 0.25, skipped: true };
    }

    const json: any = await res.json();
    const text: string = json?.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { count: 1, largestRatio: 0.25, skipped: true };
    const parsed = JSON.parse(match[0]);
    const count = Number(parsed.count);
    const largestRatio = Number(parsed.largestRatio);
    if (!Number.isFinite(count)) return { count: 1, largestRatio: 0.25, skipped: true };
    return { count, largestRatio: Number.isFinite(largestRatio) ? largestRatio : 0 };
  } catch (err) {
    console.error("face-check failed", err);
    return { count: 1, largestRatio: 0.25, skipped: true };
  }
}
