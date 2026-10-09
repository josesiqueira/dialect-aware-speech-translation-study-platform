import type { corpusSchemas } from "@dialect/domain";
import { EmptyState, cn, overlineLabel } from "@/components/ui";
import { formatCount } from "@/lib/format";

type Day = corpusSchemas.Dashboard["sessionsPerDay"][number];

function rowLabel(day: Day, index: number, count: number): string {
  if (index === count - 1) return "Today";
  if (index === count - 2) return "Yesterday";
  // Noon avoids a date shift when the browser sits in another time zone.
  const weekday = new Date(`${day.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  return `${weekday} ${day.date.slice(5)}`;
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={cn(overlineLabel, "text-[10px]")}>{label}</p>
      <p className="text-xl font-semibold tabular-nums text-slate-900">{value}</p>
    </div>
  );
}

/**
 * Research sessions per day as one labelled row per day (the reference
 * DailyChart layout): an empty day still has its row, so sparse data does not
 * look broken. One neutral bar color. Demo and test sessions are named in text
 * next to the bar and are not part of it.
 */
export function DailyChart({ days }: { days: Day[] }) {
  if (days.length === 0) return <EmptyState title="No data to display." />;

  const total = days.reduce((sum, day) => sum + day.research, 0);
  const activeDays = days.filter((day) => day.research > 0).length;
  const busiest = days.reduce((best, day) => (day.research > best.research ? day : best), days[0]!);
  const max = Math.max(1, ...days.map((day) => day.research));

  return (
    <div>
      <div className="mb-5 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
        <Summary label="Total in window" value={formatCount(total)} />
        <Summary label="Average / day" value={(total / days.length).toFixed(1)} />
        <Summary label="Active days" value={`${activeDays} of ${days.length}`} />
        <Summary
          label="Busiest day"
          value={busiest.research > 0 ? `${busiest.date.slice(5)} (${busiest.research})` : "none yet"}
        />
      </div>

      <ul className="space-y-1.5" aria-label="Research sessions per day">
        {days.map((day, index) => {
          const other = [day.demo > 0 ? `${day.demo} demo` : null, day.test > 0 ? `${day.test} test` : null]
            .filter(Boolean)
            .join(", ");
          return (
            <li key={day.date} className="grid grid-cols-[6rem_1fr_3rem_7rem] items-center gap-3">
              <span
                className={cn(
                  "truncate text-sm tabular-nums",
                  index === days.length - 1
                    ? "font-medium text-slate-900"
                    : day.research > 0
                      ? "text-slate-700"
                      : "text-slate-500",
                )}
                title={day.date}
              >
                {rowLabel(day, index, days.length)}
              </span>
              <div className="relative h-5" aria-hidden="true">
                <div className="absolute inset-0 rounded-sm border border-dashed border-slate-200 bg-slate-50" />
                {day.research > 0 && (
                  <div
                    className="relative h-full rounded-sm bg-slate-600"
                    style={{ width: `${Math.max(2, (day.research / max) * 100)}%` }}
                  />
                )}
              </div>
              <span
                className={cn(
                  "text-right text-sm tabular-nums",
                  day.research > 0 ? "font-medium text-slate-900" : "text-slate-500",
                )}
              >
                {day.research}
              </span>
              <span className="truncate text-xs tabular-nums text-slate-500">{other && `+ ${other}`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
