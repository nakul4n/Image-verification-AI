const sharp = require('sharp');
const heicConvert = require('heic-convert');

const ALLOWED_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/x-mac-heic', 'image/webp'];

const MIN_DIMENSION = 600;
const BLUR_VARIANCE_THRESHOLD = 90; // variance-of-Laplacian cutoff
const MIN_FACE_RATIO = 0.08; // face box area must cover >= 8% of the frame
const HAMMING_DUPLICATE_THRESHOLD = 6; // <=6 bits differing => near-duplicate

class ImagePipelineService {
  /** Convert HEIC/HEIF to JPEG so downstream tooling and browsers can read it. */
  async normalize(fileBuffer, originalMime) {
    if (!ALLOWED_MIMES.includes(String(originalMime).toLowerCase())) {
      return { error: 'INVALID_FORMAT' };
    }
    if (String(originalMime).toLowerCase().includes('hei')) {
      try {
        const buffer = await heicConvert({ buffer: fileBuffer, format: 'JPEG', quality: 0.9 });
        return { buffer: Buffer.from(buffer), mime: 'image/jpeg' };
      } catch {
        return { error: 'HEIC_CONVERSION_FAILED' };
      }
    }
    return { buffer: fileBuffer, mime: originalMime };
  }

  /** 64-bit average perceptual hash, returned as a 16-char hex string. */
  async perceptualHash(buffer) {
    const { data } = await sharp(buffer)
      .greyscale()
      .resize(8, 8, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      let nibble = 0;
      for (let b = 0; b < 4; b += 1) nibble = (nibble << 1) | (data[i + b] > avg ? 1 : 0);
      hex += nibble.toString(16);
    }
    return hex;
  }

  static hamming(a, b) {
    if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
    let distance = 0;
    for (let i = 0; i < a.length; i += 1) {
      let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
      while (xor) {
        distance += xor & 1;
        xor >>= 1;
      }
    }
    return distance;
  }

  /** Variance of the Laplacian: low variance == few sharp edges == blurry. */
  async blurScore(buffer) {
    const { data, info } = await sharp(buffer)
      .greyscale()
      .resize(512, 512, { fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const values = [];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const i = y * width + x;
        values.push(
          -4 * data[i] + data[i - 1] + data[i + 1] + data[i - width] + data[i + width]
        );
      }
    }
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    return values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  }

  /**
   * Face detection via a vision model. Contract: { count, largestRatio }. Fails open when unconfigured.
   */
  async detectFaces(buffer, _metadata) {
    const key = process.env.AI_API_KEY || process.env.AI_GATEWAY_KEY || process.env.OPENAI_API_KEY || process.env.LOVABLE_API_KEY;
    const baseUrl = process.env.AI_GATEWAY_URL || 'https://ai.gateway.lovable.dev/v1/chat/completions';
    if (!key) return { count: 1, largestRatio: 0.25, skipped: true };

    const prompt =
      'You are a strict photo-validation service. Reply ONLY with compact JSON: ' +
      '{"count": <integer number of clearly visible HUMAN faces>, "largestRatio": <0-1 fraction of image area covered by the largest human face bounding box>}. ' +
      'Animals, statues, drawings, posters and faces on screens do not count. If none, return {"count":0,"largestRatio":0}.';

    try {
      const jpeg = await sharp(buffer).jpeg({ quality: 80 }).resize(768, 768, { fit: 'inside' }).toBuffer();
      const res = await fetch(baseUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.AI_VISION_MODEL || 'google/gemini-3.7-flash',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
                },
              ],
            },
          ],
        }),
      });
      if (!res.ok) return { count: 1, largestRatio: 0.25, skipped: true };
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content ?? '';
      const match = String(text).match(/\{[\s\S]*\}/);
      if (!match) return { count: 1, largestRatio: 0.25, skipped: true };
      const parsed = JSON.parse(match[0]);
      const count = Number(parsed.count);
      if (!Number.isFinite(count)) return { count: 1, largestRatio: 0.25, skipped: true };
      const largestRatio = Number(parsed.largestRatio);
      return { count, largestRatio: Number.isFinite(largestRatio) ? largestRatio : 0 };
    } catch {
      return { count: 1, largestRatio: 0.25, skipped: true };
    }
  }

  /**
   * Full validation run.
   * @param existingHashes list of { id, imageHash } to compare against for duplicates
   */
  async processAndValidate(fileBuffer, originalMime, triggerOverrides = {}, existingHashes = []) {
    const normalized = await this.normalize(fileBuffer, originalMime);
    if (normalized.error) return { isValid: false, reason: normalized.error };

    const buffer = normalized.buffer;
    const metadata = await sharp(buffer).metadata();
    const base = { metadata, buffer, mime: normalized.mime };

    if ((metadata.width || 0) < MIN_DIMENSION || (metadata.height || 0) < MIN_DIMENSION) {
      return { ...base, isValid: false, reason: 'RESOLUTION_TOO_SMALL' };
    }

    const imageHash = await this.perceptualHash(buffer);
    base.imageHash = imageHash;

    // Dev sandbox overrides short-circuit the corresponding real check
    if (triggerOverrides.blur) return { ...base, isValid: false, reason: 'IMAGE_TOO_BLURRY' };
    if (triggerOverrides.smallFace) return { ...base, isValid: false, reason: 'FACE_TOO_SMALL' };
    if (triggerOverrides.multiFace)
      return { ...base, isValid: false, reason: 'MULTIPLE_FACES_DETECTED' };
    if (triggerOverrides.duplicate)
      return { ...base, isValid: false, reason: 'DUPLICATE_IMAGE_DETECTION' };

    const duplicate = existingHashes.find(
      (row) => ImagePipelineService.hamming(row.imageHash, imageHash) <= HAMMING_DUPLICATE_THRESHOLD
    );
    if (duplicate) return { ...base, isValid: false, reason: 'DUPLICATE_IMAGE_DETECTION' };

    const sharpness = await this.blurScore(buffer);
    base.sharpness = sharpness;
    if (sharpness < BLUR_VARIANCE_THRESHOLD) {
      return { ...base, isValid: false, reason: 'IMAGE_TOO_BLURRY' };
    }

    const faces = await this.detectFaces(buffer, metadata);
    if (!faces.skipped && faces.count === 0)
      return { ...base, isValid: false, reason: 'NO_FACE_DETECTED' };
    if (faces.count > 1) return { ...base, isValid: false, reason: 'MULTIPLE_FACES_DETECTED' };
    if (faces.count === 1 && faces.largestRatio < MIN_FACE_RATIO) {
      return { ...base, isValid: false, reason: 'FACE_TOO_SMALL' };
    }

    return { ...base, isValid: true };
  }
}

module.exports = new ImagePipelineService();
module.exports.ImagePipelineService = ImagePipelineService;
