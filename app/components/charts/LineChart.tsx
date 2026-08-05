/**
 * Dependency-free inline-SVG line chart. Polaris-friendly, accessible
 * (role="img" + title/desc), Cellexia-tinted but neutral enough for admin.
 */
import { useId } from "react";
import { fmtNumber } from "~/components/charts/format";

export const CHART_INK = "#1D1D1B";
export const CHART_ACCENT = "#B1CDED";
export const CHART_MUTED = "#8A8A88";
export const CHART_GRID = "#D8D8D8";

const SERIES_COLORS = [CHART_INK, CHART_ACCENT, CHART_MUTED, "#6E93BC", "#C9B8A8"];

export interface LineChartSeries {
  name: string;
  values: number[];
  color?: string;
}

export interface LineChartProps {
  title: string;
  description?: string;
  labels: string[];
  series: LineChartSeries[];
  height?: number;
  formatValue?: (value: number) => string;
  /** Copy shown when there is no data yet. */
  emptyText?: string;
}

export function LineChart({
  title,
  description,
  labels,
  series,
  height = 220,
  formatValue,
  emptyText,
}: LineChartProps) {
  const titleId = useId();
  const descId = useId();
  const width = 720;
  const pad = { top: 14, right: 16, bottom: 30, left: 64 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const allValues = series.flatMap((s) => s.values);
  if (labels.length === 0 || allValues.length === 0) {
    return (
      <p style={{ color: CHART_MUTED, fontSize: 13, margin: 0 }}>
        {emptyText ?? `No data yet for ${title.toLowerCase()}.`}
      </p>
    );
  }

  let max = allValues[0];
  let min = 0;
  for (const v of allValues) {
    if (v > max) max = v;
    if (v < min) min = v;
  }
  if (max <= min) max = min + 1;
  const range = max - min;

  const x = (i: number) =>
    labels.length <= 1
      ? pad.left + innerW / 2
      : pad.left + (i / (labels.length - 1)) * innerW;
  const y = (v: number) => pad.top + innerH - ((v - min) / range) * innerH;
  // Fraction-aware default so small-magnitude axes never repeat tick labels.
  const fmt = formatValue ?? fmtNumber;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => min + t * range);
  const labelEvery = Math.max(1, Math.ceil(labels.length / 8));

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${titleId} ${descId}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <title id={titleId}>{title}</title>
        <desc id={descId}>
          {description ??
            `Line chart with ${series.length} series across ${labels.length} points.`}
        </desc>
        {yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={CHART_GRID}
              strokeWidth={1}
              strokeDasharray={i === 0 ? undefined : "2 4"}
            />
            <text
              x={pad.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={11}
              fill={CHART_MUTED}
            >
              {fmt(tick)}
            </text>
          </g>
        ))}
        {labels.map((label, i) =>
          i % labelEvery === 0 ? (
            <text
              key={i}
              x={x(i)}
              y={height - 8}
              textAnchor="middle"
              fontSize={11}
              fill={CHART_MUTED}
            >
              {label}
            </text>
          ) : null,
        )}
        {series.map((s, si) => {
          const color = s.color ?? SERIES_COLORS[si % SERIES_COLORS.length];
          const points = s.values
            .map((v, i) => `${x(i)},${y(v)}`)
            .join(" ");
          const last = s.values.length - 1;
          return (
            <g key={s.name}>
              <polyline
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {last >= 0 ? (
                <circle cx={x(last)} cy={y(s.values[last])} r={3.5} fill={color} />
              ) : null}
            </g>
          );
        })}
      </svg>
      {series.length > 1 ? (
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            marginTop: 8,
            fontSize: 12,
            color: CHART_INK,
          }}
        >
          {series.map((s, si) => (
            <span
              key={s.name}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 3,
                  borderRadius: 2,
                  background: s.color ?? SERIES_COLORS[si % SERIES_COLORS.length],
                  display: "inline-block",
                }}
              />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
