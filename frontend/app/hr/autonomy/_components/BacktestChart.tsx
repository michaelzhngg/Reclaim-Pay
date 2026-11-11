"use client";

import { useMemo, useState } from "react";
import { AgCharts } from "ag-charts-react";
import {
  CartesianChartModule,
  CrossLinesModule,
  LineSeriesModule,
  NumberAxisModule,
  ScatterSeriesModule,
  type AgCartesianChartOptions,
} from "ag-charts-community";
import type { ChartData, CurveDatum } from "../_lib/autonomy";

const MODULES = [CartesianChartModule, NumberAxisModule, LineSeriesModule, ScatterSeriesModule, CrossLinesModule];

/**
 * Chart colours come from the design tokens in app/globals.css. AG Charts draws on a canvas,
 * so the CSS variables are read once in the browser. The fallbacks are the same token values,
 * used only during server render. The current setting is the one accent on the chart; every
 * other limit is ink-muted (6.2:1 on white).
 */
interface ChartColors {
  current: string;
  line: string;
  ink: string;
  muted: string;
  grid: string;
  surface: string;
  font: string;
}

const FALLBACK_COLORS: ChartColors = {
  current: "#4647d3",
  line: "#5a5c64",
  ink: "#17181c",
  muted: "#5a5c64",
  grid: "#e3e1db",
  surface: "#ffffff",
  font: "Inter, ui-sans-serif, system-ui, sans-serif",
};

function readChartColors(): ChartColors {
  if (typeof window === "undefined") return FALLBACK_COLORS;
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const inter = v("--font-inter", "");
  return {
    current: v("--color-accent", FALLBACK_COLORS.current),
    line: v("--color-ink-muted", FALLBACK_COLORS.line),
    ink: v("--color-ink", FALLBACK_COLORS.ink),
    muted: v("--color-ink-muted", FALLBACK_COLORS.muted),
    grid: v("--color-line", FALLBACK_COLORS.grid),
    surface: v("--color-surface", FALLBACK_COLORS.surface),
    font: inter ? `${inter}, ui-sans-serif, system-ui, sans-serif` : FALLBACK_COLORS.font,
  };
}

const AUTOMATION_HEIGHT = 170;
// Taller by the x-axis title it carries for both charts.
const LEAKAGE_HEIGHT = 200;

type Measure = "automationPct" | "leakage";

function panelOptions(
  data: ChartData,
  measure: Measure,
  currency: string,
  showXAxisTitle: boolean,
  height: number,
  c: ChartColors,
): AgCartesianChartOptions {
  const { current: CURRENT, line: LINE, ink: INK, muted: INK_MUTED, grid: GRID, surface: SURFACE, font: FONT } = c;
  const fmtY = (v: number) =>
    measure === "automationPct" ? `${Math.round(v)}%` : `${currency} ${Math.round(v).toLocaleString("en-US")}`;
  const name = measure === "automationPct" ? "Paid automatically" : "Expected leakage";
  const tooltip = {
    renderer: ({ datum }: { datum: CurveDatum }) => ({
      heading: `Standard limit ${currency} ${datum.limit.toLocaleString("en-US")}`,
      data: [{ label: name, value: fmtY(datum[measure]) }],
    }),
  };

  return {
    data: data.points,
    height,
    background: { visible: false },
    padding: { top: 12, right: 16, bottom: showXAxisTitle ? 4 : 0, left: 4 },
    legend: { enabled: false },
    animation: { enabled: false },
    series: [
      {
        type: "line",
        xKey: "limit",
        yKey: measure,
        yName: name,
        stroke: LINE,
        strokeWidth: 2,
        marker: { enabled: true, size: 8, fill: LINE, stroke: SURFACE, strokeWidth: 2 },
        tooltip,
      },
      {
        type: "scatter",
        data: [data.current],
        xKey: "limit",
        yKey: measure,
        yName: "Your setting",
        size: 14,
        fill: CURRENT,
        stroke: SURFACE,
        strokeWidth: 2,
        label: {
          enabled: true,
          placement: "top",
          color: INK,
          fontFamily: FONT,
          fontSize: 12,
          fontWeight: 600,
          formatter: ({ value }: { value: number }) => fmtY(value),
        },
        tooltip: {
          renderer: ({ datum }: { datum: CurveDatum }) => ({
            heading: `Your setting: ${currency} ${datum.limit.toLocaleString("en-US")}`,
            data: [{ label: name, value: fmtY(datum[measure]) }],
          }),
        },
      },
    ],
    axes: {
      x: {
        type: "number",
        position: "bottom",
        nice: false,
        label: {
          color: INK_MUTED,
          fontFamily: FONT,
          fontSize: 12,
          formatter: ({ value }: { value: number }) => Math.round(value).toLocaleString("en-US"),
        },
        line: { stroke: GRID },
        gridLine: { enabled: false },
        title: showXAxisTitle
          ? { enabled: true, text: `Standard employee limit (${currency})`, color: INK_MUTED, fontFamily: FONT, fontSize: 12 }
          : { enabled: false },
        crossLines: [{ type: "line", value: data.current.limit, stroke: CURRENT, strokeWidth: 1, strokeOpacity: 0.5 }],
      },
      y: {
        type: "number",
        position: "left",
        // Same width on both charts so their plot areas line up over the shared limit axis.
        thickness: 72,
        min: 0,
        ...(measure === "automationPct" ? { max: 100 } : {}),
        interval: { maxSpacing: 60 },
        label: {
          color: INK_MUTED,
          fontFamily: FONT,
          fontSize: 12,
          formatter: ({ value }: { value: number }) => fmtY(value),
        },
        line: { enabled: false },
        gridLine: { style: [{ stroke: GRID, lineDash: [] }] },
      },
    },
  };
}

interface BacktestChartProps {
  data: ChartData;
  currency: string;
}

/**
 * Two small charts sharing one x axis (the standard limit) instead of one chart with two
 * y-scales: automation % on top, expected leakage below. A table view carries every value.
 */
export default function BacktestChart({ data, currency }: BacktestChartProps) {
  const [showTable, setShowTable] = useState(false);
  // The chart only renders in the browser (dynamic import, no SSR), so reading the tokens once is safe.
  const [colors] = useState(readChartColors);
  const automation = useMemo(
    () => panelOptions(data, "automationPct", currency, false, AUTOMATION_HEIGHT, colors),
    [data, currency, colors],
  );
  const leakage = useMemo(() => panelOptions(data, "leakage", currency, true, LEAKAGE_HEIGHT, colors), [data, currency, colors]);

  const summary = `At a standard limit of ${currency} ${data.current.limit.toLocaleString("en-US")}, ${data.current.automationPct}% of claims are paid automatically with ${currency} ${data.current.leakage.toLocaleString("en-US")} expected leakage.`;

  return (
    <div>
      <p className="sr-only">{summary}</p>

      {!showTable && (
        <div aria-hidden="true">
          <h4 className="text-sm font-semibold text-ink">Claims paid automatically</h4>
          <AgCharts options={automation} modules={MODULES} style={{ height: AUTOMATION_HEIGHT }} />
          <h4 className="mt-3 text-sm font-semibold text-ink">Expected leakage, in {currency}</h4>
          <AgCharts options={leakage} modules={MODULES} style={{ height: LEAKAGE_HEIGHT }} />
        </div>
      )}

      {showTable && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Back-test by standard employee limit</caption>
            <thead>
              <tr className="text-left text-ink-muted border-b border-line">
                <th scope="col" className="py-2 pr-4 font-medium">Standard limit</th>
                <th scope="col" className="py-2 pr-4 font-medium text-right">Paid automatically</th>
                <th scope="col" className="py-2 font-medium text-right">Expected leakage</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {data.points.map((p) => (
                <tr key={p.limit} className="border-b border-line">
                  <td className="py-2 pr-4">{currency} {p.limit.toLocaleString("en-US")}</td>
                  <td className="py-2 pr-4 text-right">{p.automationPct}%</td>
                  <td className="py-2 text-right">{currency} {p.leakage.toLocaleString("en-US")}</td>
                </tr>
              ))}
              <tr className="font-semibold text-accent">
                <td className="py-2 pr-4">Your setting: {currency} {data.current.limit.toLocaleString("en-US")}</td>
                <td className="py-2 pr-4 text-right">{data.current.automationPct}%</td>
                <td className="py-2 text-right">{currency} {data.current.leakage.toLocaleString("en-US")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="inline-block w-3 h-3 rounded-full border-2 border-surface bg-accent" aria-hidden="true" />
          Your setting
          <span className="inline-block w-4 h-0.5 ml-3 rounded bg-ink-muted" aria-hidden="true" />
          Other standard limits
        </p>
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          aria-pressed={showTable}
          className="min-h-[44px] px-3 rounded-control border border-line text-sm font-semibold text-ink hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
        >
          {showTable ? "Show chart" : "Show as table"}
        </button>
      </div>
    </div>
  );
}
