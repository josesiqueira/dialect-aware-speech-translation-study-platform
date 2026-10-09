"use client";

import { Checkbox } from "@/components/ui";
import { SHORTCUT_LEGEND } from "./shortcuts";

export interface ShortcutLegendProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

/** Small legend of the page shortcuts, with the switch that turns them off. */
export function ShortcutLegend({ enabled, onEnabledChange }: ShortcutLegendProps) {
  return (
    <details className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600">
      <summary className="cursor-pointer rounded font-medium text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
        Keyboard shortcuts{enabled ? "" : " (off)"}
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {SHORTCUT_LEGEND.map((entry) => (
          <div key={entry.keys} className="contents">
            <dt>
              <kbd className="rounded border border-slate-300 bg-slate-50 px-1 py-0.5 font-mono text-[11px] text-slate-700">
                {entry.keys}
              </kbd>
            </dt>
            <dd>{entry.description}</dd>
          </div>
        ))}
      </dl>
      <Checkbox
        className="mt-2"
        label="Keyboard shortcuts on"
        description="Turn this off if the shortcuts get in the way of your keyboard or assistive software."
        checked={enabled}
        onChange={(event) => onEnabledChange(event.target.checked)}
      />
    </details>
  );
}
