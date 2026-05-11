import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  positionsAsRows,
  toCsv,
  reportHtml,
  filterZeroCommissionEtfs,
  type Position,
  type PositionsSummary,
  type ZeroCommissionEtf,
} from "../fineco-portfolio.js";

const execFileAsync = promisify(execFile);

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

describe("filterZeroCommissionEtfs", () => {
  const instruments: ZeroCommissionEtf[] = [
    {
      instrId: "IE0006WW1TQ4",
      venueSystem: "AFF",
      description: "Xtrackers MSCI World ex USA UCITS ETF 1C",
      issuer: "Xtrackers",
    },
    {
      instrId: "IE00B4L5Y983",
      venueSystem: "AFF",
      description: "iShares Core MSCI World UCITS ETF USD (Acc)",
      issuer: "BLACKROCK",
    },
  ];

  it("returns all instruments without a query", () => {
    assert.deepEqual(
      filterZeroCommissionEtfs(instruments, undefined),
      instruments,
    );
  });

  it("filters by ISIN, issuer, venue, or description", () => {
    assert.deepEqual(filterZeroCommissionEtfs(instruments, "IE0006WW1TQ4"), [
      instruments[0],
    ]);
    assert.deepEqual(filterZeroCommissionEtfs(instruments, "blackrock"), [
      instruments[1],
    ]);
    assert.deepEqual(filterZeroCommissionEtfs(instruments, "ex usa"), [
      instruments[0],
    ]);
    assert.equal(filterZeroCommissionEtfs(instruments, "AFF").length, 2);
  });
});

describe("zero-commission-etfs CLI", () => {
  it("does not read 1Password when FINECO_OP_ITEM is set", async () => {
    const source = encodeURIComponent(
      JSON.stringify({
        instruments: [
          {
            instrId: "IE00B4L5Y983",
            venueSystem: "AFF",
            description: "iShares Core MSCI World UCITS ETF USD (Acc)",
            issuer: "BLACKROCK",
          },
        ],
      }),
    );
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "fineco-portfolio.ts", "zero-commission-etfs", "blackrock"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          PATH: process.env.PATH ?? "",
          FINECO_OP_ITEM: "Missing Item That Must Not Be Read",
          FINECO_ZERO_COMMISSION_ETFS_URL: `data:application/json,${source}`,
        },
      },
    );
    const parsed = JSON.parse(stdout) as { count: number };
    assert.equal(parsed.count, 1);
  });
});
