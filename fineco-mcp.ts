import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

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
  credentialsFrom1Password,
  fetchAssetDetails,
  fetchMarketIndices,
  fetchPositionsSummary,
  fetchZeroCommissionEtfs,
  login,
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

async function buildConfig(overrides?: {
  outPath?: string;
  query?: string | undefined;
}): Promise<Config> {
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
    output: "json",
    outPath: overrides?.outPath ?? undefined,
    positionsUrl: process.env.FINECO_POSITIONS_URL ?? POSITIONS_SUMMARY_URL,
    marketSearchUrl: process.env.FINECO_MARKET_SEARCH_URL ?? MARKET_SEARCH_URL,
    assetDetailsUrl: process.env.FINECO_ASSET_DETAILS_URL ?? ASSET_DETAILS_URL,
    marketIndicesUrl:
      process.env.FINECO_MARKET_INDICES_URL ?? MARKET_INDICES_URL,
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

function authExpiredContent(error: string) {
  return errorContent(
    "Fineco authentication expired. I cleared the in-memory session. Retry the same tool call to log in again and fetch fresh data.",
    { authExpired: true, error },
  );
}

async function runJsonTool(
  query: string | undefined,
  fetcher: (
    config: Config,
    cookie: string,
    debug: (message: string) => void,
  ) => Promise<ApiResult<unknown>>,
) {
  const config = await buildConfig({ query });
  const debug = makeLogger(config);
  try {
    const cookie = await getSessionCookie(config, debug);
    const result = await fetcher(config, cookie, debug);

    if (!result.ok && result.authExpired) {
      await clearSession(debug);
      return authExpiredContent(result.error);
    }

    if (!result.ok) {
      return errorContent(result.error);
    }

    return jsonContent(result.data);
  } catch (error) {
    return errorContent((error as Error).message);
  }
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
    },
    async ({ format }) => {
      const config = await buildConfig();
      const debug = makeLogger(config);
      try {
        const cookie = await getSessionCookie(config, debug);
        const result = await fetchPositionsSummary(config, cookie, debug);

        if (!result.ok && result.authExpired) {
          await clearSession(debug);
          return authExpiredContent(result.error);
        }

        if (!result.ok) {
          return errorContent(result.error);
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
    },
    async ({ output_path, shareable }) => {
      const reportPath = output_path ?? "portfolio-report.html";
      const config = await buildConfig({ outPath: reportPath });
      const debug = makeLogger(config);
      try {
        const cookie = await getSessionCookie(config, debug);
        const result = await fetchPositionsSummary(config, cookie, debug);

        if (!result.ok && result.authExpired) {
          await clearSession(debug);
          return authExpiredContent(result.error);
        }

        if (!result.ok) {
          return errorContent(result.error);
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
              text: `HTML report saved to ${reportPath} (${rows.length} positions, ${shareable ? "shareable" : "full"}).`,
            },
          ],
        };
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
    async ({ query }) => runJsonTool(query, searchAssets),
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
    async ({ instrument }) => runJsonTool(instrument, fetchAssetDetails),
  );

  server.tool(
    "get_market_indices",
    "Fetch Fineco indices bar data. Returns Fineco JSON only.",
    {},
    async () => runJsonTool(undefined, fetchMarketIndices),
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
        if (!result.ok) return errorContent(result.error);
        return jsonContent(result.data);
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
