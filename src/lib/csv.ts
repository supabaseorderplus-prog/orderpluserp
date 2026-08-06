// Tiny client-side CSV builder + download helper. No deps, RFC-4180 quoting.

type CsvCell = string | number | null | undefined;

/** Quote a single cell so commas, quotes and newlines survive Excel/Sheets. */
function escapeCell(value: CsvCell): string {
  const raw = value == null ? "" : String(value);
  if (/[",\n\r]/.test(raw)) return `"${raw.replace(/"/g, '""')}"`;
  return raw;
}

/** Build a CSV string from a header row and matching data rows. */
export function toCsv(headers: readonly string[], rows: readonly CsvCell[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(escapeCell).join(","));
  // Prepend a BOM so Excel renders ₹ and other UTF-8 glyphs correctly.
  return "﻿" + lines.join("\r\n");
}

/** Trigger a browser download of `content` as `filename`. */
export function downloadCsv(filename: string, content: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
