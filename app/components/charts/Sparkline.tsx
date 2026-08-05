/**
 * Tiny dependency-free inline-SVG sparkline for table cells and metric tiles.
 */
import { useId } from "react";
import { CHART_ACCENT, CHART_MUTED } from "~/components/charts/LineChart";

export interface SparklineProps {
  values: number[];
  title: string;
  width?: number;
  height?: number;
  color?: string;
  strokeWidth?: number;
}

export function Sparkline({
  values,
  title,
  width = 120,
  height = 32,
  color = CHART_ACCENT,
  strokeWidth = 2,
}: SparklineProps) {
  const titleId = useId();

  if (values.length === 0) {
    return (
      <span style={{ color: CHART_MUTED, fontSize: 12 }} aria-label={title}>
        –
      </span>
    );
  }

  let max = values[0];
  let min = values[0];
  for (const v of values) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  const range = max - min;
  const padY = strokeWidth + 1;

  const x = (i: number) =>
    values.length <= 1
      ? width / 2
      : (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) =>
    range === 0
      ? height / 2
      : height - padY - ((v - min) / range) * (height - padY * 2);

  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const last = values.length - 1;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={titleId}
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      <title id={titleId}>{title}</title>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(last)} cy={y(values[last])} r={strokeWidth + 0.5} fill={color} />
    </svg>
  );
}
