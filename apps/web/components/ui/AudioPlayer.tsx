import { useId, type ReactNode, type Ref } from "react";
import { cn } from "./cn";

export interface AudioPlayerProps {
  /** URL of the audio. For stored recordings this is an authenticated streaming route, never a public URL. */
  src: string;
  /** Visible label, for example "Source recording" or "Your recording". */
  label: ReactNode;
  /** MIME type of the source, when known. */
  type?: string;
  /** Muted metadata next to the label: duration, format. */
  meta?: ReactNode;
  /** Adds a "Download" link. */
  downloadHref?: string;
  downloadLabel?: string;
  /** Hide the label visually (it still names the player for screen readers). */
  hideLabel?: boolean;
  /**
   * How much the browser fetches before play is pressed. Default "none": no audio
   * bytes. "metadata" makes the duration known and seeking possible before the
   * first play (the transcript review page uses it).
   */
  preload?: "none" | "metadata" | "auto";
  /** The audio element, for a page that adds its own play and pause shortcuts. */
  ref?: Ref<HTMLAudioElement>;
  className?: string;
}

/**
 * Thin wrapper around the native <audio controls> element. The native
 * controls are keyboard accessible and are not replaced. By default
 * preload="none": no audio bytes are fetched until the listener presses play.
 */
export function AudioPlayer({
  src,
  label,
  type,
  meta,
  downloadHref,
  downloadLabel = "Download",
  hideLabel = false,
  preload = "none",
  ref,
  className,
}: AudioPlayerProps) {
  const labelId = useId();
  return (
    <div className={cn("min-w-0", className)}>
      <div className={cn("mb-1 flex items-baseline justify-between gap-3", hideLabel && !downloadHref && !meta && "sr-only")}>
        <p id={labelId} className={cn("text-sm font-medium text-slate-700", hideLabel && "sr-only")}>
          {label}
        </p>
        <div className="flex items-baseline gap-3 text-xs text-slate-500 tabular-nums">
          {meta}
          {downloadHref && (
            <a
              href={downloadHref}
              download
              className="rounded text-slate-600 underline underline-offset-2 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              {downloadLabel}
            </a>
          )}
        </div>
      </div>
      <audio ref={ref} controls preload={preload} aria-labelledby={labelId} className="block w-full">
        {type ? <source src={src} type={type} /> : <source src={src} />}
      </audio>
    </div>
  );
}
