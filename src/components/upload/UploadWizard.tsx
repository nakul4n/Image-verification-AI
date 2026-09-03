import { useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  CheckSquare,
  ChevronDown,
  Crop,
  FileImage,
  Loader2,
  Trash2,
  X,
  XSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { rejectionCopy } from "@/lib/rejections";
import { DevConsole, EMPTY_OVERRIDES, type Overrides } from "./DevConsole";
import { RejectionLink } from "./RejectionLink";

const TARGET_PHOTOS = 10;
const ENDPOINT = (import.meta.env['VITE_UPLOAD_ENDPOINT'] as string) || "/api/public/upload";

type Item = {
  id: string;
  name: string;
  previewUrl: string;
  state: "uploading" | "accepted" | "rejected";
  reason: string | null;
};

function readDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: 0, height: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** 64-bit average perceptual hash (8x8 grayscale) computed in-browser. */
async function perceptualHash(file: File): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => resolve(null);
      el.src = url;
    });
    if (!img) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 8, 8);
    const { data } = ctx.getImageData(0, 0, 8, 8);
    const gray: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      gray.push(0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!);
    }
    const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
    return gray.map((v) => (v >= mean ? "1" : "0")).join("");
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function hamming(a: string, b: string) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

const DUPLICATE_THRESHOLD = 6; // bits out of 64

function clip(name: string) {
  if (name.length <= 28) return name;
  return `${name.slice(0, 11)}...${name.slice(-14)}`;
}

const ALLOWED_MIMES = ["image/jpeg", "image/jpg", "image/png", "image/heic", "image/heif"];
const ALLOWED_EXT = /\.(jpe?g|png|heic|heif)$/i;
const MIN_BYTES = 1024; // guard against empty/truncated files

/** Pre-upload validation. Returns a rejection reason, or null when the file may be sent. */
function clientRejection(file: File): string | null {
  const mimeOk = file.type ? ALLOWED_MIMES.includes(file.type.toLowerCase()) : false;
  if (!mimeOk && !ALLOWED_EXT.test(file.name)) return "INVALID_FORMAT";
  if (file.size < MIN_BYTES) return "RESOLUTION_TOO_SMALL";
  return null;
}

export function UploadWizard() {
  const [items, setItems] = useState<Item[]>([]);
  const [overrides, setOverrides] = useState<Overrides>(EMPTY_OVERRIDES);
  const [dragging, setDragging] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [openPanel, setOpenPanel] = useState<"req" | "res" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Perceptual hashes of photos currently accepted, keyed by item id. */
  const hashesRef = useRef<Map<string, string>>(new Map());

  const accepted = items.filter((i) => i.state === "accepted");
  const rejected = items.filter((i) => i.state === "rejected");
  const uploading = items.filter((i) => i.state === "uploading");
  const isUploading = uploading.length > 0;
  const atLimit = accepted.length >= TARGET_PHOTOS;
  const progress = useMemo(
    () => Math.min(accepted.length / TARGET_PHOTOS, 1) * 100,
    [accepted.length],
  );

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      const queued: Item[] = Array.from(files).map((file) => ({
        id: crypto.randomUUID(),
        name: file.name,
        previewUrl: URL.createObjectURL(file),
        state: "uploading",
        reason: null,
      }));
      setItems((prev) => [...prev, ...queued]);
      setShowSuccess(false);

      await Promise.all(
        Array.from(files).map(async (file, index) => {
          const item = queued[index];
          if (!item) return;

          // Client-side gate: format + size/resolution, before any network call
          const clientReason = clientRejection(file);
          if (clientReason) {
            setItems((prev) =>
              prev.map((i) =>
                i.id === item.id ? { ...i, state: "rejected", reason: clientReason } : i,
              ),
            );
            return;
          }
          const { width, height } = await readDimensions(file);
          if (width > 0 && (width < 600 || height < 600)) {
            setItems((prev) =>
              prev.map((i) =>
                i.id === item.id ? { ...i, state: "rejected", reason: "RESOLUTION_TOO_SMALL" } : i,
              ),
            );
            return;
          }
          // Near-duplicate detection against already accepted photos (64-bit aHash)
          const hash = await perceptualHash(file);
          if (hash) {
            for (const existing of hashesRef.current.values()) {
              if (hamming(hash, existing) <= DUPLICATE_THRESHOLD) {
                setItems((prev) =>
                  prev.map((i) =>
                    i.id === item.id
                      ? { ...i, state: "rejected", reason: "DUPLICATE_IMAGE_DETECTION" }
                      : i,
                  ),
                );
                return;
              }
            }
            // reserve immediately so two identical files in one batch can't both pass
            hashesRef.current.set(item.id, hash);
          }

          const form = new FormData();
          form.append("image", file);

          try {
            const res = await fetch(ENDPOINT, {
              method: "POST",
              body: form,
              headers: {
                "x-override-blur": String(overrides.blur),
                "x-override-small-face": String(overrides.smallFace),
                "x-override-multi-face": String(overrides.multiFace),
                "x-override-duplicate": String(overrides.duplicate),
                "x-img-width": String(width),
                "x-img-height": String(height),
              },
            });
            const json = await res.json();
            const record = json?.data;
            if (!json?.success) hashesRef.current.delete(item.id);
            setItems((prev) =>
              prev.map((i) =>
                i.id === item.id
                  ? {
                      ...i,
                      state: json?.success ? "accepted" : "rejected",
                      reason: record?.rejectionReason ?? "INVALID_FORMAT",
                    }
                  : i,
              ),
            );
          } catch {
            hashesRef.current.delete(item.id);
            setItems((prev) =>
              prev.map((i) =>
                i.id === item.id ? { ...i, state: "rejected", reason: "INVALID_FORMAT" } : i,
              ),
            );
          }
        }),
      );

      setShowSuccess(true);
    },
    [overrides],
  );

  const remove = (id: string) => {
    hashesRef.current.delete(id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  return (
    <div className="min-h-screen bg-background font-sans">
      <DevConsole overrides={overrides} onChange={setOverrides} />

      {/* Top navigation */}
      <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
        <div className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md brand-gradient text-sm font-black text-brand-foreground">
            A
          </span>
          <span className="text-lg font-extrabold tracking-tight text-foreground">Aragon.ai</span>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="grid size-9 place-items-center rounded-full text-slate-500 transition-colors hover:bg-slate-100 hover:text-foreground"
        >
          <X className="size-5" />
        </button>
      </header>

      {/* Global progress */}
      <div className="border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-bold text-slate-900">Uploaded Images</span>
          <span className="text-sm font-semibold text-slate-500">
            <span className="text-slate-900">{accepted.length}</span> of {TARGET_PHOTOS}
          </span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full brand-gradient transition-[width] duration-500 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <main className="flex flex-col lg:flex-row">
        {/* Left sidebar — 30% */}
        <aside className="w-full border-b border-slate-200 px-6 py-8 lg:w-[30%] lg:border-b-0 lg:border-r">
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-semibold text-slate-500 transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back
          </button>

          <div className="mt-6 grid size-12 place-items-center rounded-xl border border-slate-200 bg-slate-50">
            <TargetPortraitIcon />
          </div>

          <h1 className="mt-5 text-2xl font-extrabold tracking-tight text-slate-900">
            Upload photos
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            Now the fun begins! Select at least 6 of your best photos. Uploading a mix of close-ups,
            selfies and mid-range shots can help the AI better capture your face and body type.
          </p>

          {/* Dropzone */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (atLimit) return;
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (atLimit) return;
              void handleFiles(e.dataTransfer.files);
            }}
            onClick={() => {
              if (atLimit) return;
              inputRef.current?.click();
            }}
            className={cn(
              "mt-6 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-7 text-center transition-colors",
              atLimit ? "cursor-not-allowed opacity-70" : "cursor-pointer",
              dragging && "border-brand bg-brand-soft/40",
            )}
          >
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/heic"
              className="hidden"
              onChange={(e) => {
                void handleFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={isUploading || atLimit}
              title={atLimit ? `Upload limit reached — ${TARGET_PHOTOS} of ${TARGET_PHOTOS} photos accepted` : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-bold shadow-sm transition-colors",
                atLimit
                  ? "cursor-not-allowed bg-slate-200 text-slate-500"
                  : isUploading
                    ? "bg-brand-soft text-brand"
                    : "bg-brand text-brand-foreground hover:opacity-90",
              )}
            >
              {atLimit ? (
                <>
                  <ArrowUp className="size-4" /> Upload limit reached
                </>
              ) : isUploading ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Uploading...
                </>
              ) : (
                <>
                  <ArrowUp className="size-4" /> Upload files
                </>
              )}
            </button>
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              {atLimit ? (
                <>
                  You&apos;ve reached the maximum of {TARGET_PHOTOS} accepted photos.
                  <br />
                  Delete a photo to upload a different one.
                </>
              ) : (
                <>
                  Click to upload or drag and drop
                  <br />
                  PNG, JPG, HEIC up to 120MB
                </>
              )}
            </p>
          </div>

          {/* Queue */}
          {items.length > 0 && (
            <div className="mt-5">
              <p className="text-xs text-slate-400">It can take up to 1 minute to upload</p>
              <ul className="mt-3 space-y-2">
                {items.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                  >
                    <FileImage className="size-4 shrink-0 text-slate-400" />
                    <span className="flex-1 truncate text-xs font-medium text-slate-600">
                      {clip(item.name)}
                    </span>
                    {item.state === "uploading" ? (
                      <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-brand-soft border-t-brand" />
                    ) : item.state === "accepted" ? (
                      <Check className="size-4 shrink-0 text-emerald-600" />
                    ) : (
                      <X className="size-4 shrink-0 text-brand" />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        {/* Right workspace — 70% */}
        <section className="w-full px-6 py-8 lg:w-[70%]">
          {isUploading && (
            <div className="rounded-xl bg-brand-soft/50 px-5 py-4">
              <p className="text-sm font-medium text-slate-700">
                You're almost there! We're just verifying the quality of your uploads to make sure
                you get the best results.
              </p>
            </div>
          )}

          <div className="mt-5 space-y-3">
            <AccordionRow
              icon={<CheckSquare className="size-4 text-emerald-600" />}
              title="Photo Requirements"
              open={openPanel === "req"}
              onToggle={() => setOpenPanel(openPanel === "req" ? null : "req")}
            >
              <ul className="list-disc space-y-1 pl-5">
                <li>Recent photos of just you, taken from different days and locations.</li>
                <li>A mix of close-ups, selfies and mid-range shots.</li>
                <li>Clear, sharp images with your face fully visible.</li>
                <li>Minimum resolution of 600x600px.</li>
              </ul>
            </AccordionRow>
            <AccordionRow
              icon={<XSquare className="size-4 text-brand" />}
              title="Photo Restrictions"
              open={openPanel === "res"}
              onToggle={() => setOpenPanel(openPanel === "res" ? null : "res")}
            >
              <ul className="list-disc space-y-1 pl-5">
                <li>No group photos or photos containing other people.</li>
                <li>No hats, sunglasses or heavy filters.</li>
                <li>No blurry, cropped or low-light images.</li>
                <li>No near-duplicates of another upload.</li>
              </ul>
            </AccordionRow>
          </div>

          {accepted.length > 0 && (
            <div className="mt-10">
              <h2 className="text-xl font-extrabold tracking-tight text-slate-900">
                Accepted Photos
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                These images passed our scoring test and will all be used to generate your AI
                photos.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {accepted.map((item) => (
                  <div key={item.id} className="relative">
                    <img
                      src={item.previewUrl}
                      alt={item.name}
                      className="h-44 w-full rounded-xl object-cover"
                    />
                    <button
                      type="button"
                      aria-label="Delete photo"
                      onClick={() => remove(item.id)}
                      className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-white shadow-md transition-transform hover:scale-105"
                    >
                      <Trash2 className="size-4 text-slate-700" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {rejected.length > 0 && (
            <div className="mt-12">
              <h2 className="text-xl font-extrabold tracking-tight text-slate-900">
                Some Photos Didn't Meet Our Guidelines
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                You can move to the next step as you've uploaded {accepted.length} good photos.
                Replacing these is optional.
              </p>
              <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {rejected.map((item) => (
                  <div key={item.id}>
                    <div className="relative">
                      <img
                        src={item.previewUrl}
                        alt={item.name}
                        className="h-44 w-full rounded-xl object-cover opacity-60 grayscale"
                      />
                      <button
                        type="button"
                        aria-label="Delete photo"
                        onClick={() => remove(item.id)}
                        className="absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-white shadow-md transition-transform hover:scale-105"
                      >
                        <Trash2 className="size-4 text-slate-700" />
                      </button>
                      {rejectionCopy(item.reason).fixable && (
                        <button
                          type="button"
                          className="absolute left-1/2 top-1/2 inline-flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full bg-white px-4 py-1.5 text-xs font-bold text-slate-800 shadow-lg"
                        >
                          <Crop className="size-3.5" /> Crop
                        </button>
                      )}
                    </div>
                    <RejectionLink reason={item.reason} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </main>

      {showSuccess && !isUploading && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-xl animate-in slide-in-from-bottom-4 fade-in">
          <span className="grid size-6 place-items-center rounded-full bg-emerald-500">
            <Check className="size-4 text-white" />
          </span>
          <span className="text-sm font-semibold text-slate-800">
            Your photos have been successfully uploaded!
          </span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setShowSuccess(false)}
            className="ml-2 text-slate-400 transition-colors hover:text-slate-700"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function AccordionRow({
  icon,
  title,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-5 py-4 text-left"
      >
        {icon}
        <span className="text-sm font-bold text-slate-900">{title}</span>
        <ChevronDown
          className={cn("ml-auto size-4 text-slate-400 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="border-t border-slate-200 px-5 py-4 text-sm leading-relaxed text-slate-600">
          {children}
        </div>
      )}
    </div>
  );
}

function TargetPortraitIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-6" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-brand">
        <path d="M3 8V4h4M21 8V4h-4M3 16v4h4M21 16v4h-4" />
      </g>
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-slate-700">
        <circle cx="12" cy="10" r="2.6" />
        <path d="M7.5 17.5c.9-2.2 2.6-3.3 4.5-3.3s3.6 1.1 4.5 3.3" />
      </g>
    </svg>
  );
}
