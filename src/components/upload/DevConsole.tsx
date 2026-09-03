import { useState } from "react";
import { ChevronDown, FlaskConical } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export type Overrides = {
  blur: boolean;
  smallFace: boolean;
  multiFace: boolean;
  duplicate: boolean;
};

export const EMPTY_OVERRIDES: Overrides = {
  blur: false,
  smallFace: false,
  multiFace: false,
  duplicate: false,
};

const TOGGLES: { key: keyof Overrides; label: string }[] = [
  { key: "blur", label: "Simulate Blurry Profile Image Failure" },
  { key: "smallFace", label: "Simulate Distance Face Too Small Failure" },
  { key: "multiFace", label: "Simulate Multiple Face Presence Failure" },
  { key: "duplicate", label: "Simulate Perceptual Hash Duplicate Failure" },
];

export function DevConsole({
  overrides,
  onChange,
}: {
  overrides: Overrides;
  onChange: (next: Overrides) => void;
}) {
  const [open, setOpen] = useState(true);
  const active = Object.values(overrides).filter(Boolean).length;

  return (
    <div className="fixed right-4 top-28 z-50 w-[19rem] overflow-hidden rounded-xl border border-border bg-card/85 shadow-xl backdrop-blur-md">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <FlaskConical className="size-4 text-brand" />
        <span className="text-sm font-bold text-foreground">Developer Testing Console</span>
        {active > 0 && (
          <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-bold text-brand-foreground">
            {active}
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-4 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-4 py-3">
          {TOGGLES.map((t) => (
            <label key={t.key} className="flex items-center justify-between gap-3">
              <span className="text-xs leading-snug text-muted-foreground">{t.label}</span>
              <Switch
                checked={overrides[t.key]}
                onCheckedChange={(v) => onChange({ ...overrides, [t.key]: v })}
              />
            </label>
          ))}
          <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground/80">
            Active toggles inject x-override-* headers into every POST /api/upload request.
          </p>
        </div>
      )}
    </div>
  );
}
