import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  positionsAsRows,
  toCsv,
  reportHtml,
  filterZeroCommissionEtfs,
  fetchTaxCarryForward,
  fetchTaxMinusByYear,
  isIsoDate,
  type Config,
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

describe("fetchTaxCarryForward", () => {
  it("uses the explicit date range as query parameters", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];

    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ total: 0, list: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const config: Config = {
      userId: "test",
      password: "test",
      debug: false,
      command: "tax-carry-forward",
      query: undefined,
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
      output: "json",
      outPath: undefined,
      positionsUrl: "https://example.test/positions",
      marketSearchUrl: "https://example.test/search",
      assetDetailsUrl: "https://example.test/details",
      marketIndicesUrl: "https://example.test/indices",
      taxCarryForwardUrl: "https://example.test/tax-carry-forward/search",
      taxCarryForwardMinusUrl: "https://example.test/tax-carry-forward/minus",
      snapshotUrl: "https://example.test/snapshot",
      instrumentSnapshotUrl: "https://example.test/instrument-snapshot",
      chartDataUrl: "https://example.test/chart",
      linkedIndicesUrl: "https://example.test/linked-indices",
      economicEventsUrl: "https://example.test/events",
      similarInstrumentsUrl: "https://example.test/similar",
      newsUrl: "https://example.test/news",
      instrumentListUrl: "https://example.test/instrument-list",
      syntheticCookies: true,
    };

    try {
      const result = await fetchTaxCarryForward(config, "session=test", () => {
        // Test logger intentionally silent.
      });

      assert.equal(result.ok, true);
      assert.equal(requestedUrls.length, 1);
      const url = new URL(requestedUrls[0]!);
      assert.equal(url.searchParams.get("dateFrom"), "2026-01-01");
      assert.equal(url.searchParams.get("dateTo"), "2026-01-31");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("fetchTaxMinusByYear", () => {
  it("fetches the minus by year endpoint without query parameters", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];

    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify({
          total: 0,
          list: [
            {
              year: 2026,
              minusResidue: 0,
              expirationDate: "2030-12-31",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    };

    const config: Config = {
      userId: "test",
      password: "test",
      debug: false,
      command: "tax-minus-by-year",
      query: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      output: "json",
      outPath: undefined,
      positionsUrl: "https://example.test/positions",
      marketSearchUrl: "https://example.test/search",
      assetDetailsUrl: "https://example.test/details",
      marketIndicesUrl: "https://example.test/indices",
      taxCarryForwardUrl: "https://example.test/tax-carry-forward/search",
      taxCarryForwardMinusUrl: "https://example.test/tax-carry-forward/minus",
      snapshotUrl: "https://example.test/snapshot",
      instrumentSnapshotUrl: "https://example.test/instrument-snapshot",
      chartDataUrl: "https://example.test/chart",
      linkedIndicesUrl: "https://example.test/linked-indices",
      economicEventsUrl: "https://example.test/events",
      similarInstrumentsUrl: "https://example.test/similar",
      newsUrl: "https://example.test/news",
      instrumentListUrl: "https://example.test/instrument-list",
      syntheticCookies: true,
    };

    try {
      const result = await fetchTaxMinusByYear(config, "session=test", () => {
        // Test logger intentionally silent.
      });

      assert.equal(result.ok, true);
      assert.deepEqual(requestedUrls, [
        "https://example.test/tax-carry-forward/minus",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("isIsoDate", () => {
  it("rejects malformed and impossible dates without throwing", () => {
    assert.equal(isIsoDate("2026-01-31"), true);
    assert.equal(isIsoDate("2026-1-31"), false);
    assert.equal(isIsoDate("2026-00-01"), false);
    assert.equal(isIsoDate("2026-13-01"), false);
    assert.equal(isIsoDate("2026-02-30"), false);
  });
});
