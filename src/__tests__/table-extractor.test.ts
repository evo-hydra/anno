import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { tableExtractor } from '../services/extractors/table-extractor';

const parseDoc = (html: string): Document => {
  return new JSDOM(html).window.document;
};

describe('tableExtractor', () => {
  it('extracts a basic table with thead/tbody', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <thead><tr><th>Name</th><th>Age</th><th>City</th></tr></thead>
        <tbody>
          <tr><td>Alice</td><td>30</td><td>NYC</td></tr>
          <tr><td>Bob</td><td>25</td><td>LA</td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Name', 'Age', 'City']);
    expect(result[0].rows).toHaveLength(2);
    expect(result[0].rows[0]).toEqual({ Name: 'Alice', Age: '30', City: 'NYC' });
    expect(result[0].rows[1]).toEqual({ Name: 'Bob', Age: '25', City: 'LA' });
    expect(result[0].rowCount).toBe(2);
    expect(result[0].id).toBe('table-0');
  });

  it('extracts table without thead (first row as headers)', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <tr><th>Product</th><th>Price</th></tr>
        <tr><td>Widget</td><td>$9.99</td></tr>
        <tr><td>Gadget</td><td>$19.99</td></tr>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Product', 'Price']);
    expect(result[0].rows).toHaveLength(2);
  });

  it('skips nested tables', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <thead><tr><th>Data</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>A</td><td>
            <table><tr><td>Nested</td></tr></table>
          </td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    // The outer table should be extracted, nested one skipped
    expect(result).toHaveLength(1);
    expect(result[0].headers).toEqual(['Data', 'Value']);
  });

  it('skips layout tables (high link density)', () => {
    const links = Array.from({ length: 20 }, (_, i) =>
      `<tr><td><a href="/page${i}">Link ${i}</a></td><td><a href="/other${i}">Other ${i}</a></td></tr>`
    ).join('');

    const doc = parseDoc(`<html><body>
      <table>
        <tr><th>Nav</th><th>Links</th></tr>
        ${links}
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(0);
  });

  it('skips single-column tables with 10+ rows', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      `<tr><td>Row ${i}</td></tr>`
    ).join('');

    const doc = parseDoc(`<html><body>
      <table>
        <tr><td>Header</td></tr>
        ${rows}
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(0);
  });

  it('extracts table with caption', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <caption>Sales Data Q4 2025</caption>
        <thead><tr><th>Month</th><th>Revenue</th></tr></thead>
        <tbody>
          <tr><td>October</td><td>$10,000</td></tr>
          <tr><td>November</td><td>$12,000</td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].caption).toBe('Sales Data Q4 2025');
  });

  it('skips empty/degenerate tables', () => {
    const doc = parseDoc(`<html><body>
      <table></table>
      <table><tr></tr></table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(0);
  });

  it('respects row limit', () => {
    const rows = Array.from({ length: 600 }, (_, i) =>
      `<tr><td>Name ${i}</td><td>Value ${i}</td></tr>`
    ).join('');

    const doc = parseDoc(`<html><body>
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].rowCount).toBeLessThanOrEqual(500);
  });

  it('extracts multiple tables', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td></tr></tbody>
      </table>
      <table>
        <thead><tr><th>X</th><th>Y</th></tr></thead>
        <tbody><tr><td>3</td><td>4</td></tr></tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('table-0');
    expect(result[1].id).toBe('table-1');
  });

  it('computes higher confidence for well-structured tables', () => {
    const doc = parseDoc(`<html><body>
      <table>
        <thead><tr><th>Name</th><th>Age</th><th>Email</th></tr></thead>
        <tbody>
          <tr><td>Alice</td><td>30</td><td>alice@test.com</td></tr>
          <tr><td>Bob</td><td>25</td><td>bob@test.com</td></tr>
          <tr><td>Charlie</td><td>35</td><td>charlie@test.com</td></tr>
        </tbody>
      </table>
    </body></html>`);

    const result = tableExtractor.extract(doc);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.8);
  });
});
