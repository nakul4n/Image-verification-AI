export type RejectionReason =
  | "IMAGE_TOO_BLURRY"
  | "FACE_TOO_SMALL"
  | "MULTIPLE_FACES_DETECTED"
  | "NO_FACE_DETECTED"
  | "DUPLICATE_IMAGE_DETECTION"
  | "RESOLUTION_TOO_SMALL"
  | "INVALID_FORMAT"
  | "HEIC_CONVERSION_FAILED";

type RejectionCopy = {
  label: string;
  title: string;
  body: string;
  fixable?: boolean;
};

export const REJECTIONS: Record<RejectionReason, RejectionCopy> = {
  IMAGE_TOO_BLURRY: {
    label: "Blurry face detected",
    title: "Try again",
    body: "We detected a blurry face. Please ensure the face is in focus.",
  },
  FACE_TOO_SMALL: {
    label: "Face is too far away",
    title: "Try again",
    body: "Face is too far from the camera. Please ensure the face is at an appropriate distance.",
    fixable: true,
  },
  MULTIPLE_FACES_DETECTED: {
    label: "Multiple faces detected",
    title: "Try again",
    body: "We detected more than one face. Please upload a photo containing only you.",
  },
  NO_FACE_DETECTED: {
    label: "No face detected",
    title: "Try again",
    body: "We couldn't find a human face in this photo. Please upload a clear photo of yourself.",
  },
  DUPLICATE_IMAGE_DETECTION: {
    label: "Too similar to another upload",
    title: "Try again",
    body: "This photo is nearly identical to another upload. Please add more variety for better results.",
  },
  RESOLUTION_TOO_SMALL: {
    label: "Photo resolution is too low",
    title: "Try again",
    body: "This image is smaller than 600x600px. Please upload a higher resolution photo.",
  },
  INVALID_FORMAT: {
    label: "Unsupported file format",
    title: "Try again",
    body: "We only accept PNG, JPG and HEIC files. Please convert your photo and try again.",
  },
  HEIC_CONVERSION_FAILED: {
    label: "We couldn't read this file",
    title: "Try again",
    body: "This HEIC file could not be converted. Please export it as JPG and re-upload.",
  },
};

export function rejectionCopy(reason: string | null | undefined): RejectionCopy {
  return REJECTIONS[(reason ?? "INVALID_FORMAT") as RejectionReason] ?? REJECTIONS.INVALID_FORMAT;
}
