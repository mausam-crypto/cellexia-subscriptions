/**
 * Dependency-free SVG chart primitives for the Cellexia admin.
 *
 * Pure presentational client components — no server imports. Colors resolve
 * through Polaris custom properties (var(--p-color-*)) with hex fallbacks so
 * charts blend with the embedded admin theme. Every chart carries a role="img"
 * with an accessible label and an SVG <title>.
 *
 * Numeric hygiene: every value entering a chart or a formatter passes through
 * `finite()` — NaN/Infinity can never reach the DOM.
 */
import type { CSSProperties, ReactNode } from "react";
import { Badge, BlockStack, Button, Card, InlineGrid, InlineStack, Text } from "@shopify/polaris";

// ── Palette ───────────────────────────────────────────────────────────────────

export const CHART_COLORS = {
  primary: "var(--p-color-text-emphasis, #005bd3)",
  success: "var(--p-color-text-success, #29845a)",
  critical: "var(--p-color-text-critical, #8e1f0b)",
  caution: "var(--p-color-text-caution, #916a00)",
  axis: "var(--p-color-text-secondary, #616161)",
  grid: "var(--p-color-border-secondary, #ebebeb)",
  surface: "var(--p-color-bg-surface, #ffffff)",
} as const;

/** Default series color rotation for multi-series charts. */
const SERIES_PALETTE = [
  CHART_COLORS.primary,
  CHART_COLORS.critical,
  CHART_COLORS.caution,
  CHART_COLORS.success,
];

/** Solid hex ramps for the cohort heatmap (rgba needs literal channels, not CSS vars). */
const HEAT_POSITIVE_RGB = "0, 91, 211"; // Polaris emphasis blue
const HEAT_NEGATIVE_RGB = "142, 31, 11"; // Polaris critical red

// ── Layout constants ──────────────────────────────────────────────────────────

const VIEW_W = 720;
// left widened from 64 → 78 so compact CHF labels ("CHF 999.5K") never clip.
const PAD = { top: 16, right: 16, bottom: 30, left: 78 };

// ── Numeric guard ─────────────────────────────────────────────────────────────

/**
 * The single NaN/Infinity guard. Every number that reaches a chart, an axis
 * label or a formatted stat goes through here — non-finite input renders as
 * the fallback (default 0) instead of "NaN" ever hitting the DOM.
 */
export function finite(n: number | null | undefined, fallback = 0): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

// ── Formatting helpers (shared with routes) ───────────────────────────────────

/** Compact number for axis labels: 1200 → "1.2K". */
export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(finite(n));
}

/** Compact money for axis labels, from integer cents: 123456 → "£1.2K". */
export function compactMoney(cents: number, currencyCode: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(finite(cents) / 100);
}

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-07-23" → "23 Jul" (pure string math — no timezone pitfalls). */
export function dateKeyLabel(key: string): string {
  const parts = key.split("-");
  if (parts.length < 3) return key;
  const month = MONTH_LABELS[Number(parts[1]) - 1];
  const day = Number(parts[2]);
  if (!month || Number.isNaN(day)) return key;
  return `${day} ${month}`;
}

/** "2026-07" → "Jul 2026" for cohort row headers. */
export function monthKeyLabel(key: string): string {
  const parts = key.split("-");
  const month = MONTH_LABELS[Number(parts[1]) - 1];
  if (parts.length < 2 || !month) return key;
  return `${month} ${parts[0]}`;
}

// ── Internal math helpers ─────────────────────────────────────────────────────

/** Round `value` up to a "nice" axis maximum (1/2/2.5/5 × 10^k). */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const frac = value / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * base;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Up to `maxTicks` evenly spaced indices into an n-item axis, always ending on the last. */
function tickIndices(n: number, maxTicks = 6): number[] {
  if (n <= 0) return [];
  if (n <= maxTicks) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / maxTicks);
  const out: number[] = [];
  for (let i = 0; i < n; i += step) out.push(i);
  const last = n - 1;
  const prev = out[out.length - 1];
  if (prev !== last) {
    if (last - prev < step / 2 && out.length > 1) out.pop();
    out.push(last);
  }
  return out;
}

function anchorFor(i: number, n: number): "start" | "middle" | "end" {
  if (i === 0) return "start";
  if (i === n - 1) return "end";
  return "middle";
}

// ── Shared fragments ──────────────────────────────────────────────────────────

function EmptyChart({ height, message = "No data yet" }: { height: number; message?: string }) {
  return (
    <div
      style={{
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text as="p" variant="bodySm" tone="subdued">
        {message}
      </Text>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: 2,
          background: color,
          display: "inline-block",
          flexShrink: 0,
        }}
      />
      <Text as="span" variant="bodySm" tone="subdued">
        {label}
      </Text>
    </InlineStack>
  );
}

interface YAxisProps {
  height: number;
  yMin: number;
  yMax: number;
  formatValue: (value: number) => string;
  bottomPad?: number;
}

/** Gridlines + labels at 0 / 50% / 100% of the y range (yMin may be negative). */
function YAxis({ height, yMin, yMax, formatValue, bottomPad = PAD.bottom }: YAxisProps) {
  const innerH = height - PAD.top - bottomPad;
  const range = yMax - yMin || 1;
  const fractions = yMin < 0 ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  return (
    <g>
      {fractions.map((f) => {
        const value = yMin + f * range;
        const y = round1(PAD.top + innerH - f * innerH);
        return (
          <g key={f}>
            <line
              x1={PAD.left}
              y1={y}
              x2={VIEW_W - PAD.right}
              y2={y}
              stroke={CHART_COLORS.grid}
              strokeWidth={value === 0 && yMin < 0 ? 1.5 : 1}
            />
            <text
              x={PAD.left - 8}
              y={y + 4}
              textAnchor="end"
              fontSize={11}
              fill={CHART_COLORS.axis}
            >
              {formatValue(finite(value))}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// ── LineChart ─────────────────────────────────────────────────────────────────

export interface ChartPoint {
  label: string;
  value: number;
}

export interface LineChartProps {
  data: ChartPoint[];
  height?: number;
  color?: string;
  /** Formats y-axis tick values (pass a compact money formatter for cents). */
  formatValue?: (value: number) => string;
  /**
   * Index in `data` where a forecast begins: points from here on render as a
   * dashed line with hollow markers behind a "Forecast" divider. 0 = the whole
   * series is projected.
   */
  projectedFromIndex?: number;
  /** Fill the area under the observed segment (subtle, for trend charts). */
  area?: boolean;
  /** Print the final value next to the last point (exact-value callout). */
  showLastValue?: boolean;
  accessibilityLabel?: string;
}

export function LineChart({
  data: rawData,
  height = 220,
  color = CHART_COLORS.primary,
  formatValue = compactNumber,
  projectedFromIndex,
  area = false,
  showLastValue = false,
  accessibilityLabel = "Line chart",
}: LineChartProps) {
  const data = rawData.map((d) => ({ label: d.label, value: finite(d.value) }));
  const n = data.length;
  if (n === 0) return <EmptyChart height={height} />;

  const innerW = VIEW_W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const dataMin = Math.min(...data.map((d) => d.value));
  const dataMax = Math.max(...data.map((d) => d.value));
  // Negative values extend the domain below zero instead of being clamped away.
  const yMin = dataMin < 0 ? -niceCeil(-dataMin) : 0;
  const yMax = niceCeil(Math.max(1, dataMax));
  const range = yMax - yMin || 1;
  const xAt = (i: number) =>
    n === 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW;
  const yAt = (v: number) =>
    PAD.top + innerH - ((Math.max(yMin, Math.min(v, yMax)) - yMin) / range) * innerH;
  const yZero = yAt(0);

  const splitIdx =
    projectedFromIndex != null && projectedFromIndex > 0 && projectedFromIndex < n
      ? projectedFromIndex
      : null;
  const allProjected = projectedFromIndex === 0;
  const solid = allProjected ? [] : splitIdx != null ? data.slice(0, splitIdx) : data;
  const dashed = allProjected ? data : splitIdx != null ? data.slice(splitIdx - 1) : [];
  const dashedOffset = allProjected ? 0 : splitIdx != null ? splitIdx - 1 : 0;
  const firstProjected =
    allProjected ? 0 : splitIdx != null ? splitIdx : null;

  const pointsAttr = (points: ChartPoint[], offset: number) =>
    points
      .map((d, j) => `${round1(xAt(offset + j))},${round1(yAt(d.value))}`)
      .join(" ");

  // Markers: observed points are solid, projected points hollow — visible at a
  // glance which part of the line is real data. Observed markers always render
  // when the solid segment is too short to draw a polyline (1 observed point).
  const markerIsProjected = (i: number) =>
    firstProjected != null && i >= firstProjected;
  const showAllMarkers = n <= 24;
  const showObservedFallback = !showAllMarkers && solid.length === 1;

  const last = data[n - 1];

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      width="100%"
      role="img"
      aria-label={accessibilityLabel}
      style={{ display: "block" }}
    >
      <title>{accessibilityLabel}</title>
      <YAxis height={height} yMin={yMin} yMax={yMax} formatValue={formatValue} />
      {splitIdx != null && (
        <g>
          <line
            x1={round1(xAt(splitIdx - 1))}
            y1={PAD.top}
            x2={round1(xAt(splitIdx - 1))}
            y2={PAD.top + innerH}
            stroke={CHART_COLORS.axis}
            strokeWidth={1}
            strokeDasharray="2 4"
            opacity={0.6}
          />
          <text
            x={round1(xAt(splitIdx - 1)) + 6}
            y={PAD.top + 11}
            fontSize={10}
            fill={CHART_COLORS.axis}
          >
            Forecast
          </text>
        </g>
      )}
      {area && solid.length > 1 && (
        <polygon
          points={`${round1(xAt(0))},${round1(yZero)} ${pointsAttr(solid, 0)} ${round1(
            xAt(solid.length - 1),
          )},${round1(yZero)}`}
          fill={color}
          opacity={0.08}
        />
      )}
      {solid.length > 1 && (
        <polyline
          points={pointsAttr(solid, 0)}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {dashed.length > 1 && (
        <polyline
          points={pointsAttr(dashed, dashedOffset)}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeDasharray="5 4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {data.map((d, i) => {
        const projected = markerIsProjected(i);
        if (!showAllMarkers && !(showObservedFallback && !projected)) return null;
        return (
          <g key={`${d.label}-${i}`}>
            <title>{`${d.label}: ${formatValue(d.value)}${projected ? " (projected)" : ""}`}</title>
            <circle
              cx={round1(xAt(i))}
              cy={round1(yAt(d.value))}
              r={projected ? 2.75 : 2.5}
              fill={projected ? CHART_COLORS.surface : color}
              stroke={color}
              strokeWidth={projected ? 1.25 : 0}
              opacity={projected ? 0.9 : 1}
            />
          </g>
        );
      })}
      {showLastValue && (
        <text
          x={Math.min(round1(xAt(n - 1)) + 6, VIEW_W - 2)}
          y={Math.max(12, round1(yAt(last.value)) - 6)}
          textAnchor={n === 1 ? "middle" : "end"}
          fontSize={11}
          fontWeight={600}
          fill={CHART_COLORS.axis}
        >
          {formatValue(last.value)}
        </text>
      )}
      {tickIndices(n).map((i) => (
        <text
          key={i}
          x={round1(xAt(i))}
          y={height - 8}
          textAnchor={anchorFor(i, n)}
          fontSize={11}
          fill={CHART_COLORS.axis}
        >
          {data[i].label}
        </text>
      ))}
    </svg>
  );
}

// ── BarPairChart ──────────────────────────────────────────────────────────────

export interface BarSeries {
  name: string;
  values: number[];
  color?: string;
}

export interface BarPairChartProps {
  /** Category labels; both series must align to these indices. */
  labels: string[];
  /** e.g. new subscribers (defaults to the success color). */
  seriesA: BarSeries;
  /** e.g. churned subscribers (defaults to the critical color). */
  seriesB: BarSeries;
  height?: number;
  accessibilityLabel?: string;
}

export function BarPairChart({
  labels,
  seriesA,
  seriesB,
  height = 220,
  accessibilityLabel = "Grouped bar chart",
}: BarPairChartProps) {
  const n = labels.length;
  if (n === 0) return <EmptyChart height={height} />;

  const valuesA = seriesA.values.slice(0, n).map((v) => finite(v));
  const valuesB = seriesB.values.slice(0, n).map((v) => finite(v));
  const allZero = [...valuesA, ...valuesB].every((v) => v <= 0);
  if (allZero) {
    return (
      <EmptyChart
        height={height}
        message={`No ${seriesA.name.toLowerCase()} or ${seriesB.name.toLowerCase()} in this window`}
      />
    );
  }

  const colorA = seriesA.color ?? CHART_COLORS.success;
  const colorB = seriesB.color ?? CHART_COLORS.critical;
  const innerW = VIEW_W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const yMax = niceCeil(Math.max(1, ...valuesA, ...valuesB));
  const groupW = innerW / n;
  const barW = Math.min(20, Math.max(4, groupW * 0.32));

  const bar = (value: number, x: number, color: string, key: string, title: string) => {
    const v = Math.max(0, Math.min(value, yMax));
    if (v === 0) return null;
    const h = (v / yMax) * innerH;
    return (
      <g key={key}>
        <title>{title}</title>
        <rect
          x={round1(x)}
          y={round1(PAD.top + innerH - h)}
          width={round1(barW)}
          height={round1(h)}
          rx={2}
          fill={color}
        />
      </g>
    );
  };

  return (
    <BlockStack gap="200">
      <InlineStack gap="400">
        <LegendSwatch color={colorA} label={seriesA.name} />
        <LegendSwatch color={colorB} label={seriesB.name} />
      </InlineStack>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        role="img"
        aria-label={accessibilityLabel}
        style={{ display: "block" }}
      >
        <title>{accessibilityLabel}</title>
        <YAxis height={height} yMin={0} yMax={yMax} formatValue={compactNumber} />
        {labels.map((label, i) => {
          const center = PAD.left + i * groupW + groupW / 2;
          return (
            <g key={`${label}-${i}`}>
              {bar(
                valuesA[i] ?? 0,
                center - barW - 1,
                colorA,
                `a-${i}`,
                `${label} — ${seriesA.name}: ${valuesA[i] ?? 0}`,
              )}
              {bar(
                valuesB[i] ?? 0,
                center + 1,
                colorB,
                `b-${i}`,
                `${label} — ${seriesB.name}: ${valuesB[i] ?? 0}`,
              )}
            </g>
          );
        })}
        {tickIndices(n).map((i) => (
          <text
            key={i}
            x={round1(PAD.left + i * groupW + groupW / 2)}
            y={height - 8}
            textAnchor="middle"
            fontSize={11}
            fill={CHART_COLORS.axis}
          >
            {labels[i]}
          </text>
        ))}
      </svg>
    </BlockStack>
  );
}

// ── SurvivalCurve ─────────────────────────────────────────────────────────────

export interface SurvivalPoint {
  /** Billing cycle number (1-based). */
  cycle: number;
  /** Fraction surviving, 0..1. */
  pct: number;
}

export interface SurvivalSeries {
  name: string;
  points: SurvivalPoint[];
  color?: string;
}

export interface SurvivalCurveProps {
  series: SurvivalSeries[];
  height?: number;
  xAxisLabel?: string;
  accessibilityLabel?: string;
}

/** Retention curves on a fixed 0–100% axis, one line per series. */
export function SurvivalCurve({
  series,
  height = 240,
  xAxisLabel = "Billing cycle",
  accessibilityLabel = "Survival by billing cycle",
}: SurvivalCurveProps) {
  const drawable = series.filter((s) => s.points.length > 0);
  if (drawable.length === 0) return <EmptyChart height={height} />;

  const bottomPad = PAD.bottom + 14; // room for the axis caption
  const innerW = VIEW_W - PAD.left - PAD.right;
  const innerH = height - PAD.top - bottomPad;

  let minCycle = Infinity;
  let maxCycle = -Infinity;
  for (const s of drawable) {
    for (const p of s.points) {
      if (p.cycle < minCycle) minCycle = p.cycle;
      if (p.cycle > maxCycle) maxCycle = p.cycle;
    }
  }
  const span = maxCycle - minCycle;
  const xAt = (cycle: number) =>
    span === 0
      ? PAD.left + innerW / 2
      : PAD.left + ((cycle - minCycle) / span) * innerW;
  const yAt = (pct: number) =>
    PAD.top + innerH - Math.max(0, Math.min(1, finite(pct))) * innerH;

  const cycleTicks: number[] = [];
  const step = Math.max(1, Math.ceil(Math.max(1, span) / 8));
  for (let c = minCycle; c <= maxCycle; c += step) cycleTicks.push(c);
  if (cycleTicks[cycleTicks.length - 1] !== maxCycle) cycleTicks.push(maxCycle);

  return (
    <BlockStack gap="200">
      <InlineStack gap="400">
        {drawable.map((s, idx) => (
          <LegendSwatch
            key={s.name}
            color={s.color ?? SERIES_PALETTE[idx % SERIES_PALETTE.length]}
            label={s.name}
          />
        ))}
      </InlineStack>
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        role="img"
        aria-label={accessibilityLabel}
        style={{ display: "block" }}
      >
        <title>{accessibilityLabel}</title>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = round1(yAt(f));
          return (
            <g key={f}>
              <line
                x1={PAD.left}
                y1={y}
                x2={VIEW_W - PAD.right}
                y2={y}
                stroke={CHART_COLORS.grid}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 8}
                y={y + 4}
                textAnchor="end"
                fontSize={11}
                fill={CHART_COLORS.axis}
              >
                {Math.round(f * 100)}%
              </text>
            </g>
          );
        })}
        {drawable.map((s, idx) => {
          const color = s.color ?? SERIES_PALETTE[idx % SERIES_PALETTE.length];
          const sorted = [...s.points].sort((a, b) => a.cycle - b.cycle);
          const attr = sorted
            .map((p) => `${round1(xAt(p.cycle))},${round1(yAt(p.pct))}`)
            .join(" ");
          return (
            <g key={s.name}>
              {sorted.length > 1 ? (
                <polyline
                  points={attr}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
              ) : (
                <circle
                  cx={round1(xAt(sorted[0].cycle))}
                  cy={round1(yAt(sorted[0].pct))}
                  r={3}
                  fill={color}
                />
              )}
              {sorted.length <= 24 &&
                sorted.map((p) => (
                  <g key={`${s.name}-${p.cycle}`}>
                    <title>{`${s.name} — cycle ${p.cycle}: ${Math.round(finite(p.pct) * 1000) / 10}%`}</title>
                    <circle
                      cx={round1(xAt(p.cycle))}
                      cy={round1(yAt(p.pct))}
                      r={2.5}
                      fill={color}
                    />
                  </g>
                ))}
            </g>
          );
        })}
        {cycleTicks.map((c) => (
          <text
            key={c}
            x={round1(xAt(c))}
            y={height - 22}
            textAnchor="middle"
            fontSize={11}
            fill={CHART_COLORS.axis}
          >
            {c}
          </text>
        ))}
        <text
          x={PAD.left + innerW / 2}
          y={height - 6}
          textAnchor="middle"
          fontSize={11}
          fill={CHART_COLORS.axis}
        >
          {xAxisLabel}
        </text>
      </svg>
    </BlockStack>
  );
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  accessibilityLabel?: string;
}

/** Minimal inline trend line — no axes, auto-scaled to its own min/max. */
export function Sparkline({
  values: rawValues,
  width = 140,
  height = 36,
  color = CHART_COLORS.primary,
  accessibilityLabel = "Trend",
}: SparklineProps) {
  const values = rawValues.map((v) => finite(v));
  if (values.length === 0) return null;

  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const flat = max === min;
  const range = max - min || 1;
  const n = values.length;
  const xAt = (i: number) =>
    n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2);
  // A flat series draws at vertical center — pinning it to the bottom edge
  // reads as "collapsing to zero" when the value is simply unchanged.
  const yAt = (v: number) =>
    flat ? height / 2 : pad + (1 - (v - min) / range) * (height - pad * 2);
  const points = values
    .map((v, i) => `${round1(xAt(i))},${round1(yAt(v))}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={accessibilityLabel}
      style={{ display: "block" }}
    >
      <title>{accessibilityLabel}</title>
      {n > 1 ? (
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : (
        <circle cx={width / 2} cy={round1(yAt(values[0]))} r={2} fill={color} />
      )}
    </svg>
  );
}

// ── SplitBar ──────────────────────────────────────────────────────────────────

export interface SplitBarSegment {
  label: string;
  value: number;
  color?: string;
}

export interface SplitBarProps {
  segments: SplitBarSegment[];
  height?: number;
  accessibilityLabel?: string;
}

/** Single stacked horizontal bar showing how a total splits across segments. */
export function SplitBar({
  segments,
  height = 16,
  accessibilityLabel = "Breakdown",
}: SplitBarProps) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, finite(s.value)), 0);
  if (total === 0) return <EmptyChart height={48} />;

  return (
    <BlockStack gap="200">
      <div
        role="img"
        aria-label={accessibilityLabel}
        style={{
          display: "flex",
          height,
          borderRadius: height / 2,
          overflow: "hidden",
          background: CHART_COLORS.grid,
        }}
      >
        {segments.map((s, idx) =>
          finite(s.value) > 0 ? (
            <div
              key={s.label}
              title={`${s.label}: ${finite(s.value).toLocaleString("en")} (${Math.round((finite(s.value) / total) * 100)}%)`}
              style={{
                width: `${(finite(s.value) / total) * 100}%`,
                background: s.color ?? SERIES_PALETTE[idx % SERIES_PALETTE.length],
              }}
            />
          ) : null,
        )}
      </div>
      <InlineStack gap="400">
        {segments.map((s, idx) => (
          <LegendSwatch
            key={s.label}
            color={s.color ?? SERIES_PALETTE[idx % SERIES_PALETTE.length]}
            label={`${s.label} — ${finite(s.value).toLocaleString("en")} (${Math.round((finite(s.value) / total) * 100)}%)`}
          />
        ))}
      </InlineStack>
    </BlockStack>
  );
}

// ── StatCard ──────────────────────────────────────────────────────────────────

export type StatTone = "success" | "critical" | "attention" | "warning" | "info" | "new";

export interface StatCardProps {
  title: string;
  value: string;
  /** Short badge next to the value, e.g. "+12 this week". */
  delta?: string;
  /** Tone of the delta badge. */
  tone?: StatTone;
  /** Subdued explainer line under the value. */
  helpText?: string;
  /** Optional extra content (e.g. a Sparkline) under the text. */
  children?: ReactNode;
}

export function StatCard({
  title,
  value,
  delta,
  tone = "info",
  helpText,
  children,
}: StatCardProps) {
  return (
    <Card>
      <BlockStack gap="150">
        <Text as="h3" variant="headingSm" tone="subdued">
          {title}
        </Text>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="p" variant="headingLg">
            {value}
          </Text>
          {delta ? <Badge tone={tone}>{delta}</Badge> : null}
        </InlineStack>
        {helpText ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {helpText}
          </Text>
        ) : null}
        {children}
      </BlockStack>
    </Card>
  );
}

// ── DeltaStat ─────────────────────────────────────────────────────────────────

export interface DeltaStatDelta {
  /** e.g. "+12% WoW" — already formatted by the caller. */
  label: string;
  /** Visual arrow. "flat" renders a dash. */
  direction: "up" | "down" | "flat";
  /**
   * Semantic tone, independent of direction — a falling failed-payments queue
   * is "positive" even though the arrow points down.
   */
  tone: "positive" | "negative" | "neutral";
}

export interface DeltaStatProps {
  title: string;
  value: string;
  delta?: DeltaStatDelta | null;
  helpText?: string;
  children?: ReactNode;
}

const DELTA_ARROW: Record<DeltaStatDelta["direction"], string> = {
  up: "▲", // ▲
  down: "▼", // ▼
  flat: "–", // –
};

/** Stat with a week-over-week / month-over-month delta arrow. */
export function DeltaStat({ title, value, delta, helpText, children }: DeltaStatProps) {
  const toneColor =
    delta?.tone === "positive"
      ? CHART_COLORS.success
      : delta?.tone === "negative"
        ? CHART_COLORS.critical
        : CHART_COLORS.axis;
  return (
    <Card>
      <BlockStack gap="150">
        <Text as="h3" variant="headingSm" tone="subdued">
          {title}
        </Text>
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          <Text as="p" variant="headingLg">
            {value}
          </Text>
          {delta ? (
            <span
              style={{ color: toneColor, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}
              aria-label={`Change: ${delta.label}`}
            >
              <span aria-hidden="true">{DELTA_ARROW[delta.direction]}</span> {delta.label}
            </span>
          ) : null}
        </InlineStack>
        {helpText ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {helpText}
          </Text>
        ) : null}
        {children}
      </BlockStack>
    </Card>
  );
}

// ── TargetBand ────────────────────────────────────────────────────────────────

export interface TargetBandProps {
  /** Actual value, same unit as the target bounds (e.g. 0.27 for 27%). */
  value: number;
  targetMin: number;
  targetMax: number;
  /** Scale maximum; defaults to a sensible headroom above value/target. */
  scaleMax?: number;
  /** Formats the value + bounds for labels (default: percent from a 0..1 fraction). */
  format?: (v: number) => string;
  accessibilityLabel?: string;
}

const defaultBandFormat = (v: number) => `${Math.round(finite(v) * 100)}%`;

/**
 * Horizontal bar plotting an actual value against a target range. The band is
 * shaded; the marker turns success-green inside the band and caution-amber
 * outside it.
 */
export function TargetBand({
  value: rawValue,
  targetMin,
  targetMax,
  scaleMax,
  format = defaultBandFormat,
  accessibilityLabel = "Actual vs target range",
}: TargetBandProps) {
  const value = finite(rawValue);
  const max = finite(scaleMax, 0) > 0
    ? finite(scaleMax)
    : Math.max(value * 1.15, targetMax * 1.4, 0.0001);
  const pct = (v: number) => Math.max(0, Math.min(100, (finite(v) / max) * 100));
  const inBand = value >= targetMin && value <= targetMax;
  const markerColor = inBand ? CHART_COLORS.success : CHART_COLORS.caution;

  return (
    <BlockStack gap="100">
      <div
        role="img"
        aria-label={`${accessibilityLabel}: ${format(value)}, target ${format(targetMin)} to ${format(targetMax)}`}
        style={{
          position: "relative",
          height: 12,
          borderRadius: 6,
          background: CHART_COLORS.grid,
          overflow: "hidden",
        }}
      >
        <div
          title={`Target range ${format(targetMin)}–${format(targetMax)}`}
          style={{
            position: "absolute",
            left: `${pct(targetMin)}%`,
            width: `${Math.max(0, pct(targetMax) - pct(targetMin))}%`,
            top: 0,
            bottom: 0,
            background: "rgba(41, 132, 90, 0.25)",
          }}
        />
        <div
          title={`Actual: ${format(value)}`}
          style={{
            position: "absolute",
            left: `calc(${pct(value)}% - 2px)`,
            width: 4,
            top: 0,
            bottom: 0,
            borderRadius: 2,
            background: markerColor,
          }}
        />
      </div>
      <InlineStack align="space-between">
        <Text as="span" variant="bodySm" tone="subdued">
          {format(value)} now
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          target {format(targetMin)}–{format(targetMax)}
        </Text>
      </InlineStack>
    </BlockStack>
  );
}

// ── AccuracyGradeChip ─────────────────────────────────────────────────────────

export type AccuracyGrade = "A" | "B" | "C" | "D";

const GRADE_TONE: Record<AccuracyGrade, StatTone> = {
  A: "success",
  B: "info",
  C: "warning",
  D: "critical",
};

const GRADE_LABEL: Record<AccuracyGrade, string> = {
  A: "A — reliable",
  B: "B — usable",
  C: "C — rough",
  D: "D — too early",
};

/** Small badge grading how much to trust a forecast (A green … D critical). */
export function AccuracyGradeChip({ grade }: { grade: AccuracyGrade }) {
  return <Badge tone={GRADE_TONE[grade]}>{GRADE_LABEL[grade]}</Badge>;
}

/** Narrow an unknown string to an AccuracyGrade, or null. */
export function asAccuracyGrade(value: unknown): AccuracyGrade | null {
  return value === "A" || value === "B" || value === "C" || value === "D"
    ? value
    : null;
}

// ── ForecastChart ─────────────────────────────────────────────────────────────

export interface ForecastChartProps {
  /** Observed points, oldest first. */
  history: ChartPoint[];
  /** Projected points continuing after the last observed point. */
  forecast: ChartPoint[];
  /** Optional confidence band, parallel to `forecast` (same length). */
  band?: { upper: number[]; lower: number[] } | null;
  /** e.g. "Holt linear smoothing". Shown as a badge above the chart. */
  modelLabel?: string;
  /** Accuracy grade chip (A green … D critical); omit when unknown. */
  accuracyGrade?: AccuracyGrade | null;
  height?: number;
  color?: string;
  formatValue?: (value: number) => string;
  accessibilityLabel?: string;
}

/**
 * History line + dashed forecast line + optional shaded confidence band, with
 * a vertical "today" divider at the junction and model/accuracy chips.
 */
export function ForecastChart({
  history: rawHistory,
  forecast: rawForecast,
  band,
  modelLabel,
  accuracyGrade,
  height = 260,
  color = CHART_COLORS.primary,
  formatValue = compactNumber,
  accessibilityLabel = "Forecast chart",
}: ForecastChartProps) {
  const history = rawHistory.map((d) => ({ label: d.label, value: finite(d.value) }));
  const forecast = rawForecast.map((d) => ({ label: d.label, value: finite(d.value) }));
  const all = [...history, ...forecast];
  const n = all.length;

  const chips = (modelLabel || accuracyGrade) && (
    <InlineStack gap="200" blockAlign="center">
      {modelLabel ? <Badge>{modelLabel}</Badge> : null}
      {accuracyGrade ? <AccuracyGradeChip grade={accuracyGrade} /> : null}
    </InlineStack>
  );

  if (n === 0) {
    return (
      <BlockStack gap="200">
        {chips || null}
        <EmptyChart height={height} />
      </BlockStack>
    );
  }

  const innerW = VIEW_W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const bandValues =
    band && band.upper.length === forecast.length && band.lower.length === forecast.length
      ? [...band.upper.map((v) => finite(v)), ...band.lower.map((v) => finite(v))]
      : null;
  const dataMin = Math.min(...all.map((d) => d.value), ...(bandValues ?? [Infinity]));
  const dataMax = Math.max(...all.map((d) => d.value), ...(bandValues ?? [-Infinity]));
  const yMin = dataMin < 0 ? -niceCeil(-dataMin) : 0;
  const yMax = niceCeil(Math.max(1, dataMax));
  const range = yMax - yMin || 1;
  const xAt = (i: number) =>
    n === 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW;
  const yAt = (v: number) =>
    PAD.top + innerH - ((Math.max(yMin, Math.min(v, yMax)) - yMin) / range) * innerH;

  const splitIdx = history.length; // first forecast index in `all`
  const hasHistory = history.length > 0;
  const hasForecast = forecast.length > 0;

  // Forecast polyline anchors on the last observed point for continuity.
  const forecastStart = hasHistory ? splitIdx - 1 : 0;
  const forecastPts = hasHistory ? [history[history.length - 1], ...forecast] : forecast;

  const pointsAttr = (points: ChartPoint[], offset: number) =>
    points
      .map((d, j) => `${round1(xAt(offset + j))},${round1(yAt(d.value))}`)
      .join(" ");

  let bandPolygon: string | null = null;
  if (bandValues && hasForecast) {
    const upper = forecast.map(
      (_, j) => `${round1(xAt(splitIdx + j))},${round1(yAt(finite(band!.upper[j])))}`,
    );
    const lower = forecast
      .map(
        (_, j) => `${round1(xAt(splitIdx + j))},${round1(yAt(finite(band!.lower[j])))}`,
      )
      .reverse();
    bandPolygon = [...upper, ...lower].join(" ");
  }

  const showMarkers = n <= 30;

  return (
    <BlockStack gap="200">
      {chips || null}
      <svg
        viewBox={`0 0 ${VIEW_W} ${height}`}
        width="100%"
        role="img"
        aria-label={accessibilityLabel}
        style={{ display: "block" }}
      >
        <title>{accessibilityLabel}</title>
        <YAxis height={height} yMin={yMin} yMax={yMax} formatValue={formatValue} />
        {bandPolygon && <polygon points={bandPolygon} fill={color} opacity={0.1} />}
        {hasHistory && hasForecast && (
          <g>
            <line
              x1={round1(xAt(splitIdx - 1))}
              y1={PAD.top}
              x2={round1(xAt(splitIdx - 1))}
              y2={PAD.top + innerH}
              stroke={CHART_COLORS.axis}
              strokeWidth={1}
              strokeDasharray="2 4"
              opacity={0.6}
            />
            <text
              x={round1(xAt(splitIdx - 1)) + 6}
              y={PAD.top + 11}
              fontSize={10}
              fill={CHART_COLORS.axis}
            >
              Today
            </text>
          </g>
        )}
        {history.length > 1 && (
          <polyline
            points={pointsAttr(history, 0)}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {forecastPts.length > 1 && (
          <polyline
            points={pointsAttr(forecastPts, forecastStart)}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeDasharray="5 4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {all.map((d, i) => {
          const projected = i >= splitIdx;
          if (!showMarkers && !(history.length === 1 && !projected)) return null;
          return (
            <g key={`${d.label}-${i}`}>
              <title>{`${d.label}: ${formatValue(d.value)}${projected ? " (projected)" : ""}`}</title>
              <circle
                cx={round1(xAt(i))}
                cy={round1(yAt(d.value))}
                r={projected ? 2.75 : 2.5}
                fill={projected ? CHART_COLORS.surface : color}
                stroke={color}
                strokeWidth={projected ? 1.25 : 0}
              />
            </g>
          );
        })}
        {tickIndices(n).map((i) => (
          <text
            key={i}
            x={round1(xAt(i))}
            y={height - 8}
            textAnchor={anchorFor(i, n)}
            fontSize={11}
            fill={CHART_COLORS.axis}
          >
            {all[i].label}
          </text>
        ))}
      </svg>
      {!hasHistory && hasForecast && (
        <Text as="p" variant="bodySm" tone="subdued">
          No observed history yet — the whole line is projected.
        </Text>
      )}
    </BlockStack>
  );
}

// ── CohortHeatmap ─────────────────────────────────────────────────────────────

export interface HeatmapCell {
  /** Preformatted in-cell text ("71%", "CHF 42"). */
  display: string;
  /**
   * Color intensity 0..1 (1 = darkest). null renders a blank not-applicable
   * cell (future months, no data).
   */
  intensity: number | null;
  /** Underlying value is negative → renders on the critical (red) ramp. */
  negative?: boolean;
  /** Hover tooltip with the plain-English readout. */
  title?: string;
  /** Current calendar month — data still accumulating. */
  inProgress?: boolean;
}

export interface HeatmapRow {
  /** Row header, e.g. "Mar 2026". */
  label: string;
  /** Cohort size line under the label, e.g. "42 subscribers". */
  sublabel?: string;
  cells: HeatmapCell[];
}

export interface CohortHeatmapProps {
  rows: HeatmapRow[];
  /** Column headers, e.g. ["M0", "M1", ...]. Rows may have fewer cells. */
  columnLabels: string[];
  /** Legend endpoint labels, e.g. "0%" / "100%". */
  legendLow: string;
  legendHigh: string;
  accessibilityLabel?: string;
}

function heatCellStyle(cell: HeatmapCell): {
  background: string;
  color: string | undefined;
  outline: string | undefined;
} {
  if (cell.intensity == null) {
    return { background: "transparent", color: undefined, outline: undefined };
  }
  const t = Math.max(0, Math.min(1, finite(cell.intensity)));
  const rgb = cell.negative ? HEAT_NEGATIVE_RGB : HEAT_POSITIVE_RGB;
  const alpha = 0.06 + t * 0.84;
  return {
    background: `rgba(${rgb}, ${round1(alpha * 100) / 100})`,
    color: alpha > 0.5 ? "#ffffff" : undefined,
    outline: cell.inProgress ? `1px dashed ${CHART_COLORS.axis}` : undefined,
  };
}

/**
 * THE cohort visualization: rows = signup months, columns = months since
 * signup, cell color scaled to the selected measure with the value printed
 * in-cell. Diagonal (current month) cells are marked "in progress". Rendered
 * as a real <table> for accessibility, with title-attribute tooltips carrying
 * a plain-English readout per cell.
 */
export function CohortHeatmap({
  rows,
  columnLabels,
  legendLow,
  legendHigh,
  accessibilityLabel = "Cohort heatmap",
}: CohortHeatmapProps) {
  if (rows.length === 0 || columnLabels.length === 0) {
    return <EmptyChart height={160} />;
  }

  const cellBase: CSSProperties = {
    minWidth: 58,
    padding: "6px 8px",
    textAlign: "right",
    fontSize: 12,
    fontVariantNumeric: "tabular-nums",
    borderRadius: 4,
  };

  return (
    <BlockStack gap="300">
      <div style={{ overflowX: "auto" }}>
        <table
          aria-label={accessibilityLabel}
          style={{ borderCollapse: "separate", borderSpacing: 2, width: "100%" }}
        >
          <thead>
            <tr>
              <th
                scope="col"
                style={{
                  ...cellBase,
                  textAlign: "left",
                  minWidth: 110,
                  fontWeight: 600,
                  color: "inherit",
                }}
              >
                Cohort
              </th>
              {columnLabels.map((label) => (
                <th
                  key={label}
                  scope="col"
                  style={{ ...cellBase, fontWeight: 600, color: "inherit" }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row" style={{ ...cellBase, textAlign: "left", fontWeight: 400 }}>
                  <BlockStack gap="0">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {row.label}
                    </Text>
                    {row.sublabel ? (
                      <Text as="span" variant="bodySm" tone="subdued">
                        {row.sublabel}
                      </Text>
                    ) : null}
                  </BlockStack>
                </th>
                {columnLabels.map((_, colIdx) => {
                  const cell = row.cells[colIdx];
                  if (!cell) {
                    return <td key={colIdx} style={cellBase} />;
                  }
                  const style = heatCellStyle(cell);
                  return (
                    <td
                      key={colIdx}
                      title={cell.title}
                      style={{
                        ...cellBase,
                        background: style.background,
                        color: style.color,
                        outline: style.outline,
                        outlineOffset: style.outline ? -1 : undefined,
                        opacity: cell.inProgress ? 0.75 : 1,
                      }}
                    >
                      {cell.display}
                      {cell.inProgress ? "*" : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <InlineStack gap="300" blockAlign="center" wrap>
        <InlineStack gap="100" blockAlign="center" wrap={false}>
          <Text as="span" variant="bodySm" tone="subdued">
            {legendLow}
          </Text>
          <span
            aria-hidden="true"
            style={{
              width: 96,
              height: 10,
              borderRadius: 5,
              background: `linear-gradient(to right, rgba(${HEAT_POSITIVE_RGB}, 0.06), rgba(${HEAT_POSITIVE_RGB}, 0.9))`,
              display: "inline-block",
            }}
          />
          <Text as="span" variant="bodySm" tone="subdued">
            {legendHigh}
          </Text>
        </InlineStack>
        <Text as="span" variant="bodySm" tone="subdued">
          * current month — still accumulating
        </Text>
      </InlineStack>
    </BlockStack>
  );
}

// ── InsightCards ──────────────────────────────────────────────────────────────

export interface InsightCardData {
  tone: "positive" | "warning" | "neutral";
  headline: string;
  detail: string;
  actionLabel?: string;
  actionUrl?: string;
}

const INSIGHT_DOT_COLOR: Record<InsightCardData["tone"], string> = {
  positive: CHART_COLORS.success,
  warning: CHART_COLORS.caution,
  neutral: CHART_COLORS.axis,
};

/**
 * Plain-language insight cards ("what this means / what to do"). Each card
 * shows a tone dot, a headline, the evidence sentence, and an optional action.
 */
export function InsightCards({ insights }: { insights: InsightCardData[] }) {
  if (insights.length === 0) return null;
  return (
    <InlineGrid columns={{ xs: 1, md: insights.length === 1 ? 1 : 2 }} gap="300">
      {insights.map((insight) => (
        <Card key={insight.headline}>
          <BlockStack gap="150">
            <InlineStack gap="150" blockAlign="center" wrap={false}>
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  flexShrink: 0,
                  background: INSIGHT_DOT_COLOR[insight.tone],
                }}
              />
              <Text as="h3" variant="headingSm">
                {insight.headline}
              </Text>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {insight.detail}
            </Text>
            {insight.actionLabel && insight.actionUrl ? (
              <InlineStack>
                <Button url={insight.actionUrl} variant="plain">
                  {insight.actionLabel}
                </Button>
              </InlineStack>
            ) : null}
          </BlockStack>
        </Card>
      ))}
    </InlineGrid>
  );
}
