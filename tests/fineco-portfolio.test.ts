import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { fetchEnrichmentReport, matchEnrichmentTitle } from "../enrichment.js";
import {
  positionsAsRows,
  toCsv,
  reportHtml,
  filterZeroCommissionEtfs,
  fetchOrderMonitor,
  fetchOrderMonitorFilters,
  fetchTaxCarryForward,
  fetchMovements,
  fetchZeroCommissionEtfs,
  logout,
  fetchPositionsSummary,
  fetchTaxMinusByYear,
  isIsoDate,
  dividendsFromMovements,
  retryAfterSeconds,
  renderOutput,
  envIndex,
  parseArgs,
  type Movement,
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

describe("enrichment", () => {
  function allowedHost(): string {
    return String.fromCharCode(
      115,
      105,
      109,
      112,
      108,
      121,
      119,
      97,
      108,
      108,
      46,
      115,
      116,
    );
  }

  function allowedUrl(): string {
    return `https://${allowedHost()}/stocks/us/tech/nasdaq-aapl/apple`;
  }

  function fixtureUrl(): string {
    const state = {
      queries: [
        {
          queryKey: ["company"],
          state: {
            data: {
              data: {
                name: "Apple Inc.",
                unique_symbol: "NasdaqGS:AAPL",
                info: {
                  name: "Apple Inc.",
                  unique_symbol: "NasdaqGS:AAPL",
                  exchange_symbol: "NasdaqGS",
                  isin_symbol: "US0378331005",
                  country: "United States",
                  url: "https://www.apple.com",
                  description: "Consumer technology company.",
                },
                score: { data: { value: 2, future: 3, past: 5 } },
                analysis: {
                  data: {
                    extended: {
                      data: {
                        raw_data: {
                          data: {
                            company_info: {
                              name: "Apple Inc.",
                              unique_symbol: "NasdaqGS:AAPL",
                              exchange_symbol: "NasdaqGS",
                              isin_symbol: "US0378331005",
                              country: "United States",
                              url: "https://www.apple.com",
                              description: "Consumer technology company.",
                            },
                          },
                        },
                        analysis: {
                          value: { pe: 28.4, market_cap: 3000000000000 },
                          future: { revenue_growth_annual: 0.04 },
                        },
                        scores: { value: 2, future: 3, past: 5 },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    };
    const html = `<script>window.__REACT_QUERY_STATE__ = ${JSON.stringify(state)}</script>`;
    return `data:text/html,${encodeURIComponent(html)}`;
  }

  it("builds a report from an embedded page cache", async () => {
    const report = await fetchEnrichmentReport({
      url: fixtureUrl(),
      finecoTitle: "APPLE INC AAPL US0378331005",
      validateSource: false,
    });

    assert.equal(report.company.name, "Apple Inc.");
    assert.equal(report.company.isin, "US0378331005");
    assert.equal(report.match?.verdict, "strong");
    assert.ok(report.markdown.includes("# Apple Inc. Stock Report"));
    assert.equal(report.metrics.value?.pe, 28.4);
  });

  it("rejects unsupported hosts before fetching", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("");
    };

    try {
      await assert.rejects(
        () =>
          fetchEnrichmentReport({
            url: "https://example.com/stocks/us/example",
          }),
        /host is not allowed/,
      );
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects data URLs unless source validation is explicitly disabled", async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response("");
    };

    try {
      await assert.rejects(
        () =>
          fetchEnrichmentReport({
            url: fixtureUrl(),
          }),
        /must use https/,
      );
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects redirects to unsupported hosts", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response("", {
        status: 302,
        headers: {
          location: "https://example.com/stocks/us/example",
        },
      });
    };

    try {
      await assert.rejects(
        () =>
          fetchEnrichmentReport({
            url: allowedUrl(),
          }),
        /host is not allowed/,
      );
      assert.deepEqual(requestedUrls, [allowedUrl()]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects non-JSON embedded cache payloads", async () => {
    await assert.rejects(
      () =>
        fetchEnrichmentReport({
          url: `data:text/html,${encodeURIComponent("<script>window.__REACT_QUERY_STATE__ = (() => ({ queries: [] }))()</script>")}`,
          validateSource: false,
        }),
      /Embedded query cache was not valid JSON data/,
    );
  });

  it("parses bare undefined values as missing JSON data", async () => {
    const html = `<script>window.__REACT_QUERY_STATE__ = {"queries":[{"queryKey":["company"],"state":{"data":{"data":{"name":"Undefined Test","unique_symbol":"TEST:U","analysis":{"data":{"extended":{"data":{"raw_data":{"data":{"company_info":{"name":"Undefined Test","unique_symbol":"TEST:U","description":"literal undefined stays in strings"}}},"analysis":{"value":{"pe":undefined}},"scores":{"value":undefined}}}}}}}}}]}</script>`;
    const report = await fetchEnrichmentReport({
      url: `data:text/html,${encodeURIComponent(html)}`,
      validateSource: false,
    });

    assert.equal(report.company.name, "Undefined Test");
    assert.equal(report.metrics.value?.pe, null);
  });

  it("rejects null embedded cache payloads without crashing", async () => {
    const html = "<script>window.__REACT_QUERY_STATE__ = null</script>";

    await assert.rejects(
      () =>
        fetchEnrichmentReport({
          url: `data:text/html,${encodeURIComponent(html)}`,
          validateSource: false,
        }),
      /Embedded query cache was not a JSON object/,
    );
  });

  it("scores weak title matches conservatively", () => {
    const match = matchEnrichmentTitle("Vanguard FTSE All-World", {
      name: "Apple Inc.",
      ticker: "NasdaqGS:AAPL",
      exchange: "NasdaqGS",
      isin: "US0378331005",
      country: "United States",
      website: "https://www.apple.com",
      description: "",
    });

    assert.equal(match.verdict, "weak");
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
      orderType: "equity",
      orderDays: 0,
      output: "json",
      outPath: undefined,
      positionsUrl: "https://example.test/positions",
      marketSearchUrl: "https://example.test/search",
      assetDetailsUrl: "https://example.test/details",
      marketIndicesUrl: "https://example.test/indices",
      taxCarryForwardUrl: "https://example.test/tax-carry-forward/search",
      taxCarryForwardMinusUrl: "https://example.test/tax-carry-forward/minus",
      orderMonitorUrl: "https://example.test/transactions",
      orderMonitorFiltersUrl: "https://example.test/monitor-filters",
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
      orderType: "equity",
      orderDays: 0,
      output: "json",
      outPath: undefined,
      positionsUrl: "https://example.test/positions",
      marketSearchUrl: "https://example.test/search",
      assetDetailsUrl: "https://example.test/details",
      marketIndicesUrl: "https://example.test/indices",
      taxCarryForwardUrl: "https://example.test/tax-carry-forward/search",
      taxCarryForwardMinusUrl: "https://example.test/tax-carry-forward/minus",
      orderMonitorUrl: "https://example.test/transactions",
      orderMonitorFiltersUrl: "https://example.test/monitor-filters",
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

describe("order monitor APIs", () => {
  it("adds type and days to the transactions endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];

    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ transactions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const config: Config = {
      userId: "test",
      password: "test",
      debug: false,
      command: "order-monitor",
      query: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      orderType: "equity",
      orderDays: 0,
      output: "json",
      outPath: undefined,
      positionsUrl: "https://example.test/positions",
      marketSearchUrl: "https://example.test/search",
      assetDetailsUrl: "https://example.test/details",
      marketIndicesUrl: "https://example.test/indices",
      taxCarryForwardUrl: "https://example.test/tax-carry-forward/search",
      taxCarryForwardMinusUrl: "https://example.test/tax-carry-forward/minus",
      orderMonitorUrl: "https://example.test/transactions",
      orderMonitorFiltersUrl: "https://example.test/monitor-filters",
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
      const result = await fetchOrderMonitor(config, "session=test", () => {
        // Test logger intentionally silent.
      });

      assert.equal(result.ok, true);
      const url = new URL(requestedUrls[0]!);
      assert.equal(url.searchParams.get("type"), "equity");
      assert.equal(url.searchParams.get("days"), "0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("adds type to the monitor filters endpoint", async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];

    globalThis.fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ statuses: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const config: Config = {
      userId: "test",
      password: "test",
      debug: false,
      command: "order-monitor-filters",
      query: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      orderType: "equity",
      orderDays: 0,
      output: "json",
      outPath: undefined,
      positionsUrl: "https://example.test/positions",
      marketSearchUrl: "https://example.test/search",
      assetDetailsUrl: "https://example.test/details",
      marketIndicesUrl: "https://example.test/indices",
      taxCarryForwardUrl: "https://example.test/tax-carry-forward/search",
      taxCarryForwardMinusUrl: "https://example.test/tax-carry-forward/minus",
      orderMonitorUrl: "https://example.test/transactions",
      orderMonitorFiltersUrl: "https://example.test/monitor-filters",
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
      const result = await fetchOrderMonitorFilters(
        config,
        "session=test",
        () => {
          // Test logger intentionally silent.
        },
      );

      assert.equal(result.ok, true);
      const url = new URL(requestedUrls[0]!);
      assert.equal(url.searchParams.get("type"), "equity");
      assert.equal(url.searchParams.has("days"), false);
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

// A synthetic capture: real `causaleMovimento` codes and `descrizione` prefixes,
// invented securities and round amounts.
function movement(
  causaleMovimento: string,
  dataOperazione: string,
  descrizione: string | undefined,
  importo: number,
  progressivoMovimento?: string,
): Movement {
  return {
    dataOperazione,
    importo,
    causaleMovimento,
    ...(descrizione === undefined ? {} : { descrizione }),
    ...(progressivoMovimento === undefined ? {} : { progressivoMovimento }),
  };
}

const META = {
  dateFrom: "2026-01-01",
  dateTo: "2026-03-31",
  capturedAt: "2026-04-01T10:00:00.000Z",
};

describe("dividendsFromMovements", () => {
  // `importo` is typed as a number, but the bank response is untyped at runtime.
  // A string amount used to make Math.round return NaN and pollute every total
  // with no sign that anything was wrong.
  it("refuses an amount it cannot read instead of returning NaN totals", () => {
    assert.throws(
      () =>
        dividendsFromMovements(
          [
            {
              ...movement("DII", "2026-02-10", "Div.su 100 EXAMPLE SPA", 0),
              importo: "147,73" as unknown as number,
            },
          ],
          META,
        ),
      /unreadable importo/,
    );
  });

  it("refuses a missing amount instead of posting a zero-value dividend", () => {
    assert.throws(
      () =>
        dividendsFromMovements(
          [
            {
              ...movement("DII", "2026-02-10", "Div.su 100 EXAMPLE SPA", 0),
              importo: undefined as unknown as number,
            },
          ],
          META,
        ),
      /unreadable importo/,
    );
  });

  it("reads a label whose prefix arrives in a different case", () => {
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", "DIV.SU 100,000 EXAMPLE SPA", 10),
        movement("DIR", "2026-02-10", "RIT.DIV.SU 100,000 EXAMPLE SPA", -2),
      ],
      META,
    );

    assert.equal(report.events.length, 1);
    assert.equal(report.events[0]!.security, "100,000 EXAMPLE SPA");
    assert.equal(report.events[0]!.netCents, 800);
  });

  // Documents the known limit rather than hiding it: the group key carries the
  // operation date, so legs posted on different days stay apart. The totals are
  // still right; the per-event split is not.
  it("leaves legs posted on different days unpaired", () => {
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", "Div.su 100 EXAMPLE SPA", 10),
        movement("DIR", "2026-02-11", "Rit.div.su 100 EXAMPLE SPA", -2),
      ],
      META,
    );

    assert.equal(report.events.length, 2);
    assert.deepEqual(report.events.map((event) => event.unpaired).sort(), [
      "gross",
      "withholding",
    ]);
    assert.equal(report.totals.netCents, 800);
  });

  it("pairs an Italian dividend with its withholding", () => {
    // Amounts with real cents, not round numbers: they are what exercises the
    // Math.round path, where a float would drift.
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", "Div.su 100,000 EXAMPLE SPA", 147.73),
        movement("DIR", "2026-02-10", "Rit.div.su 100,000 EXAMPLE SPA", -38.41),
      ],
      META,
    );

    assert.equal(report.events.length, 1);
    const event = report.events[0]!;
    assert.equal(event.security, "100,000 EXAMPLE SPA");
    assert.equal(event.kind, "dividend");
    assert.equal(event.grossCents, 14773);
    assert.equal(event.withholdingCents, 3841);
    assert.equal(event.netCents, 10932);
    assert.equal(event.unpaired, undefined);
    assert.equal(report.totals.netCents, 10932);
    assert.equal(report.assumedCurrency, "EUR");
    assert.equal(report.capturedAt, META.capturedAt);
  });

  it("pairs a foreign withholding, which arrives under DER", () => {
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-03-05", "Div.su 4,000 EXAMPLE CORP", 1),
        movement("DER", "2026-03-05", "Rit.div.su 4,000 EXAMPLE CORP", -0.15),
      ],
      META,
    );

    assert.equal(report.events.length, 1);
    assert.equal(report.events[0]!.grossCents, 100);
    assert.equal(report.events[0]!.withholdingCents, 15);
    assert.equal(report.events[0]!.netCents, 85);
  });

  it("pairs a remunerated-portfolio dividend separately from a plain one", () => {
    const report = dividendsFromMovements(
      [
        movement("DPR", "2026-02-20", "Acc.div.Port.Rem. EXAMPLE SPA", 40),
        movement("RPR", "2026-02-20", "Add.rit.Port.Rem. EXAMPLE SPA", -10.4),
      ],
      META,
    );

    assert.equal(report.events.length, 1);
    assert.equal(report.events[0]!.kind, "remunerated_portfolio");
    // Both legs, not only the net: two compensating errors keep the net intact.
    assert.equal(report.events[0]!.grossCents, 4000);
    assert.equal(report.events[0]!.withholdingCents, 1040);
    assert.equal(report.events[0]!.netCents, 2960);
  });

  it("flags a withholding whose gross leg is outside the range", () => {
    const report = dividendsFromMovements(
      [movement("DIR", "2026-01-05", "Rit.div.su 100,000 EXAMPLE SPA", -52)],
      META,
    );

    assert.equal(report.events[0]!.unpaired, "gross");
    assert.equal(report.events[0]!.grossCents, 0);
    assert.equal(report.events[0]!.netCents, -5200);
  });

  it("flags a gross with no withholding — ambiguous, so it is not asserted away", () => {
    const report = dividendsFromMovements(
      [movement("DII", "2026-01-05", "Div.su 10,000 EXAMPLE ETF", 30)],
      META,
    );

    assert.equal(report.events[0]!.unpaired, "withholding");
    assert.equal(report.events[0]!.withholdingCents, 0);
    assert.equal(report.events[0]!.netCents, 3000);
  });

  it("keeps a dividend reversal negative instead of counting it as income", () => {
    const report = dividendsFromMovements(
      [movement("DII", "2026-02-10", "Div.su 100,000 EXAMPLE SPA", -200)],
      META,
    );

    assert.equal(report.events[0]!.grossCents, -20000);
    assert.equal(report.events[0]!.netCents, -20000);
  });

  it("keeps a withholding refund negative instead of counting it as tax", () => {
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", "Div.su 100,000 EXAMPLE SPA", 200),
        movement("DIR", "2026-02-10", "Rit.div.su 100,000 EXAMPLE SPA", 52),
      ],
      META,
    );

    assert.equal(report.events[0]!.withholdingCents, -5200);
    assert.equal(report.events[0]!.netCents, 25200);
  });

  it("sums two rows for one security on one day", () => {
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", "Div.su 100,000 EXAMPLE SPA", 200),
        movement("DII", "2026-02-10", "Div.su 100,000 EXAMPLE SPA", 50),
      ],
      META,
    );

    assert.equal(report.events.length, 1);
    assert.equal(report.events[0]!.grossCents, 25000);
  });

  it("keeps the same security on different days apart", () => {
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", "Div.su 100,000 EXAMPLE SPA", 200),
        movement("DII", "2026-03-10", "Div.su 100,000 EXAMPLE SPA", 200),
      ],
      META,
    );

    assert.equal(report.events.length, 2);
  });

  it("excludes interest and its withholding", () => {
    const report = dividendsFromMovements(
      [
        movement("IPR", "2026-02-01", "Interessi Portaf. Remun.", 0.28),
        movement(
          "RPI",
          "2026-02-01",
          "Rit. Fisc. Interessi Portaf.Remun.",
          -0.07,
        ),
      ],
      META,
    );

    assert.deepEqual(report.events, []);
    assert.equal(report.totals.count, 0);
  });

  it("never merges two unlabelled rows into one security", () => {
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", undefined, 200),
        movement("DII", "2026-02-10", undefined, 50),
      ],
      META,
    );

    assert.equal(report.events.length, 2);
    assert.equal(report.events[0]!.security, "(unlabelled movement)");
  });

  it("falls back to progressivoMovimento when the description has no known prefix", () => {
    const report = dividendsFromMovements(
      [movement("DII", "2026-02-10", "Something unexpected", 200, "PM-7")],
      META,
    );

    assert.equal(report.events[0]!.security, "PM-7");
  });

  it("treats a description that is only the prefix as unlabelled", () => {
    // "Div.su " alone parses to "", which is not a label: two such rows must not
    // share a group key, and `security` must not come back blank.
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", "Div.su   ", 200),
        movement("DII", "2026-02-10", "Div.su ", 50),
      ],
      META,
    );

    assert.equal(report.events.length, 2);
    for (const event of report.events) {
      assert.equal(event.security, "(unlabelled movement)");
    }
  });

  it("does not pair a gross and a withholding that both lack a description", () => {
    // This is the merge the row-index fallback exists to stop: without it both rows
    // share a key and net out to a single, wrong event.
    const report = dividendsFromMovements(
      [
        movement("DII", "2026-02-10", undefined, 200),
        movement("DIR", "2026-02-10", undefined, -52),
      ],
      META,
    );

    assert.equal(report.events.length, 2);
    assert.equal(report.events[0]!.unpaired, "withholding");
    assert.equal(report.events[0]!.grossCents, 20000);
    assert.equal(report.events[1]!.unpaired, "gross");
    assert.equal(report.events[1]!.withholdingCents, 5200);
  });

  it("does not pair legs that share no progressivoMovimento", () => {
    const report = dividendsFromMovements(
      [
        movement("DPR", "2026-02-20", undefined, 40, "PM-1"),
        movement("RPR", "2026-02-20", undefined, -10.4, "PM-2"),
      ],
      META,
    );

    assert.equal(report.events.length, 2);
  });

  it("echoes the requested range on an empty result", () => {
    const report = dividendsFromMovements([], META);

    assert.equal(report.dateFrom, "2026-01-01");
    assert.equal(report.dateTo, "2026-03-31");
    assert.deepEqual(report.totals, {
      grossCents: 0,
      withholdingCents: 0,
      netCents: 0,
      count: 0,
    });
  });

  it("propagates truncation", () => {
    assert.equal(
      dividendsFromMovements([], { ...META, truncated: true }).truncated,
      true,
    );
    assert.equal(dividendsFromMovements([], META).truncated, false);
  });
});

describe("retryAfterSeconds", () => {
  const withHeader = (value?: string) =>
    new Response("", {
      status: 429,
      ...(value === undefined ? {} : { headers: { "retry-after": value } }),
    });

  it("reads the delay-seconds form", () => {
    assert.equal(retryAfterSeconds(withHeader("30")), 30);
  });

  it("reads the HTTP-date form", () => {
    const now = Date.parse("2026-04-01T10:00:00.000Z");
    assert.equal(
      retryAfterSeconds(withHeader("Wed, 01 Apr 2026 10:00:45 GMT"), now),
      45,
    );
  });

  it("never returns a negative wait for a date already past", () => {
    const now = Date.parse("2026-04-01T10:01:00.000Z");
    assert.equal(
      retryAfterSeconds(withHeader("Wed, 01 Apr 2026 10:00:00 GMT"), now),
      0,
    );
  });

  it("returns undefined rather than guessing", () => {
    assert.equal(retryAfterSeconds(withHeader()), undefined);
    assert.equal(retryAfterSeconds(withHeader("soon")), undefined);
  });
});

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    userId: "test",
    password: "test",
    debug: false,
    command: "portfolio",
    query: undefined,
    dateFrom: undefined,
    dateTo: undefined,
    orderType: "equity",
    orderDays: 0,
    output: "json",
    outPath: undefined,
    positionsUrl: "https://example.test/positions",
    marketSearchUrl: "https://example.test/search",
    assetDetailsUrl: "https://example.test/details",
    marketIndicesUrl: "https://example.test/indices",
    taxCarryForwardUrl: "https://example.test/tax-carry-forward/search",
    taxCarryForwardMinusUrl: "https://example.test/tax-carry-forward/minus",
    orderMonitorUrl: "https://example.test/transactions",
    orderMonitorFiltersUrl: "https://example.test/monitor-filters",
    snapshotUrl: "https://example.test/snapshot",
    instrumentSnapshotUrl: "https://example.test/instrument-snapshot",
    chartDataUrl: "https://example.test/chart",
    linkedIndicesUrl: "https://example.test/linked-indices",
    economicEventsUrl: "https://example.test/events",
    similarInstrumentsUrl: "https://example.test/similar",
    newsUrl: "https://example.test/news",
    instrumentListUrl: "https://example.test/instrument-list",
    syntheticCookies: true,
    ...overrides,
  };
}

const weightSummary: PositionsSummary = {
  positions: {
    show: [
      { instrId: "AAA", description: "Alpha", marketValue: 250 },
      { instrId: "BBB", description: "Beta", marketValue: 750 },
    ],
  },
  summary: { show: { marketValue: 1000 } },
};

describe("renderOutput json", () => {
  it("stamps an ISO capturedAt", () => {
    const payload = JSON.parse(renderOutput(weightSummary, "json")) as {
      capturedAt: string;
    };

    assert.ok(!Number.isNaN(Date.parse(payload.capturedAt)));
  });

  it("adds weightPerc per row", () => {
    const payload = JSON.parse(renderOutput(weightSummary, "json")) as {
      rows: Array<{ instrId?: string; weightPerc?: number }>;
    };

    assert.equal(payload.rows[0]!.weightPerc, 25);
    assert.equal(payload.rows[1]!.weightPerc, 75);
  });

  it("leaves weightPerc undefined when the total is missing or zero", () => {
    const noTotal: PositionsSummary = {
      positions: { show: [{ instrId: "AAA", marketValue: 250 }] },
      summary: { show: { marketValue: 0 } },
    };
    const payload = JSON.parse(renderOutput(noTotal, "json")) as {
      rows: Array<{ weightPerc?: number }>;
    };

    assert.equal(payload.rows[0]!.weightPerc, undefined);
  });

  it("agrees with the shareable renderer for the same position", () => {
    // Matched by instrId, never by row index: shareableRows sorts by market value
    // descending while the json branch keeps the original order.
    const payload = JSON.parse(renderOutput(weightSummary, "json")) as {
      rows: Array<{ instrId?: string; weightPerc?: number }>;
    };
    const csv = renderOutput(weightSummary, "shareable-csv");

    const headers = csv.split("\n")[0]!.split(",");
    const weightColumn = headers.findIndex((header) =>
      header.toLowerCase().includes("weight"),
    );
    assert.ok(weightColumn >= 0, "shareable csv should carry a weight column");

    const alphaRow = csv
      .split("\n")
      .slice(1)
      .find((line) => line.includes("Alpha"))!;
    const alphaJson = payload.rows.find((row) => row.instrId === "AAA")!;

    // Full numeric compare, not an integer prefix: "25" also prefixes "25.9" and
    // "250", so a prefix match accepts a differently-computed weight.
    assert.equal(
      Number(alphaRow.split(",")[weightColumn]),
      alphaJson.weightPerc,
    );
  });

  it("does not leak weightPerc into a later csv render of the same summary", () => {
    // positionsAsRows returns summary.positions.show by reference, and toCsv builds
    // its header row from Object.keys — an in-place assign would add a column here.
    const before = renderOutput(weightSummary, "csv").split("\n")[0];
    renderOutput(weightSummary, "json");
    const after = renderOutput(weightSummary, "csv").split("\n")[0];

    assert.equal(after, before);
    assert.ok(!after!.includes("weightPerc"));
  });
});

describe("account and dossier index headers", () => {
  const okJson = () =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("sends the resolved index on the positions path", async () => {
    const originalFetch = globalThis.fetch;
    let seen: Headers | undefined;

    globalThis.fetch = async (_input, init) => {
      seen = new Headers(init?.headers);
      return okJson();
    };

    try {
      await fetchPositionsSummary(
        testConfig({ accountIndex: "2", dossierIndex: "3" }),
        "session=test",
        () => {},
      );

      assert.equal(seen?.get("x-account-index"), "2");
      assert.equal(seen?.get("x-dossier-index"), "3");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sends the resolved index on the shared JSON path used by movements", async () => {
    const originalFetch = globalThis.fetch;
    let seen: Headers | undefined;

    globalThis.fetch = async (_input, init) => {
      seen = new Headers(init?.headers);
      return new Response(JSON.stringify({ movimenti: [], lastPage: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      await fetchMovements(
        testConfig({
          dateFrom: "2026-01-01",
          dateTo: "2026-01-31",
          accountIndex: "4",
          dossierIndex: "5",
        }),
        "session=test",
        () => {},
      );

      assert.equal(seen?.get("x-account-index"), "4");
      assert.equal(seen?.get("x-dossier-index"), "5");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to 0 when the config carries no index", async () => {
    const originalFetch = globalThis.fetch;
    let seen: Headers | undefined;

    globalThis.fetch = async (_input, init) => {
      seen = new Headers(init?.headers);
      return okJson();
    };

    try {
      await fetchPositionsSummary(testConfig(), "session=test", () => {});
      assert.equal(seen?.get("x-account-index"), "0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("fetchMovements", () => {
  const range = { dateFrom: "2026-01-01", dateTo: "2026-01-31" };

  it("reports truncation when any page is limited", async () => {
    const originalFetch = globalThis.fetch;
    let call = 0;

    globalThis.fetch = async () => {
      call += 1;
      const body =
        call === 1
          ? {
              movimenti: Array.from({ length: 250 }, () => ({
                dataOperazione: "2026-01-02",
                importo: 1,
              })),
              lastPage: false,
              limitedResult: true,
            }
          : { movimenti: [], lastPage: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      assert.equal(result.ok, true);
      assert.equal(result.ok && result.data.limitedResult, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // `lastPage` is optional in the response, and a short page does not prove the
  // range is over. Advancing by the full limit past a short page would start the
  // next request past every row the server did not send.
  it("resumes from the rows it received when a short page omits lastPage", async () => {
    const originalFetch = globalThis.fetch;
    const offsets: number[] = [];

    globalThis.fetch = async (_input, init) => {
      const offset = Number(JSON.parse(String(init?.body)).offset);
      offsets.push(offset);
      const body =
        offset === 0
          ? {
              movimenti: [
                { dataOperazione: "2026-01-02", importo: 1 },
                { dataOperazione: "2026-01-03", importo: 2 },
              ],
            }
          : offset === 2
            ? { movimenti: [{ dataOperazione: "2026-01-04", importo: 3 }] }
            : { movimenti: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      // Second request starts at 2, not at 250: the third row would be lost.
      assert.deepEqual(offsets, [0, 2, 3]);
      assert.equal(result.ok && result.data.count, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops on a short page that is followed by an empty one", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = async () => {
      calls += 1;
      const body =
        calls === 1
          ? { movimenti: [{ dataOperazione: "2026-01-02", importo: 1 }] }
          : { movimenti: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      assert.equal(calls, 2);
      assert.equal(result.ok && result.data.count, 1);
      assert.equal(result.ok && result.data.limitedResult, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports no truncation for a complete range", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response(JSON.stringify({ movimenti: [], lastPage: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      assert.equal(result.ok && result.data.limitedResult, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("explains the SCA window on HTTP 451 instead of passing the raw body through", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response("Sca di sessione non valida", { status: 451 });

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.error.includes("90 days"));
      assert.ok(
        !result.ok && result.error.includes("Sca di sessione non valida"),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("carries retryAfterSeconds out of a 429", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "30" },
      });

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      assert.equal(!result.ok && result.retryAfterSeconds, 30);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // The row cap alone would allow 200_000 requests against the bank if every page
  // held one row, which is exactly the shape `offset += batch.length` permits.
  it("stops on the page cap when every page holds a single row", async () => {
    const originalFetch = globalThis.fetch;
    let pages = 0;

    globalThis.fetch = async () => {
      pages += 1;
      return new Response(
        JSON.stringify({
          movimenti: [{ dataOperazione: "2026-01-02", importo: 1 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      assert.equal(pages, 1_000);
      assert.equal(result.ok && result.data.limitedResult, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports truncation when the pagination backstop stops the loop", async () => {
    // Stopping at offset > 200_000 truncates the range exactly as the API's own cap
    // does, and the caller has no other way to find out.
    const originalFetch = globalThis.fetch;
    let pages = 0;

    globalThis.fetch = async () => {
      pages += 1;
      return new Response(
        JSON.stringify({
          movimenti: Array.from({ length: 250 }, () => ({
            dataOperazione: "2026-01-02",
            importo: 1,
          })),
          lastPage: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const result = await fetchMovements(
        testConfig(range),
        "session=test",
        () => {},
      );

      assert.equal(result.ok, true);
      assert.equal(result.ok && result.data.limitedResult, true);
      // The loop must actually stop rather than run forever.
      assert.ok(
        pages > 800 && pages < 810,
        `stopped after ${String(pages)} pages`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("logout", () => {
  it("keeps the hardcoded index — it is session teardown, not a data path", async () => {
    const originalFetch = globalThis.fetch;
    let seen: Headers | undefined;

    globalThis.fetch = async (_input, init) => {
      seen = new Headers(init?.headers);
      return new Response("", { status: 200 });
    };

    try {
      await logout("session=test", () => {});
      assert.equal(seen?.get("x-account-index"), "0");
      assert.equal(seen?.get("x-dossier-index"), "0");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("fetchZeroCommissionEtfs", () => {
  it("carries retryAfterSeconds out of a 429 like every other fetcher", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "60" },
      });

    try {
      const result = await fetchZeroCommissionEtfs({});
      assert.equal(!result.ok && result.retryAfterSeconds, 60);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("envIndex", () => {
  it("uses the configured value", () => {
    assert.equal(envIndex("3", "0"), "3");
  });

  it("falls back when the variable is unset, empty, or blank", () => {
    assert.equal(envIndex(undefined, "0"), "0");
    assert.equal(envIndex("", "0"), "0");
    assert.equal(envIndex("   ", "0"), "0");
  });

  // The MCP path validates the same field as a non-negative integer. Without
  // this, `FINECO_ACCOUNT_INDEX=abc` reaches the bank verbatim in the header.
  it("rejects a value that is not a non-negative integer", () => {
    for (const bad of ["abc", "-1", "1.5", "0x1", "1 2"]) {
      assert.throws(() => envIndex(bad, "0"), /non-negative integer/);
    }
  });
});

// parseArgs returns a union whose `help` arm carries no command or dates; the
// tests below are about the other arms.
function runArgs(argv: string[]) {
  const args = parseArgs(argv);
  if (args.kind === "help") throw new Error("Unexpected help output.");
  return args;
}

describe("parseArgs movements", () => {
  it("parses the command and its date range", () => {
    const args = runArgs([
      "movements",
      "2026-01-01",
      "2026-01-31",
      "--op-item",
      "Fineco",
    ]);

    assert.equal(args.kind, "onePassword");
    assert.equal(args.command, "movements");
    assert.equal(args.dateFrom, "2026-01-01");
    assert.equal(args.dateTo, "2026-01-31");
  });

  it("takes USER PASSWORD after the range, as the usage text documents", () => {
    const args = runArgs([
      "movements",
      "2026-02-01",
      "2026-02-28",
      "user",
      "pass",
    ]);

    assert.equal(args.kind, "credentials");
    assert.equal(args.command, "movements");
    assert.equal(args.dateFrom, "2026-02-01");
    assert.equal(args.dateTo, "2026-02-28");
  });

  it("rejects a missing, malformed, or inverted range", () => {
    assert.throws(
      () => parseArgs(["movements", "--op-item", "Fineco"]),
      /Expected DATE_FROM and DATE_TO/,
    );
    assert.throws(
      () =>
        parseArgs([
          "movements",
          "01-01-2026",
          "2026-01-31",
          "--op-item",
          "Fineco",
        ]),
      /YYYY-MM-DD/,
    );
    assert.throws(
      () =>
        parseArgs([
          "movements",
          "2026-01-31",
          "2026-01-01",
          "--op-item",
          "Fineco",
        ]),
      /must be on or before/,
    );
  });

  it("rejects --format, which only portfolio supports", () => {
    assert.throws(
      () =>
        parseArgs([
          "movements",
          "2026-01-01",
          "2026-01-31",
          "--format",
          "csv",
          "--op-item",
          "Fineco",
        ]),
      /only supported by portfolio/,
    );
  });
});
