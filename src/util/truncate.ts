/**
 * Tool-result serialisation: JSON by default, compact TOON-style tables on
 * request, always under the configured character budget.
 */

import type { OutputFormat } from '../contracts.js';

/** Serialises `value`, truncated to `maxChars` with a marker line. */
export function serializeResult(
  value: unknown,
  maxChars: number,
  output: OutputFormat,
): { text: string; truncated: boolean } {
  const full = output === 'toon' ? toToon(value) : JSON.stringify(value, null, 2);
  if (full.length <= maxChars) return { text: full, truncated: false };
  const marker = `\n…[truncated to ${maxChars} chars]`;
  return { text: `${full.slice(0, Math.max(0, maxChars - marker.length))}${marker}`, truncated: true };
}

/** Truncates plain text to `maxChars`, appending an ellipsis marker. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Minimal TOON rendering: object arrays become header + tab rows. */
function toToon(value: unknown): string {
  if (Array.isArray(value) && value.length > 0 && value.every((row) => isRecord(row))) {
    const headers = [...new Set((value as Record<string, unknown>[]).flatMap((row) => Object.keys(row)))];
    const lines = [headers.join('\t')];
    for (const row of value as Record<string, unknown>[]) {
      lines.push(headers.map((h) => cell(row[h])).join('\t'));
    }
    return lines.join('\n');
  }
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\t|\n/g, ' ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Strips HTML tags, collapsing whitespace. Redmine ships HTML in journals. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
