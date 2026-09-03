import { createFileRoute } from "@tanstack/react-router";

/**
 * Edge-runtime mirror of server/server.js `POST /api/upload`.
 * Identical request contract (multipart field `image` + x-override-* headers)
 * and identical response shape, so the same frontend drives either backend.
 */

const ALLOWED_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/heic", "image/x-mac-heic", "image/webp"];

type Overrides = {
  blur: boolean;
  smallFace: boolean;
  multiFace: boolean;
  duplicate: boolean;
};

const MIN_FACE_RATIO = 0.08;

function validate(
  mime: string,
  width: number | null,
  height: number | null,
  overrides: Overrides,
): { isValid: boolean; reason?: string } {
  if (!ALLOWED_MIMES.includes(mime.toLowerCase())) return { isValid: false, reason: "INVALID_FORMAT" };
  if (width !== null && height !== null && (width < 600 || height < 600)) {
    return { isValid: false, reason: "RESOLUTION_TOO_SMALL" };
  }
  if (overrides.blur) return { isValid: false, reason: "IMAGE_TOO_BLURRY" };
  if (overrides.smallFace) return { isValid: false, reason: "FACE_TOO_SMALL" };
  if (overrides.multiFace) return { isValid: false, reason: "MULTIPLE_FACES_DETECTED" };
  if (overrides.duplicate) return { isValid: false, reason: "DUPLICATE_IMAGE_DETECTION" };
  return { isValid: true };
}

export const Route = createFileRoute("/api/public/upload")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const form = await request.formData();
          const file = form.get("image");
          if (!(file instanceof File)) {
            return Response.json({ error: "No file resource uploaded." }, { status: 400 });
          }
          if (file.size > 120 * 1024 * 1024) {
            return Response.json({ error: "File exceeds the 120MB limit." }, { status: 413 });
          }

          const overrides: Overrides = {
            blur: request.headers.get("x-override-blur") === "true",
            smallFace: request.headers.get("x-override-small-face") === "true",
            multiFace: request.headers.get("x-override-multi-face") === "true",
            duplicate: request.headers.get("x-override-duplicate") === "true",
          };

          const width = Number(request.headers.get("x-img-width")) || null;
          const height = Number(request.headers.get("x-img-height")) || null;

          const result = validate(file.type, width, height, overrides);

          // Real face validation (AI vision) once the cheap checks pass.
          if (result.isValid) {
            const { detectFacesWithAI } = await import("@/lib/faceCheck.server");
            const faces = await detectFacesWithAI(await file.arrayBuffer(), file.type);
            if (!faces.skipped) {
              if (faces.count === 0) {
                result.isValid = false;
                result.reason = "NO_FACE_DETECTED";
              } else if (faces.count > 1) {
                result.isValid = false;
                result.reason = "MULTIPLE_FACES_DETECTED";
              } else if (faces.largestRatio < MIN_FACE_RATIO) {
                result.isValid = false;
                result.reason = "FACE_TOO_SMALL";
              }
            }
          }

          const record = {
            id: crypto.randomUUID(),
            originalName: file.name,
            mimeType: file.type,
            fileSize: file.size,
            status: result.isValid ? "ACCEPTED" : "REJECTED",
            rejectionReason: result.isValid ? null : result.reason,
            width,
            height,
            imageHash: result.isValid ? "p_hash_" + Math.random().toString(36).substring(7) : null,
            s3Key: result.isValid ? `uploads/${crypto.randomUUID()}-${file.name}` : null,
            createdAt: new Date().toISOString(),
          };

          return Response.json(
            { success: result.isValid, data: record },
            { status: result.isValid ? 201 : 422 },
          );
        } catch {
          return Response.json({ error: "Internal processing loop pipeline failure." }, { status: 500 });
        }
      },
    },
  },
});
