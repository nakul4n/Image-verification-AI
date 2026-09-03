import { useState } from "react";
import { XCircle } from "lucide-react";
import { rejectionCopy } from "@/lib/rejections";

export function RejectionLink({ reason }: { reason: string | null }) {
  const [open, setOpen] = useState(false);
  const copy = rejectionCopy(reason);

  return (
    <div
      className="relative mt-2 flex justify-center"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="dashed-link text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {copy.label}
      </button>

      {open && (
        <div className="absolute bottom-[calc(100%+0.6rem)] left-1/2 z-40 w-64 -translate-x-1/2 animate-in fade-in-0 zoom-in-95">
          <div className="rounded-xl bg-neutral-900 p-3 text-left shadow-2xl">
            <div className="flex items-center gap-2">
              <XCircle className="size-4 shrink-0 text-red-500" />
              <span className="text-sm font-bold text-neutral-50">{copy.title}</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-neutral-200">{copy.body}</p>
          </div>
          <div className="mx-auto size-3 -translate-y-1.5 rotate-45 bg-neutral-900" />
        </div>
      )}
    </div>
  );
}
