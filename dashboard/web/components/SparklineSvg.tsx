// Hand-rolled SVG sparkline. Replaces the recharts-based Sparkline so we
// can drop the entire recharts dependency from the bundle.

import { memo, useMemo } from "react";
import type { Bucket } from "../types";

type Props = {
  data?: Bucket[];
  values?: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
};

function fillTo60(data: Bucket[]): number[] {
  if (data.length === 0) return new Array(60).fill(0) as number[];
  const last = data[data.length - 1].ts;
  const out: number[] = [];
  for (let i = 59; i >= 0; i--) {
    const t = last - i;
    const found = data.find((b) => b.ts === t);
    out.push(found ? found.v : 0);
  }
  return out;
}

function SparklineSvgImpl({
  data,
  values,
  width = 60,
  height = 20,
  stroke = "#ff7a1a",
  fill = "#ff7a1a",
}: Props): JSX.Element {
  const series = useMemo<number[]>(() => {
    if (values && values.length > 0) return values;
    if (data) return fillTo60(data);
    return new Array(60).fill(0) as number[];
  }, [data, values]);

  const { d, fillD } = useMemo(() => {
    const n = series.length;
    if (n === 0) return { d: "", fillD: "" };
    const max = Math.max(1, ...series);
    const stepX = n > 1 ? width / (n - 1) : 0;
    const pad = 1;
    const usableH = Math.max(1, height - pad * 2);
    const points: string[] = [];
    for (let i = 0; i < n; i++) {
      const x = i * stepX;
      const y = pad + usableH - (series[i] / max) * usableH;
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    const dPath = `M${points.join(" L")}`;
    const fillPath = `${dPath} L${(width).toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`;
    return { d: dPath, fillD: fillPath };
  }, [series, width, height]);

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {fillD && (
        <path
          d={fillD}
          fill={fill}
          fillOpacity={0.18}
          stroke="none"
        />
      )}
      {d && (
        <path
          d={d}
          fill="none"
          stroke={stroke}
          strokeWidth={1.25}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

export const SparklineSvg = memo(SparklineSvgImpl);

// Backwards-compatible alias so existing call-sites that imported `Sparkline`
// keep working with no edits beyond the import path.
export const Sparkline = SparklineSvg;
