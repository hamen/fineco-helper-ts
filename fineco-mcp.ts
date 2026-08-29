import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

import { fetchEnrichmentReport } from "./enrichment.js";
import {
  ASSET_DETAILS_URL,
  MARKET_INDICES_URL,
  MARKET_SEARCH_URL,
  POSITIONS_SUMMARY_URL,
  SNAPSHOT_URL,
  INSTRUMENT_SNAPSHOT_URL,
  CHART_DATA_URL,
  LINKED_INDICES_URL,
  ECONOMIC_EVENTS_URL,
  SIMILAR_INSTRUMENTS_URL,
  NEWS_URL,
  INSTRUMENT_LIST_URL,
  TAX_CARRY_FORWARD_URL,
  TAX_CARRY_FORWARD_MINUS_URL,
  ORDER_MONITOR_URL,
  ORDER_MONITOR_FILTERS_URL,
  credentialsFrom1Password,
  fetchAssetDetails,
  fetchMarketIndices,
  fetchOrderMonitor,
  fetchOrderMonitorFilters,
  fetchPositionsSummary,
  fetchTaxCarryForward,
  fetchTaxMinusByYear,
  fetchZeroCommissionEtfs,
  DEFAULT_ACCOUNT_INDEX,
  DEFAULT_DOSSIER_INDEX,
  dividendsFromMovements,
  fetchMovements,
  isIsoDate,
  login,
  parseDateRange,
  logout,
  makeLogger,
  positionsAsRows,
  renderOutput,
  type ApiResult,
  searchAssets,
  type Config,
} from "./fineco-portfolio.js";

const SESSION_MAX_AGE_MS = 10 * 60_000;
const SESSION_MAX_IDLE_MS = 5 * 60_000;

type ConfigOverrides = {
  outPath?: string;
  query?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  orderType?: string | undefined;
  orderDays?: number | undefined;
  accountIndex?: number | undefined;
  dossierIndex?: number | undefined;
};

// Per-call value, then the environment, then "0". Resolved here — and in the CLI's
// own buildConfig — so no header site has to know about process.env.
function resolveIndex(
  override: number | undefined,
  envValue: string | undefined,
  fallback: string,
): string {
  if (override !== undefined) return String(override);
  return envValue ?? fallback;
}

async function buildConfig(overrides?: ConfigOverrides): Promise<Config> {
  let userId = process.env.FINECO_USER_ID;
  let password = process.env.FINECO_PASSWORD;

  if ((!userId || !password) && process.env.FINECO_OP_ITEM) {
    ({ userId, password } = await credentialsFrom1Password(
      process.env.FINECO_OP_ITEM,
    ));
  }

  if (!userId || !password) {
    throw new Error(
      "Credentials missing. Set FINECO_USER_ID/FINECO_PASSWORD or FINECO_OP_ITEM.",
    );
  }

  return {
    userId,
    password,
    debug: process.env.FINECO_DEBUG === "1",
    command: "portfolio",
    query: overrides?.query,
    dateFrom: overrides?.dateFrom,
    dateTo: overrides?.dateTo,
    orderType: overrides?.orderType ?? "equity",
    orderDays: overrides?.orderDays ?? 0,
    output: "json",
    outPath: overrides?.outPath ?? undefined,
    positionsUrl: process.env.FINECO_POSITIONS_URL ?? POSITIONS_SUMMARY_URL,
    marketSearchUrl: process.env.FINECO_MARKET_SEARCH_URL ?? MARKET_SEARCH_URL,
    assetDetailsUrl: process.env.FINECO_ASSET_DETAILS_URL ?? ASSET_DETAILS_URL,
    marketIndicesUrl:
      process.env.FINECO_MARKET_INDICES_URL ?? MARKET_INDICES_URL,
    taxCarryForwardUrl:
      process.env.FINECO_TAX_CARRY_FORWARD_URL ?? TAX_CARRY_FORWARD_URL,
    taxCarryForwardMinusUrl:
      process.env.FINECO_TAX_CARRY_FORWARD_MINUS_URL ??
      TAX_CARRY_FORWARD_MINUS_URL,
    orderMonitorUrl: process.env.FINECO_ORDER_MONITOR_URL ?? ORDER_MONITOR_URL,
    orderMonitorFiltersUrl:
      process.env.FINECO_ORDER_MONITOR_FILTERS_URL ?? ORDER_MONITOR_FILTERS_URL,
    snapshotUrl: process.env.FINECO_SNAPSHOT_URL ?? SNAPSHOT_URL,
    instrumentSnapshotUrl:
      process.env.FINECO_INSTRUMENT_SNAPSHOT_URL ?? INSTRUMENT_SNAPSHOT_URL,
    chartDataUrl: process.env.FINECO_CHART_DATA_URL ?? CHART_DATA_URL,
    linkedIndicesUrl:
      process.env.FINECO_LINKED_INDICES_URL ?? LINKED_INDICES_URL,
    economicEventsUrl:
      process.env.FINECO_ECONOMIC_EVENTS_URL ?? ECONOMIC_EVENTS_URL,
    similarInstrumentsUrl:
      process.env.FINECO_SIMILAR_INSTRUMENTS_URL ?? SIMILAR_INSTRUMENTS_URL,
    newsUrl: process.env.FINECO_NEWS_URL ?? NEWS_URL,
    instrumentListUrl:
      process.env.FINECO_INSTRUMENT_LIST_URL ?? INSTRUMENT_LIST_URL,
    accountIndex: resolveIndex(
      overrides?.accountIndex,
      process.env.FINECO_ACCOUNT_INDEX,
      DEFAULT_ACCOUNT_INDEX,
    ),
    dossierIndex: resolveIndex(
      overrides?.dossierIndex,
      process.env.FINECO_DOSSIER_INDEX,
      DEFAULT_DOSSIER_INDEX,
    ),
    syntheticCookies: process.env.FINECO_SYNTHETIC_COOKIES !== "0",
  };
}

type SessionState = {
  cookie: string;
  createdAt: number;
  lastUsedAt: number;
  loginInFlight?: Promise<string>;
};

let session: SessionState | undefined;

function sessionExpired(now = Date.now()): boolean {
  if (!session) return true;
  return (
    now - session.createdAt > SESSION_MAX_AGE_MS ||
    now - session.lastUsedAt > SESSION_MAX_IDLE_MS
  );
}

async function clearSession(
  debug: (message: string) => void,
): Promise<boolean> {
  const existing = session;
  session = undefined;
  if (!existing?.cookie) return false;
  await logout(existing.cookie, debug);
  return true;
}

async function getSessionCookie(
  config: Config,
  debug: (message: string) => void,
): Promise<string> {
  if (session && sessionExpired()) {
    await clearSession(debug);
  }

  if (session?.cookie) {
    session.lastUsedAt = Date.now();
    return session.cookie;
  }

  if (!session) {
    session = {
      cookie: "",
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
  }

  if (!session.loginInFlight) {
    session.loginInFlight = login(config, debug);
  }

  const loginPromise = session.loginInFlight;
  let cookie: string;
  try {
    cookie = await loginPromise;
  } catch (error) {
    if (session?.loginInFlight === loginPromise) {
      session = undefined;
    }
    throw error;
  }

  const now = Date.now();
  session = {
    cookie,
    createdAt: now,
    lastUsedAt: now,
  };
  return cookie;
}

function sessionStatus() {
  const now = Date.now();
  return {
    authenticated: Boolean(session?.cookie) && !sessionExpired(now),
    loginInFlight: Boolean(session?.loginInFlight),
    ageMs: session?.cookie ? now - session.createdAt : undefined,
    idleMs: session?.cookie ? now - session.lastUsedAt : undefined,
    maxAgeMs: SESSION_MAX_AGE_MS,
    maxIdleMs: SESSION_MAX_IDLE_MS,
  };
}

function jsonContent(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorContent(message: string, data?: unknown) {
  const suffix = data === undefined ? "" : `\n${JSON.stringify(data, null, 2)}`;
  return {
    content: [{ type: "text" as const, text: `Error: ${message}${suffix}` }],
    isError: true,
  };
}

// The non-auth arm of every failure path. Carries the status through, plus the
// 429 wait hint — errorContent already serialises a data payload, but every call
// site was throwing that away.
function apiErrorContent(result: {
  error: string;
  status?: number;
  retryAfterSeconds?: number;
}) {
  const data: Record<string, unknown> = {};
  if (result.status !== undefined) data["status"] = result.status;
  if (result.retryAfterSeconds !== undefined) {
    data["retryAfterSeconds"] = result.retryAfterSeconds;
  }
  return Object.keys(data).length === 0
    ? errorContent(result.error)
    : errorContent(result.error, data);
}

function authExpiredContent(error: string) {
  return errorContent(
    "Fineco authentication expired. I cleared the in-memory session. Retry the same tool call to log in again and fetch fresh data.",
    { authExpired: true, error },
  );
}

async function runJsonTool(
  overrides: ConfigOverrides | undefined,
  fetcher: (
    config: Config,
    cookie: string,
    debug: (message: string) => void,
  ) => Promise<ApiResult<unknown>>,
) {
  const config = await buildConfig(overrides);
  const debug = makeLogger(config);
  try {
    const cookie = await getSessionCookie(config, debug);
    const result = await fetcher(config, cookie, debug);

    if (!result.ok && result.authExpired) {
      await clearSession(debug);
      return authExpiredContent(result.error);
    }

    if (!result.ok) {
      return apiErrorContent(result);
    }

    return jsonContent(result.data);
  } catch (error) {
    return errorContent((error as Error).message);
  }
}

async function runTaxCarryForwardTool(dateFrom: string, dateTo: string) {
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    return errorContent("Dates must use YYYY-MM-DD format.");
  }
  if (dateFrom > dateTo) {
    return errorContent("date_from must be on or before date_to.");
  }

  return runJsonTool({ dateFrom, dateTo }, fetchTaxCarryForward);
}

export function createFinecoMcpServer(): McpServer {
  const server = new McpServer({
    name: "fineco-helper",
    version: "0.1.0",
  });

  server.tool(
    "get_portfolio",
    "Fetch current Fineco portfolio positions and summary. Supports full formats (json, csv, raw, html) and shareable formats without sensitive data (shareable-csv, shareable-html).",
    {
      format: z
        .enum(["json", "csv", "raw", "html", "shareable-csv", "shareable-html"])
        .optional()
        .describe(
          "Output format (default: json). Shareable formats omit quantities, prices, and absolute values — they only include weights and P/L percentages.",
        ),
      account_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco account index (default: 0, or FINECO_ACCOUNT_INDEX).",
        ),
      dossier_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco dossier index (default: 0, or FINECO_DOSSIER_INDEX).",
        ),
    },
    async ({ format, account_index, dossier_index }) => {
      const config = await buildConfig({
        accountIndex: account_index,
        dossierIndex: dossier_index,
      });
      const debug = makeLogger(config);
      try {
        const cookie = await getSessionCookie(config, debug);
        const result = await fetchPositionsSummary(config, cookie, debug);

        if (!result.ok && result.authExpired) {
          await clearSession(debug);
          return authExpiredContent(result.error);
        }

        if (!result.ok) {
          return apiErrorContent(result);
        }

        const output = renderOutput(result.data, format ?? "json");
        return { content: [{ type: "text" as const, text: output }] };
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.tool(
    "generate_report",
    "Generate a styled HTML portfolio report from current Fineco data and save it to a file. Supports full and shareable (no sensitive data) formats.",
    {
      output_path: z
        .string()
        .optional()
        .describe(
          "File path for the HTML report (default: portfolio-report.html)",
        ),
      shareable: z
        .boolean()
        .optional()
        .describe(
          "Generate shareable report without quantities, prices, or absolute values (default: false)",
        ),
      account_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco account index (default: 0, or FINECO_ACCOUNT_INDEX).",
        ),
      dossier_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco dossier index (default: 0, or FINECO_DOSSIER_INDEX).",
        ),
    },
    async ({ output_path, shareable, account_index, dossier_index }) => {
      const reportPath = output_path ?? "portfolio-report.html";
      const config = await buildConfig({
        outPath: reportPath,
        accountIndex: account_index,
        dossierIndex: dossier_index,
      });
      const debug = makeLogger(config);
      try {
        const cookie = await getSessionCookie(config, debug);
        const result = await fetchPositionsSummary(config, cookie, debug);

        if (!result.ok && result.authExpired) {
          await clearSession(debug);
          return authExpiredContent(result.error);
        }

        if (!result.ok) {
          return apiErrorContent(result);
        }

        const html = renderOutput(
          result.data,
          shareable ? "shareable-html" : "html",
        );
        await writeFile(reportPath, html);
        const rows = positionsAsRows(result.data);

        return {
          content: [
            {
              type: "text" as const,
              text: `HTML report saved to ${reportPath} (${
                rows.length
              } positions, ${shareable ? "shareable" : "full"}).`,
            },
          ],
        };
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.tool(
    "get_movements",
    "Fetch Fineco current-account and card movements for an explicit date range. Returns private transaction data. The current-account cash balance is the `balanceAccountAtSearchDate` field. Fineco enforces PSD2 SCA on this endpoint: a password-only session reads roughly the last 90 days, and older ranges fail with HTTP 451.",
    {
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Start date in YYYY-MM-DD format."),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End date in YYYY-MM-DD format."),
      account_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco account index (default: 0, or FINECO_ACCOUNT_INDEX).",
        ),
      dossier_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco dossier index (default: 0, or FINECO_DOSSIER_INDEX).",
        ),
    },
    async ({ date_from, date_to, account_index, dossier_index }) => {
      const range = parseDateRange(date_from, date_to);
      if (!range.ok) return errorContent(range.error);

      return runJsonTool(
        {
          dateFrom: range.dateFrom,
          dateTo: range.dateTo,
          accountIndex: account_index,
          dossierIndex: dossier_index,
        },
        fetchMovements,
      );
    },
  );

  server.tool(
    "get_dividends",
    "Summarise dividends and their withholding tax from Fineco current-account movements, over an explicit date range. Amounts are integer minor units (cents); `assumedCurrency` is EUR because movements carry no currency field. Movements name no ISIN or symbol, so `security` is a parsed label, not an instrument id. Fineco enforces PSD2 SCA here: a password-only session reads roughly the last 90 days, so this cannot produce a full-year figure.",
    {
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Start date in YYYY-MM-DD format."),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End date in YYYY-MM-DD format."),
      account_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco account index (default: 0, or FINECO_ACCOUNT_INDEX).",
        ),
      dossier_index: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
          "Fineco dossier index (default: 0, or FINECO_DOSSIER_INDEX).",
        ),
    },
    async ({ date_from, date_to, account_index, dossier_index }) => {
      const range = parseDateRange(date_from, date_to);
      if (!range.ok) return errorContent(range.error);

      const config = await buildConfig({
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        accountIndex: account_index,
        dossierIndex: dossier_index,
      });
      const debug = makeLogger(config);

      try {
        const cookie = await getSessionCookie(config, debug);
        const result = await fetchMovements(config, cookie, debug);

        // Both arms, spelled out: this tool transforms the result, so it cannot
        // reuse runJsonTool, and a single-arm copy would drop either the session
        // clear or the 429 hint.
        if (!result.ok && result.authExpired) {
          await clearSession(debug);
          return authExpiredContent(result.error);
        }

        if (!result.ok) {
          return apiErrorContent(result);
        }

        return jsonContent(
          dividendsFromMovements(result.data.movimenti, {
            dateFrom: range.dateFrom,
            dateTo: range.dateTo,
            capturedAt: new Date().toISOString(),
            truncated: result.data.limitedResult,
          }),
        );
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.tool(
    "fineco_session_status",
    "Report whether this MCP server currently has an in-memory Fineco session. Never returns cookie values.",
    {},
    async () => jsonContent(sessionStatus()),
  );

  server.tool(
    "fineco_logout",
    "Log out of the current in-memory Fineco session and clear it. Safe to call when no session exists.",
    {},
    async () => {
      const hadSession = await clearSession(() => {});
      return {
        content: [
          {
            type: "text" as const,
            text: hadSession
              ? "Fineco session logged out and cleared."
              : "No Fineco session was active.",
          },
        ],
      };
    },
  );

  server.tool(
    "search_asset",
    "Search Fineco markets for an asset by text. Returns Fineco JSON only.",
    {
      query: z
        .string()
        .min(1)
        .describe("Search text, such as fineco or cloudflare."),
    },
    async ({ query }) => runJsonTool({ query }, searchAssets),
  );

  server.tool(
    "get_asset_details",
    "Fetch bundled read-only Fineco JSON details for a single instrument key, including static data, snapshots, chart data, linked indices, events, similar instruments, news, and related instruments.",
    {
      instrument: z
        .string()
        .min(1)
        .describe(
          "Instrument key in INSTRUMENT.VENUE form, such as IT0000072170.AFF.",
        ),
    },
    async ({ instrument }) =>
      runJsonTool({ query: instrument }, fetchAssetDetails),
  );

  server.tool(
    "get_market_indices",
    "Fetch Fineco indices bar data. Returns Fineco JSON only.",
    {},
    async () => runJsonTool(undefined, fetchMarketIndices),
  );

  server.tool(
    "get_tax_carry_forward",
    "Fetch Fineco tax carry-forward data for an explicit date range. Returns Fineco JSON only and may include private tax/accounting data.",
    {
      date_from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Start date in YYYY-MM-DD format."),
      date_to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("End date in YYYY-MM-DD format."),
    },
    async ({ date_from, date_to }) =>
      runTaxCarryForwardTool(date_from, date_to),
  );

  server.tool(
    "get_tax_minus_by_year",
    "Fetch Fineco tax carry-forward minus residue grouped by tax year. Returns Fineco JSON only and may include private tax/accounting data.",
    {},
    async () => runJsonTool(undefined, fetchTaxMinusByYear),
  );

  server.tool(
    "get_order_monitor",
    "Fetch Fineco order monitor transactions for an instrument type and day window. Returns Fineco JSON only and may include private order/trading data.",
    {
      type: z
        .string()
        .min(1)
        .optional()
        .describe("Instrument type. Default: equity."),
      days: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("Number of days to include. Default: 0."),
    },
    async ({ type, days }) => {
      const orderDays = days ?? 0;
      return runJsonTool(
        { orderType: type ?? "equity", orderDays },
        fetchOrderMonitor,
      );
    },
  );

  server.tool(
    "get_order_monitor_filters",
    "Fetch available Fineco order monitor status filters for an instrument type. Returns Fineco JSON only.",
    {
      type: z
        .string()
        .min(1)
        .optional()
        .describe("Instrument type. Default: equity."),
    },
    async ({ type }) =>
      runJsonTool({ orderType: type ?? "equity" }, fetchOrderMonitorFilters),
  );

  server.tool(
    "get_zero_commission_etfs",
    "Fetch Fineco's public zero-commission ETF list. Does not require a Fineco login. Optional query filters by ISIN, venue, issuer, or description.",
    {
      query: z
        .string()
        .optional()
        .describe(
          "Optional filter text, such as EXUS, IE0006WW1TQ4, or issuer.",
        ),
    },
    async ({ query }) => {
      try {
        const result = await fetchZeroCommissionEtfs(
          query === undefined ? {} : { query },
        );
        if (!result.ok) return apiErrorContent(result);
        return jsonContent(result.data);
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  server.tool(
    "get_enrichment",
    "Fetch a structured public stock-analysis enrichment report from an approved source URL. Optionally compare it with a Fineco title and return a match score. Returns JSON only.",
    {
      url: z.string().url().describe("Public source URL for the stock page."),
      fineco_title: z
        .string()
        .optional()
        .describe(
          "Optional Fineco instrument title to compare with the report.",
        ),
    },
    async ({ url, fineco_title }) => {
      try {
        const report = await fetchEnrichmentReport({
          url,
          ...(fineco_title === undefined ? {} : { finecoTitle: fineco_title }),
        });
        const data = Object.fromEntries(
          Object.entries(report).filter(([key]) => key !== "markdown"),
        );
        return jsonContent(data);
      } catch (error) {
        return errorContent((error as Error).message);
      }
    },
  );

  return server;
}

export async function shutdownFinecoMcpSession(): Promise<boolean> {
  return clearSession(() => {});
}

export function installFinecoMcpShutdownHandlers(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdownFinecoMcpSession().finally(() => process.exit(0));
    });
  }
}
