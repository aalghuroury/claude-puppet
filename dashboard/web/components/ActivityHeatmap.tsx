// Per-session activity heatmap — last 60 seconds, 1-second buckets, color
// intensity proportional to bytes/sec. Currently rendered inside SessionCell
// is the Sparkline; this component is offered as a denser alternative.

import { memo } from "react";
import type { Bucket } from "../types";

type Props = {
  data: Bucket[];
  height?: number;
};

function fillTo60(data: Bucket[]): Bucket[] {
  if (data.length === 0) return [];
  const last = data[data.length - 1].ts;
  const out: Bucket[] = [];
  for (let i = 59; i >= 0; i--) {
    const t = last - i;
    const found = data.find((b) => b.ts === t);
    out.push({ ts: t, v: found ? found.v : 0 });
  }
  return out;
}

function ActivityHeatmapImpl({ data, height = 14 }: Props): JSX.Element {
  const filled = fillTo60(data);
  const peak = Math.max(1, ...filled.map((d) => d.v));
  return (
    <div className="flex gap-[1px]" style={{ height }}>
      {filled.map((b) => {
        const intensity = b.v === 0 ? 0 : Math.min(1, b.v / peak);
        const alpha = b.v === 0 ? 0.06 : 0.2 + 0.8 * intensity;
        return (
          <div
            key={b.ts}
            title={`${b.v} B/s`}
            style={{
              flex: "1 1 0",
              background: `rgba(34, 211, 238, ${alpha})`,
            }}
            className="rounded-[1px]"
          />
        );
      })}
    </div>
  );
}

export const ActivityHeatmap = memo(ActivityHeatmapImpl);
