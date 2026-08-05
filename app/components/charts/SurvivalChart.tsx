/**
 * Dependency-free inline-SVG survival curve: % of treatment plans remaining
 * at each checkpoint, with cumulative voluntary vs payment-related exits
 * shown as dashed companion lines. Y axis is fixed at 0-100%.
 */
import { useId } from "react";
import { CHART_ACCENT, CHART_GRID, CHART_INK, CHART_MUTED } from "~/components/charts/LineChart";

const PAYMENT_COLOR = "#6E93BC";

export interface SurvivalChartPoint {
  label: string;
  remainingPercent: number;
  voluntaryExitPercent: number;
  paymentFailureExitPercent: number;
}

export interface SurvivalChartProps {
  title: string;
  description?: string;
  points: SurvivalChartPoint[];
  height?: number;
  /** Copy shown when there are no measurable points yet. */
  emptyText?: string;
}

export function SurvivalChart({
  title,
  description,
  points,
  height = 240,
  emptyText,
}: SurvivalChartProps) {
  const titleId = useId();
  const descId = useId();
  const width = 720;
  const pad = { top: 14, right: 16, bottom: 30, left: 48 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  if (points.length === 0) {
    return (
      <p style={{ color: CHART_MUTED, fontSize: 13, margin: 0 }}>
        {emptyText ?? "Not enough history yet to draw a survival curve."}
      </p>
    );
  }

  const x = (i: number) =>
    points.length <= 1
      ? pad.left + innerW / 2
      : pad.left + (i / (points.length - 1)) * innerW;
  const y = (percent: number) =>
    pad.top + innerH - (Math.min(100, Math.max(0, percent)) / 100) * innerH;

  const remainingLine = points
    .map((p, i) => `${x(i)},${y(p.remainingPercent)}`)
    .join(" ");
  const areaPath =
    `M ${x(0)} ${y(points[0].remainingPercent)} ` +
    points
      .slice(1)
      .map((p, i) => `L ${x(i + 1)} ${y(p.remainingPercent)}`)
      .join(" ") +
    ` L ${x(points.length - 1)} ${pad.top + innerH}` +
    ` L ${x(0)} ${pad.top + innerH} Z`;
  const voluntaryLine = points
    .map((p, i) => `${x(i)},${y(p.voluntaryExitPercent)}`)
    .join(" ");
  const paymentLine = points
    .map((p, i) => `${x(i)},${y(p.paymentFailureExitPercent)}`)
    .join(" ");

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
            "Share of treatment plans remaining at each checkpoint, with voluntary and payment-related exits."}
        </desc>
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={CHART_GRID}
              strokeWidth={1}
              strokeDasharray={tick === 0 ? undefined : "2 4"}
            />
            <text
              x={pad.left - 8}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={11}
              fill={CHART_MUTED}
            >
              {tick}%
            </text>
          </g>
        ))}
        {points.map((p, i) => (
          <text
            key={p.label}
            x={x(i)}
            y={height - 8}
            textAnchor="middle"
            fontSize={11}
            fill={CHART_MUTED}
          >
            {p.label}
          </text>
        ))}
        <path d={areaPath} fill={CHART_ACCENT} opacity={0.25} />
        <polyline
          points={remainingLine}
          fill="none"
          stroke={CHART_INK}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <polyline
          points={voluntaryLine}
          fill="none"
          stroke={CHART_MUTED}
          strokeWidth={2}
          strokeDasharray="5 4"
          strokeLinejoin="round"
        />
        <polyline
          points={paymentLine}
          fill="none"
          stroke={PAYMENT_COLOR}
          strokeWidth={2}
          strokeDasharray="5 4"
          strokeLinejoin="round"
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.remainingPercent)}
            r={3.5}
            fill={CHART_INK}
          />
        ))}
      </svg>
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden="true"
            style={{
              width: 12,
              height: 3,
              background: CHART_INK,
              display: "inline-block",
              borderRadius: 2,
            }}
          />
          Remaining
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden="true"
            style={{
              width: 12,
              height: 0,
              borderTop: `3px dashed ${CHART_MUTED}`,
              display: "inline-block",
            }}
          />
          Voluntary exits
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden="true"
            style={{
              width: 12,
              height: 0,
              borderTop: `3px dashed ${PAYMENT_COLOR}`,
              display: "inline-block",
            }}
          />
          Payment-related exits
        </span>
      </div>
    </div>
  );
}
