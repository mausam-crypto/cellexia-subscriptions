/**
 * Dependency-free SVG chart primitives for the Cellexia admin.
 *
 * Pure presentational client components — no server imports. Colors resolve
 * through Polaris custom properties (var(--p-color-*)) with hex fallbacks so
 * charts blend with the embedded admin theme. Every chart carries a role="img"
 * with an accessible label and an SVG <title>.
 */
import type { ReactNode } from "react";
import { Badge, BlockStack, Card, InlineStack, Text } from "@shopify/polaris";

// ── Palette ───────────────────────────────────────────────────────────────────

export const CHART_COLORS = {
  primary: "var(--p-color-text-emphasis, #005bd3)",
  success: "var(--p-color-text-success, #29845a)",
  critical: "var(--p-color-text-critical, #8e1f0b)",
  caution: "var(--p-color-text-caution, #916a00)",
  axis: "var(--p-color-text-secondary, #616161)",
  grid: "var(--p-color-border-secondary, #ebebeb)",
} as const;

/** Default series color rotation for multi-series charts. */
const SERIES_PALETTE = [
  CHART_COLORS.primary,
  CHART_COLORS.critical,
  CHART_COLORS.caution,
  CHART_COLORS.success,
];

// ── Layout constants ──────────────────────────────────────────────────────────

const VIEW_W = 720;
const PAD = { top: 16, right: 16, bottom: 30, left: 64 };

// ── Formatting helpers (shared with routes) ───────────────────────────────────

/** Compact number for axis labels: 1200 → "1.2K". */
export function compactNumber(n: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

/** Compact money for axis labels, from integer cents: 123456 → "£1.2K". */
export function compactMoney(cents: number, currencyCode: string): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(cents / 100);
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
  yMax: number;
  formatValue: (value: number) => string;
}

/** Gridlines + labels at 0 / 50% / 100% of the y range. */
function YAxis({ height, yMax, formatValue }: YAxisProps) {
  const innerH = height - PAD.top - PAD.bottom;
  return (
    <g>
      {[0, 0.5, 1].map((f) => {
        const y = round1(PAD.top + innerH - f * innerH);
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
              {formatValue(f * yMax)}
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
   * dashed line behind a "Forecast" divider. 0 = the whole series is projected.
   */
  projectedFromIndex?: number;
  accessibilityLabel?: string;
}

export function LineChart({
  data,
  height = 220,
  color = CHART_COLORS.primary,
  formatValue = compactNumber,
  projectedFromIndex,
  accessibilityLabel = "Line chart",
}: LineChartProps) {
  const n = data.length;
  if (n === 0) return <EmptyChart height={height} />;

  const innerW = VIEW_W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const yMax = niceCeil(Math.max(1, ...data.map((d) => d.value)));
  const xAt = (i: number) =>
    n === 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW;
  const yAt = (v: number) =>
    PAD.top + innerH - (Math.max(0, Math.min(v, yMax)) / yMax) * innerH;

  const splitIdx =
    projectedFromIndex != null && projectedFromIndex > 0 && projectedFromIndex < n
      ? projectedFromIndex
      : null;
  const allProjected = projectedFromIndex === 0;
  const solid = allProjected ? [] : splitIdx != null ? data.slice(0, splitIdx) : data;
  const dashed = allProjected ? data : splitIdx != null ? data.slice(splitIdx - 1) : [];
  const dashedOffset = allProjected ? 0 : splitIdx != null ? splitIdx - 1 : 0;

  const pointsAttr = (points: ChartPoint[], offset: number) =>
    points
      .map((d, j) => `${round1(xAt(offset + j))},${round1(yAt(d.value))}`)
      .join(" ");

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${height}`}
      width="100%"
      role="img"
      aria-label={accessibilityLabel}
      style={{ display: "block" }}
    >
      <title>{accessibilityLabel}</title>
      <YAxis height={height} yMax={yMax} formatValue={formatValue} />
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
      {n <= 24 &&
        data.map((d, i) => (
          <circle
            key={`${d.label}-${i}`}
            cx={round1(xAt(i))}
            cy={round1(yAt(d.value))}
            r={2.5}
            fill={color}
          />
        ))}
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

  const colorA = seriesA.color ?? CHART_COLORS.success;
  const colorB = seriesB.color ?? CHART_COLORS.critical;
  const innerW = VIEW_W - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const yMax = niceCeil(
    Math.max(1, ...seriesA.values.slice(0, n), ...seriesB.values.slice(0, n)),
  );
  const groupW = innerW / n;
  const barW = Math.min(20, Math.max(4, groupW * 0.32));

  const bar = (value: number, x: number, color: string, key: string) => {
    const v = Math.max(0, Math.min(value, yMax));
    if (v === 0) return null;
    const h = (v / yMax) * innerH;
    return (
      <rect
        key={key}
        x={round1(x)}
        y={round1(PAD.top + innerH - h)}
        width={round1(barW)}
        height={round1(h)}
        rx={2}
        fill={color}
      />
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
        <YAxis height={height} yMax={yMax} formatValue={compactNumber} />
        {labels.map((label, i) => {
          const center = PAD.left + i * groupW + groupW / 2;
          return (
            <g key={`${label}-${i}`}>
              {bar(seriesA.values[i] ?? 0, center - barW - 1, colorA, `a-${i}`)}
              {bar(seriesB.values[i] ?? 0, center + 1, colorB, `b-${i}`)}
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
    PAD.top + innerH - Math.max(0, Math.min(1, pct)) * innerH;

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
  values,
  width = 140,
  height = 36,
  color = CHART_COLORS.primary,
  accessibilityLabel = "Trend",
}: SparklineProps) {
  if (values.length === 0) return null;

  const pad = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const n = values.length;
  const xAt = (i: number) =>
    n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2);
  const yAt = (v: number) =>
    pad + (1 - (v - min) / range) * (height - pad * 2);
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
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);
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
          s.value > 0 ? (
            <div
              key={s.label}
              style={{
                width: `${(s.value / total) * 100}%`,
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
            label={`${s.label} — ${s.value.toLocaleString("en")} (${Math.round((s.value / total) * 100)}%)`}
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
