/**
 * Table Extractor
 *
 * Converts HTML tables to structured JSON with headers and rows.
 * Filters out layout tables and non-data tables using heuristics.
 *
 * @module extractors/table-extractor
 */

export interface ExtractedTable {
  id: string;
  caption: string | null;
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
  confidence: number;
}

const MAX_TABLES = 50;
const MAX_ROWS_PER_TABLE = 500;
const LINK_DENSITY_THRESHOLD = 0.4;

export class TableExtractor {
  /**
   * Extract all data tables from a DOM Document.
   */
  extract(document: Document): ExtractedTable[] {
    const tables = Array.from(document.querySelectorAll('table'));
    const results: ExtractedTable[] = [];

    for (let i = 0; i < Math.min(tables.length, MAX_TABLES); i++) {
      const table = tables[i];

      if (this.shouldSkip(table)) continue;

      const extracted = this.extractTable(table, i);
      if (extracted) {
        results.push(extracted);
      }
    }

    return results;
  }

  private shouldSkip(table: HTMLTableElement): boolean {
    // Skip nested tables (table is inside another table)
    if (table.parentElement?.closest('table') !== null) {
      return true;
    }

    // Skip layout tables (high link density)
    const textLength = table.textContent?.length ?? 0;
    if (textLength === 0) return true;

    const links = table.querySelectorAll('a');
    const linkTextLength = Array.from(links).reduce(
      (sum, a) => sum + (a.textContent?.length ?? 0),
      0
    );
    if (linkTextLength / textLength > LINK_DENSITY_THRESHOLD) {
      return true;
    }

    // Skip single-column tables with 10+ rows (likely layout)
    const rows = table.querySelectorAll('tr');
    if (rows.length >= 10) {
      const firstRow = rows[0];
      const cells = firstRow?.querySelectorAll('td, th');
      if (cells && cells.length <= 1) {
        return true;
      }
    }

    return false;
  }

  private extractTable(table: HTMLTableElement, index: number): ExtractedTable | null {
    const caption = table.querySelector('caption')?.textContent?.trim() ?? null;
    const headers = this.extractHeaders(table);

    if (headers.length === 0) return null;

    const rows = this.extractRows(table, headers);

    if (rows.length === 0) return null;

    const confidence = this.computeConfidence(headers, rows);

    return {
      id: `table-${index}`,
      caption,
      headers,
      rows,
      rowCount: rows.length,
      confidence,
    };
  }

  private extractHeaders(table: HTMLTableElement): string[] {
    // Try thead > tr > th first
    const theadRow = table.querySelector('thead > tr');
    if (theadRow) {
      const ths = theadRow.querySelectorAll('th');
      if (ths.length > 0) {
        return Array.from(ths).map((th) => th.textContent?.trim() ?? '');
      }
    }

    // Fall back to first row (th or td)
    const firstRow = table.querySelector('tr');
    if (!firstRow) return [];

    const cells = firstRow.querySelectorAll('th, td');
    if (cells.length === 0) return [];

    // Heuristic: if all cells in the first row are th, or if the row looks like a header
    const allTh = Array.from(cells).every((c) => c.tagName === 'TH');
    if (allTh) {
      return Array.from(cells).map((c) => c.textContent?.trim() ?? '');
    }

    // Fall back to using first row as headers if we have a tbody with more rows
    const tbody = table.querySelector('tbody');
    const bodyRows = tbody ? tbody.querySelectorAll('tr') : table.querySelectorAll('tr');
    if (bodyRows.length > 1) {
      return Array.from(cells).map((c) => c.textContent?.trim() ?? '');
    }

    return [];
  }

  private extractRows(table: HTMLTableElement, headers: string[]): Record<string, string>[] {
    const rows: Record<string, string>[] = [];

    // Get data rows (skip header row)
    const allRows = Array.from(table.querySelectorAll('tr'));
    const dataRows = this.getDataRows(table, allRows);

    for (let i = 0; i < Math.min(dataRows.length, MAX_ROWS_PER_TABLE); i++) {
      const tr = dataRows[i];
      const cells = tr.querySelectorAll('td, th');
      if (cells.length === 0) continue;

      const row: Record<string, string> = {};
      cells.forEach((cell, cellIndex) => {
        const key = cellIndex < headers.length ? headers[cellIndex] : `column_${cellIndex}`;
        row[key] = cell.textContent?.trim() ?? '';
      });

      // Skip rows that are entirely empty
      const hasContent = Object.values(row).some((v) => v.length > 0);
      if (hasContent) {
        rows.push(row);
      }
    }

    return rows;
  }

  private getDataRows(table: HTMLTableElement, allRows: HTMLTableRowElement[]): HTMLTableRowElement[] {
    // If there's a thead, data rows are in tbody or outside thead
    const thead = table.querySelector('thead');
    if (thead) {
      const tbody = table.querySelector('tbody');
      if (tbody) {
        return Array.from(tbody.querySelectorAll('tr'));
      }
      // Skip rows that are inside thead
      return allRows.filter((row) => !thead.contains(row));
    }

    // No thead — skip first row (used as header)
    return allRows.slice(1);
  }

  private computeConfidence(headers: string[], rows: Record<string, string>[]): number {
    let confidence = 0.3; // Base confidence for having headers and rows

    // Named headers (not empty) boost confidence
    const namedHeaders = headers.filter((h) => h.length > 0);
    if (namedHeaders.length === headers.length && headers.length > 1) {
      confidence += 0.3;
    } else if (namedHeaders.length > 0) {
      confidence += 0.15;
    }

    // Consistent row size boosts confidence
    const expectedCols = headers.length;
    const consistentRows = rows.filter(
      (r) => Object.keys(r).length === expectedCols
    );
    if (consistentRows.length === rows.length) {
      confidence += 0.2;
    }

    // More rows = more likely to be actual data
    if (rows.length >= 3) {
      confidence += 0.2;
    } else if (rows.length >= 1) {
      confidence += 0.1;
    }

    return Math.min(confidence, 1);
  }
}

export const tableExtractor = new TableExtractor();
