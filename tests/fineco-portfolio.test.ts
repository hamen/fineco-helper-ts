import { describe, it } from "node:test";
import { strict as assert } from "node:assert";

import {
  positionsAsRows,
  toCsv,
  reportHtml,
  type Position,
  type PositionsSummary,
} from "../fineco-portfolio.js";

const samplePositions: Position[] = [
  {
    instrId: "AAPL",
    description: "Apple Inc.",
    symbol: "AAPL",
    venueSystem: "NASDAQ",
    currencyCd: "USD",
    type: "Azioni",
    qty: 10,
    avgPrice: 150.0,
    marketPrice: 175.0,
    bookValue: 1500.0,
    marketValue: 1750.0,
    profitLoss: 250.0,
    profitLossPerc: 16.67,
  },
  {
    instrId: "VWCE",
    description: "Vanguard FTSE All-World",
    symbol: "VWCE",
    venueSystem: "MTA",
    currencyCd: "EUR",
    type: "ETF",
    qty: 50,
    avgPrice: 100.0,
    marketPrice: 110.0,
    bookValue: 5000.0,
    marketValue: 5500.0,
    profitLoss: 500.0,
    profitLossPerc: 10.0,
  },
];

const sampleSummary: PositionsSummary = {
  positions: { show: samplePositions },
  summary: {
    show: {
      currencyCd: "EUR",
      bookValue: 6500.0,
      marketValue: 7250.0,
      profitLoss: 750.0,
      profitLossPerc: 11.54,
    },
  },
  filters: {
    currencies: { show: ["EUR", "USD"] },
    instrumentTypes: { show: ["Azioni", "ETF"] },
  },
};

// --- positionsAsRows ---

describe("positionsAsRows", () => {
  it("extracts positions from a populated summary", () => {
    const rows = positionsAsRows(sampleSummary);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.symbol, "AAPL");
    assert.equal(rows[1]?.symbol, "VWCE");
  });

  it("returns empty array when summary is empty", () => {
    assert.deepEqual(positionsAsRows({}), []);
  });

  it("returns empty array when positions.show is missing", () => {
    assert.deepEqual(positionsAsRows({ positions: {} }), []);
  });

  it("returns empty array when positions key is missing", () => {
    assert.deepEqual(positionsAsRows({ summary: {} }), []);
  });
});

// --- toCsv ---

describe("toCsv", () => {
  it("generates header + data rows", () => {
    const csv = toCsv(samplePositions);
    const lines = csv.split("\n");
    assert.equal(lines.length, 3); // header + 2 data rows

    const header = lines[0]!;
    assert.ok(header.includes("instrId"));
    assert.ok(header.includes("description"));
    assert.ok(header.includes("marketValue"));

    assert.ok(lines[1]!.includes("AAPL"));
    assert.ok(lines[2]!.includes("VWCE"));
  });

  it("returns just an empty header line for empty array", () => {
    const csv = toCsv([]);
    assert.equal(csv, "");
  });

  it("quotes values that contain commas", () => {
    const rows: Position[] = [{ description: "Hello, World", symbol: "TEST" }];
    const csv = toCsv(rows);
    assert.ok(csv.includes('"Hello, World"'));
  });

  it("quotes values that contain double quotes", () => {
    const rows: Position[] = [{ description: 'Say "hi"', symbol: "Q" }];
    const csv = toCsv(rows);
    assert.ok(csv.includes('"Say ""hi"""'));
  });

  it("preserves numeric precision", () => {
    const rows: Position[] = [{ qty: 1.123456, avgPrice: 99.99 }];
    const csv = toCsv(rows);
    assert.ok(csv.includes("1.123456"));
    assert.ok(csv.includes("99.99"));
  });
});

// --- reportHtml ---

describe("reportHtml", () => {
  it("generates a valid HTML document", () => {
    const html = reportHtml(sampleSummary);
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("<html"));
    assert.ok(html.includes("</html>"));
  });

  it("includes position descriptions and symbols", () => {
    const html = reportHtml(sampleSummary);
    assert.ok(html.includes("Apple Inc."));
    assert.ok(html.includes("Vanguard FTSE All-World"));
    assert.ok(html.includes("AAPL"));
    assert.ok(html.includes("VWCE"));
  });

  it("includes summary cards", () => {
    const html = reportHtml(sampleSummary);
    assert.ok(html.includes("Book Value"));
    assert.ok(html.includes("Market Value"));
    assert.ok(html.includes("Profit / Loss"));
    assert.ok(html.includes("Return"));
  });

  it("includes instrument type filter chips", () => {
    const html = reportHtml(sampleSummary);
    assert.ok(html.includes("Azioni"));
    assert.ok(html.includes("ETF"));
  });

  it("renders position count", () => {
    const html = reportHtml(sampleSummary);
    assert.ok(html.includes("2 positions"));
  });

  it("handles empty summary without crashing", () => {
    const html = reportHtml({});
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes("0 positions"));
  });

  it("applies positive/negative CSS classes to P/L", () => {
    const html = reportHtml(sampleSummary);
    // All positions have positive P/L, so "positive" class should appear
    assert.ok(html.includes('class="num positive"'));
  });
});
