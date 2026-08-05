/**
 * Dependency-free inline-SVG bar chart (single series). Accessible and
 * Cellexia-tinted, neutral enough for Polaris admin surfaces.
 */
import { useId } from "react";
import { CHART_ACCENT, CHART_GRID, CHART_INK, CHART_MUTED } from "~/components/charts/LineChart";
import { fmtNumber } from "~/components/charts/format";

export interface BarChartProps {
  title: string;
  description?: string;
  labels: string[];
  values: number[];
  height?: number;
  color?: string;
  formatValue?: (value: number) => string;
  /** Copy shown when there is no data yet. */
  emptyText?: string;
}

export function BarChart({
  title,
  description,
  labels,
  values,
  height = 220,
  color = CHART_ACCENT,
  formatValue,
  emptyText,
}: BarChartProps) {
  const titleId = useId();
  const descId = useId();
  const width = 720;
  const pad = { top: 18, right: 16, bottom: 30, left: 64 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  if (labels.length === 0 || values.length === 0) {
    return (
      <p style={{ color: CHART_MUTED, fontSize: 13, margin: 0 }}>
        {emptyText ?? `No data yet for ${title.toLowerCase()}.`}
      </p>
    );
  }

  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max <= 0) max = 1;

  // Fraction-aware default: `String(Math.round(v))` rendered the tick pair
  // [0, 0.45] as "0"/"0" and labelled 0.6-unit bars "1".
  const fmt = formatValue ?? fmtNumber;
  const n = labels.length;
  const slot = innerW / n;
  const barWidth = Math.max(4, slot * 0.6);
  const yTicks = [0, 0.5, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(n / 8));
  const showValueLabels = n <= 8;

  const xCenter = (i: number) => pad.left + slot * i + slot / 2;
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      <title id={titleId}>{title}</title>
      <desc id={descId}>
        {description ?? `Bar chart with ${n} bars.`}
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
      {values.map((v, i) => (
        <g key={i}>
          <rect
            x={xCenter(i) - barWidth / 2}
            y={y(Math.max(0, v))}
            width={barWidth}
            height={Math.max(0, pad.top + innerH - y(Math.max(0, v)))}
            rx={3}
            fill={color}
            stroke={CHART_INK}
            strokeOpacity={0.15}
          />
          {showValueLabels ? (
            <text
              x={xCenter(i)}
              y={y(Math.max(0, v)) - 6}
              textAnchor="middle"
              fontSize={11}
              fill={CHART_INK}
            >
              {fmt(v)}
            </text>
          ) : null}
        </g>
      ))}
      {labels.map((label, i) =>
        i % labelEvery === 0 ? (
          <text
            key={i}
            x={xCenter(i)}
            y={height - 8}
            textAnchor="middle"
            fontSize={11}
            fill={CHART_MUTED}
          >
            {label}
          </text>
        ) : null,
      )}
    </svg>
  );
}
