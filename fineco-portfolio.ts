import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { fetchEnrichmentReport } from "./enrichment.js";

const execFileAsync = promisify(execFile);

const LOGIN_URL =
  "https://public-api.finecobank.com/v1/public/authentications/web/login?sca=true";
const HOME_URL = "https://it.finecobank.com/";
const LOGOUT_URL =
  "https://private-api.finecobank.com/v1/private/authentications/logout";
const PORTFOLIO_URL =
  "https://finecobank.com/pvt/portfolio/trading-summary/home";
export const POSITIONS_SUMMARY_URL =
  "https://private-api.finecobank.com/v1/private/tol/positions/summary?type=sintesi";
export const MARKET_SEARCH_URL =
  "https://private-api.finecobank.com/v1/private/tol/stocklists/search/global";
export const ASSET_DETAILS_URL =
  "https://private-api.finecobank.com/v1/private/tol/instruments/static/search";
export const MARKET_INDICES_URL =
  "https://private-api.finecobank.com/v1/private/tol/indicesbar/indices";
export const SNAPSHOT_URL =
  "https://private-api.finecobank.com/v1/private/snapshot";
export const INSTRUMENT_SNAPSHOT_URL =
  "https://private-api.finecobank.com/v1/private/tol/instruments/snapshot";
export const CHART_DATA_URL =
  "https://private-api.finecobank.com/v1/private/tol/chart/data";
export const LINKED_INDICES_URL =
  "https://private-api.finecobank.com/v1/private/tol/indices/byid";
export const ECONOMIC_EVENTS_URL =
  "https://private-api.finecobank.com/v1/private/tol/economicagenda/upcoming-events";
export const SIMILAR_INSTRUMENTS_URL =
  "https://private-api.finecobank.com/v1/private/tol/instrumenttool/similar";
export const NEWS_URL =
  "https://private-api.finecobank.com/v2/private/fns/search/news";
export const INSTRUMENT_LIST_URL =
  "https://private-api.finecobank.com/v1/private/tol/instruments/list/search";
export const ZERO_COMMISSION_ETFS_URL =
  "https://images.finecobank.com/common-pvt/js/json/etf-zero/etf_piu_scambiati.json";
export const TAX_CARRY_FORWARD_URL =
  "https://private-api.finecobank.com/v1/private/tax-carry-forward/search";
export const TAX_CARRY_FORWARD_MINUS_URL =
  "https://private-api.finecobank.com/v1/private/tax-carry-forward/minus";
export const ORDER_MONITOR_URL =
  "https://private-api.finecobank.com/v1/private/tol/transactions";
export const ORDER_MONITOR_FILTERS_URL =
  "https://private-api.finecobank.com/v1/private/tol/monitor-filters";
export const MOVEMENTS_URL =
  "https://private-api.finecobank.com/v2/private/accounts-and-cards/movements";

export const DEFAULT_ACCOUNT_INDEX = "0";
export const DEFAULT_DOSSIER_INDEX = "0";

// Fineco enforces PSD2 Strong Customer Authentication on the movements endpoint: a
// password-only session reads roughly the last 90 days and answers 451 beyond that.
export const SCA_WINDOW_MESSAGE =
  "Fineco refused this movements range (HTTP 451, Strong Customer Authentication). " +
  "A password-only session reads roughly the last 90 days; an older range needs an " +
  "interactive SCA step-up, which this tool cannot perform.";

// Both legal Retry-After forms: delay-seconds, and an HTTP date. Anything else is
// treated as absent — a guessed wait is worse than no wait at all.
export function retryAfterSeconds(
  response: Response,
  now: number = Date.now(),
): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;

  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);

  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  // Ceil, not round: rounding a sub-second remainder down to 0 tells the caller to
  // retry at once, before the server said it may.
  return Math.max(0, Math.ceil((when - now) / 1000));
}

// An exported empty env var is not a configured index: `?? "0"` would let it
// through and send a blank header, which is a misconfiguration nobody would see.
// A non-numeric value is worse: it reaches the bank verbatim in `X-Account-Index`,
// while the MCP path validates the same field as a non-negative integer. Throwing
// keeps the two paths symmetric and makes the typo visible at startup instead of
// on the wire.
export function envIndex(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  return String(parseNonNegativeInteger(trimmed, `Index env var "${trimmed}"`));
}

function indexHeaders(config: Config): Record<string, string> {
  return {
    "X-Account-Index": config.accountIndex ?? DEFAULT_ACCOUNT_INDEX,
    "X-Dossier-Index": config.dossierIndex ?? DEFAULT_DOSSIER_INDEX,
  };
}

type CliCommand =
  | "portfolio"
  | "search-asset"
  | "asset-details"
  | "enrichment"
  | "market-indices"
  | "zero-commission-etfs"
  | "tax-carry-forward"
  | "tax-minus-by-year"
  | "order-monitor"
  | "order-monitor-filters"
  | "movements";

const assetDetailFields = [
  "instrId",
  "venueSystem",
  "description",
  "symbol",
  "underlyingInstrId",
  "underlyingVenueSystem",
  "subVenueSystem",
  "instrTyp",
  "newType",
  "ricReuters",
  "levaMargMinIntrPro",
  "levaMargMinIntr",
  "levaMargMinOver",
  "levaMargMinOverPro",
  "levaDeltaStopIntr",
  "levaDeltaStopOver",
  "multiplicativeFactor",
  "currencyCd",
  "maxLotPerPosition",
  "overnightExpiryDate",
  "valueAtRisk",
  "flagsRisk",
  "flagPriips",
  "underlyingType",
  "backofficeInstrumentType",
  "dependingInstrId",
  "dependingInstrIdUk",
  "tradingType",
  "issuer",
  "tradableStartDate",
  "opExpire",
  "cwExpire",
  "cwWhat",
  "callPut",
  "logoId",
  "bondVenues",
  "forcedMinimumTick",
  "feedSymbol",
  "cwIssuer",
  "issueDate",
  "cwUnderlyingLabel",
  "strikePrice",
  "bondFrequency",
  "bondCouponRate",
  "bondCouponTyp",
  "bondMaturityDate",
  "bondExpiryDate",
  "rating",
  "issuerRating",
  "minQty",
  "bondSubordinate",
  "bailin",
  "flagIPO",
  "bondCommissions",
  "bondIssueDate",
  "bondIssuePrice",
  "bondCoverPrice",
  "bondAccruedInterestRate",
  "bondAccrualAdjusting",
  "bondTaxes",
  "bondParValue",
  "bondAccrualTypeCalculation",
  "preferredVenue",
  "altVenueSystem",
  "altBondVenues",
  "altPreferredVenue",
  "kidIt",
  "kidEn",
  "esgTaxonomy",
  "esgSustainability",
  "esgPai",
  "topQuality",
  "categoryId",
];

const relatedInstrumentFields = [
  "instrId",
  "venueSystem",
  "description",
  "symbol",
  "titolo",
  "underlyingInstrId",
  "underlyingVenueSystem",
  "underlyingType",
  "subVenueSystem",
  "instrTyp",
  "currencyCd",
  "multiplicativeFactor",
  "logoId",
  "newType",
];

export type OutputFormat =
  | "json"
  | "raw"
  | "csv"
  | "html"
  | "shareable-html"
  | "shareable-csv";

type CliArgs =
  | {
      kind: "env";
      format: OutputFormat | undefined;
      outPath: string | undefined;
      command: CliCommand;
      query: string | undefined;
      enrichmentTitle: string | undefined;
      dateFrom: string | undefined;
      dateTo: string | undefined;
      orderType: string | undefined;
      orderDays: number | undefined;
    }
  | {
      kind: "help";
    }
  | {
      kind: "credentials";
      userId: string;
      password: string;
      format: OutputFormat | undefined;
      outPath: string | undefined;
      command: CliCommand;
      query: string | undefined;
      enrichmentTitle: string | undefined;
      dateFrom: string | undefined;
      dateTo: string | undefined;
      orderType: string | undefined;
      orderDays: number | undefined;
    }
  | {
      kind: "onePassword";
      itemName: string;
      format: OutputFormat | undefined;
      outPath: string | undefined;
      command: CliCommand;
      query: string | undefined;
      enrichmentTitle: string | undefined;
      dateFrom: string | undefined;
      dateTo: string | undefined;
      orderType: string | undefined;
      orderDays: number | undefined;
    };

export type Config = {
  userId: string;
  password: string;
  debug: boolean;
  command: CliCommand;
  query: string | undefined;
  enrichmentTitle?: string | undefined;
  dateFrom: string | undefined;
  dateTo: string | undefined;
  orderType: string;
  orderDays: number;
  output: OutputFormat;
  outPath: string | undefined;
  positionsUrl: string;
  marketSearchUrl: string;
  assetDetailsUrl: string;
  marketIndicesUrl: string;
  taxCarryForwardUrl: string;
  taxCarryForwardMinusUrl: string;
  orderMonitorUrl: string;
  orderMonitorFiltersUrl: string;
  snapshotUrl: string;
  instrumentSnapshotUrl: string;
  chartDataUrl: string;
  linkedIndicesUrl: string;
  economicEventsUrl: string;
  similarInstrumentsUrl: string;
  newsUrl: string;
  instrumentListUrl: string;
  accountIndex?: string;
  dossierIndex?: string;
  syntheticCookies: boolean;
};

type CookieFetchResult = {
  response: Response;
  cookie: string;
  url: string;
};

type OnePasswordItem = {
  fields?: Array<{
    id?: string;
    label?: string;
    purpose?: string;
    value?: string;
  }>;
};

export type ApiResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: string;
      status?: number;
      authExpired?: boolean;
      retryAfterSeconds?: number;
    };

class UsageError extends Error {}

export type Position = {
  instrId?: string;
  venueSystem?: string;
  currencyCd?: string;
  description?: string;
  type?: string;
  qty?: number;
  avgPrice?: number;
  marketPrice?: number;
  bookValue?: number;
  marketValue?: number;
  profitLoss?: number;
  profitLossPerc?: number;
  symbol?: string;
};

export type PositionsSummary = {
  positions?: {
    show?: Position[];
  };
  summary?: {
    show?: PortfolioTotals;
    total?: PortfolioTotals;
  };
  filters?: {
    currencies?: {
      show?: string[];
    };
    instrumentTypes?: {
      show?: string[];
    };
  };
};

export type PortfolioTotals = {
  currencyCd?: string;
  bookValue?: number;
  marketValue?: number;
  profitLoss?: number;
  profitLossPerc?: number;
};

export type ZeroCommissionEtf = {
  instrId?: string;
  venueSystem?: string;
  description?: string;
  issuer?: string;
};

export type ZeroCommissionEtfs = {
  capturedAt: string;
  sourceUrl: string;
  count: number;
  instruments: ZeroCommissionEtf[];
};

const browserHeaders = {
  Accept: "application/json",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Content-Type": "application/json",
  Origin: "https://it.finecobank.com",
  Pragma: "no-cache",
  Referer: "https://it.finecobank.com/",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36",
  "accept-language": "it",
  "sec-ch-ua":
    '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
  "sec-ch-ua-mobile": "?1",
  "sec-ch-ua-platform": '"Android"',
  "sec-gpc": "1",
} satisfies HeadersInit;

function usage(): string {
  return `Usage:
  npm start -- portfolio USER PASSWORD [--format json|raw|csv|html|shareable-html|shareable-csv] [--out path]
  npm start -- portfolio --op-item "Fineco" [--format json|raw|csv|html|shareable-html|shareable-csv] [--out path]
  npm start -- search-asset "query" USER PASSWORD [--out path]
  npm start -- search-asset "query" --op-item "Fineco" [--out path]
  npm start -- asset-details INSTRUMENT.VENUE --op-item "Fineco" [--out path]
  npm start -- enrichment SOURCE_URL ["Fineco title"] [--out report.md]
  npm start -- market-indices --op-item "Fineco" [--out path]
  npm start -- tax-carry-forward DATE_FROM DATE_TO USER PASSWORD [--out path]
  npm start -- tax-carry-forward DATE_FROM DATE_TO --op-item "Fineco" [--out path]
  npm start -- tax-minus-by-year USER PASSWORD [--out path]
  npm start -- tax-minus-by-year --op-item "Fineco" [--out path]
  npm start -- movements DATE_FROM DATE_TO --op-item "Fineco" [--out path]
  npm start -- order-monitor [--type equity] [--days 0] --op-item "Fineco" [--out path]
  npm start -- order-monitor-filters [--type equity] --op-item "Fineco" [--out path]
  npm start -- zero-commission-etfs [query] [--out path]

Commands:
  portfolio             Fetch positions and portfolio summary. This is the default command.
  search-asset QUERY    Search Fineco markets for an asset by text.
  asset-details KEY     Fetch static details for an instrument key, like IT0000072170.AFF.
  enrichment URL        Fetch a public stock-analysis enrichment report. Optional Fineco title adds a match score.
  market-indices        Fetch the Fineco indices bar data.
  tax-carry-forward     Fetch tax carry-forward data for an explicit YYYY-MM-DD date range.
  tax-minus-by-year     Fetch tax carry-forward minus residue grouped by tax year.
  order-monitor         Fetch order monitor transactions for an instrument type and day window.
  order-monitor-filters Fetch available order monitor status filters for an instrument type.
  movements             Fetch current-account and card movements for an explicit YYYY-MM-DD date range.
  zero-commission-etfs  Fetch Fineco's public zero-commission ETF list. Optional query filters by ISIN, venue, issuer, or description.

Credentials:
  USER PASSWORD          Fineco user id and password.
  --op-item ITEM         Read username/password from a 1Password CLI item.
  FINECO_USER_ID/PASSWORD and FINECO_OP_ITEM work too.

Output:
  --format FORMAT        Portfolio only: json, raw, csv, html, shareable-html, or shareable-csv. Default: json.
  --out PATH             Write output to a file instead of stdout.

Examples:
  npm start -- portfolio 12345678 'your-password'
  npm start -- portfolio --op-item Fineco --format html --out portfolio-report.html
  npm start -- portfolio --op-item Fineco --format shareable-html --out shareable-report.html
  npm start -- portfolio --op-item Fineco --format shareable-csv --out shareable-positions.csv
  npm start -- search-asset fineco --op-item Fineco
  npm start -- search-asset cloudflare 12345678 'your-password' --out search-results.json
  npm start -- asset-details IT0000072170.AFF --op-item Fineco
  npm start -- enrichment "https://example.com/stocks/example" "Example Fineco title" --out enrichment.md
  npm start -- market-indices --op-item Fineco
  npm start -- tax-carry-forward 2026-01-01 2026-01-31 --op-item Fineco
  npm start -- tax-minus-by-year --op-item Fineco
  npm start -- order-monitor --type equity --days 0 --op-item Fineco
  npm start -- order-monitor-filters --type equity --op-item Fineco
  npm start -- zero-commission-etfs EXUS
`;
}

export type DateRangeResult =
  | { ok: true; dateFrom: string; dateTo: string }
  | { ok: false; error: string };

// Returns a result rather than an MCP payload, so it stays usable from the CLI.
export function parseDateRange(
  dateFrom: string | undefined,
  dateTo: string | undefined,
): DateRangeResult {
  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    return { ok: false, error: "Dates must be in YYYY-MM-DD format." };
  }
  if (dateFrom > dateTo) {
    return { ok: false, error: "date_from must be on or before date_to." };
  }
  return { ok: true, dateFrom, dateTo };
}

export function isIsoDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === value;
}

function parseNonNegativeInteger(
  value: string | undefined,
  label: string,
): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new UsageError(`${label} must be a non-negative integer.`);
  }
  return Number(value);
}

export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let itemName: string | undefined;
  let format: OutputFormat | undefined;
  let outPath: string | undefined;
  let orderType: string | undefined;
  let orderDays: number | undefined;

  let command: CliCommand = "portfolio";
  if (
    argv[0] === "portfolio" ||
    argv[0] === "search-asset" ||
    argv[0] === "asset-details" ||
    argv[0] === "enrichment" ||
    argv[0] === "market-indices" ||
    argv[0] === "zero-commission-etfs" ||
    argv[0] === "tax-carry-forward" ||
    argv[0] === "tax-minus-by-year" ||
    argv[0] === "order-monitor" ||
    argv[0] === "order-monitor-filters" ||
    argv[0] === "movements"
  ) {
    command = argv.shift() as CliCommand;
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") return { kind: "help" };

    if (arg === "--op-item") {
      itemName = argv[index + 1];
      if (!itemName || itemName.startsWith("--")) {
        throw new UsageError("Expected item name after --op-item.");
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--op-item=")) {
      itemName = arg.slice("--op-item=".length);
      if (!itemName)
        throw new UsageError("Expected item name after --op-item.");
      continue;
    }

    if (arg === "--format") {
      if (command !== "portfolio") {
        throw new UsageError("--format is only supported by portfolio.");
      }
      format = parseOutputFormat(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      if (command !== "portfolio") {
        throw new UsageError("--format is only supported by portfolio.");
      }
      format = parseOutputFormat(arg.slice("--format=".length));
      continue;
    }

    if (arg === "--out") {
      outPath = argv[index + 1];
      if (!outPath || outPath.startsWith("--")) {
        throw new UsageError("Expected path after --out.");
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
      if (!outPath) throw new UsageError("Expected path after --out.");
      continue;
    }

    if (arg === "--type") {
      if (command !== "order-monitor" && command !== "order-monitor-filters") {
        throw new UsageError(
          "--type is only supported by order monitor commands.",
        );
      }
      orderType = argv[index + 1];
      if (!orderType || orderType.startsWith("--")) {
        throw new UsageError("Expected value after --type.");
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--type=")) {
      if (command !== "order-monitor" && command !== "order-monitor-filters") {
        throw new UsageError(
          "--type is only supported by order monitor commands.",
        );
      }
      orderType = arg.slice("--type=".length);
      if (!orderType) throw new UsageError("Expected value after --type.");
      continue;
    }

    if (arg === "--days") {
      if (command !== "order-monitor") {
        throw new UsageError("--days is only supported by order-monitor.");
      }
      orderDays = parseNonNegativeInteger(argv[index + 1], "--days");
      index += 1;
      continue;
    }

    if (arg.startsWith("--days=")) {
      if (command !== "order-monitor") {
        throw new UsageError("--days is only supported by order-monitor.");
      }
      orderDays = parseNonNegativeInteger(
        arg.slice("--days=".length),
        "--days",
      );
      continue;
    }

    if (arg.startsWith("--")) {
      throw new UsageError(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  const query =
    command === "search-asset" ||
    command === "asset-details" ||
    command === "enrichment" ||
    command === "zero-commission-etfs"
      ? positional.shift()
      : undefined;
  const enrichmentTitle =
    command === "enrichment" && positional.length > 0
      ? positional.join(" ")
      : undefined;

  const wantsDateRange =
    command === "tax-carry-forward" || command === "movements";
  const dateFrom = wantsDateRange ? positional.shift() : undefined;
  const dateTo = wantsDateRange ? positional.shift() : undefined;

  if (command === "search-asset" && !query) {
    throw new UsageError("Expected search text after search-asset.");
  }
  if (command === "asset-details" && !query) {
    throw new UsageError("Expected instrument key after asset-details.");
  }
  if (command === "enrichment" && !query) {
    throw new UsageError("Expected source URL after enrichment.");
  }
  if (wantsDateRange && (!dateFrom || !dateTo)) {
    throw new UsageError(`Expected DATE_FROM and DATE_TO after ${command}.`);
  }
  if (wantsDateRange && (!isIsoDate(dateFrom) || !isIsoDate(dateTo))) {
    throw new UsageError(`${command} dates must use YYYY-MM-DD format.`);
  }
  if (
    wantsDateRange &&
    isIsoDate(dateFrom) &&
    isIsoDate(dateTo) &&
    dateFrom > dateTo
  ) {
    throw new UsageError(`${command} DATE_FROM must be on or before DATE_TO.`);
  }

  if (command === "zero-commission-etfs" && positional.length > 0) {
    throw new UsageError(
      "zero-commission-etfs accepts at most one optional query.",
    );
  }

  if (command === "enrichment" || command === "zero-commission-etfs") {
    return {
      kind: "env",
      format,
      outPath,
      command,
      query,
      enrichmentTitle,
      dateFrom,
      dateTo,
      orderType,
      orderDays,
    };
  }

  if (itemName && positional.length > 0) {
    throw new UsageError(
      "Use either USER PASSWORD or --op-item ITEM, not both.",
    );
  }

  if (itemName) {
    return {
      kind: "onePassword",
      itemName,
      format,
      outPath,
      command,
      query,
      enrichmentTitle,
      dateFrom,
      dateTo,
      orderType,
      orderDays,
    };
  }
  if (positional.length === 0) {
    return {
      kind: "env",
      format,
      outPath,
      command,
      query,
      enrichmentTitle,
      dateFrom,
      dateTo,
      orderType,
      orderDays,
    };
  }
  if (positional.length === 2) {
    return {
      kind: "credentials",
      userId: positional[0]!,
      password: positional[1]!,
      format,
      outPath,
      command,
      query,
      enrichmentTitle,
      dateFrom,
      dateTo,
      orderType,
      orderDays,
    };
  }

  throw new UsageError("Expected USER PASSWORD or --op-item ITEM.");
}

function opFieldValue(
  item: OnePasswordItem,
  fieldName: string,
): string | undefined {
  const field = item.fields?.find(
    (candidate) =>
      candidate.label === fieldName ||
      candidate.id === fieldName ||
      candidate.purpose === fieldName.toUpperCase(),
  );
  return field?.value;
}

export async function credentialsFrom1Password(
  itemName: string,
): Promise<Pick<Config, "userId" | "password">> {
  const { stdout } = await execFileAsync("op", [
    "item",
    "get",
    itemName,
    "--format",
    "json",
    "--reveal",
  ]);
  const item = JSON.parse(stdout) as OnePasswordItem;
  const userId = opFieldValue(
    item,
    process.env.FINECO_OP_USER_FIELD ?? "username",
  );
  const password = opFieldValue(
    item,
    process.env.FINECO_OP_PASSWORD_FIELD ?? "password",
  );

  if (!userId || !password) {
    throw new Error(
      `1Password item "${itemName}" did not contain the expected username/password fields.`,
    );
  }

  return { userId, password };
}

function parseOutputFormat(value: string | undefined): OutputFormat {
  if (!value) return "json";
  if (
    value === "json" ||
    value === "raw" ||
    value === "csv" ||
    value === "html" ||
    value === "shareable-html" ||
    value === "shareable-csv"
  ) {
    return value;
  }
  throw new Error(
    `Unsupported format "${value}". Use json, raw, csv, html, shareable-html, or shareable-csv.`,
  );
}

function buildConfig(
  args: Exclude<CliArgs, { kind: "help" }>,
  userId: string,
  password: string,
): Config {
  return {
    userId,
    password,
    debug: process.env.FINECO_DEBUG === "1",
    command: args.command,
    query: args.query,
    enrichmentTitle: args.enrichmentTitle,
    dateFrom: args.dateFrom,
    dateTo: args.dateTo,
    orderType: args.orderType ?? "equity",
    orderDays: args.orderDays ?? 0,
    output: args.format ?? parseOutputFormat(process.env.FINECO_OUTPUT),
    outPath: args.outPath,
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
    accountIndex: envIndex(
      process.env.FINECO_ACCOUNT_INDEX,
      DEFAULT_ACCOUNT_INDEX,
    ),
    dossierIndex: envIndex(
      process.env.FINECO_DOSSIER_INDEX,
      DEFAULT_DOSSIER_INDEX,
    ),
    syntheticCookies: process.env.FINECO_SYNTHETIC_COOKIES !== "0",
  };
}

async function configFromArgsAndEnv(): Promise<Config> {
  const args = parseArgs(process.argv.slice(2));

  if (args.kind === "help") {
    console.log(usage());
    process.exit(0);
  }

  let userId = process.env.FINECO_USER_ID;
  let password = process.env.FINECO_PASSWORD;

  if (args.kind === "credentials") {
    userId = args.userId;
    password = args.password;
  }

  if (
    args.command === "enrichment" ||
    args.command === "zero-commission-etfs"
  ) {
    return buildConfig(args, "", "");
  }

  const opItemName =
    args.kind === "onePassword" ? args.itemName : process.env.FINECO_OP_ITEM;
  if ((!userId || !password) && opItemName) {
    try {
      ({ userId, password } = await credentialsFrom1Password(opItemName));
    } catch (error) {
      throw new Error(
        `Could not read 1Password item "${opItemName}": ${
          (error as Error).message
        }`,
      );
    }
  }

  if (!userId || !password) {
    throw new Error("Missing Fineco credentials.");
  }

  return buildConfig(args, userId, password);
}

function getSetCookieHeaders(response: Response): string[] {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }

  const setCookie = response.headers.get("set-cookie");
  return setCookie ? setCookie.split(/,(?=\s*[^;,\s]+=)/) : [];
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  return setCookies
    .map((cookie) => cookie.split(";")[0]?.trim() ?? "")
    .filter(Boolean)
    .join("; ");
}

function cookieNamesFromHeader(cookieHeader = ""): string[] {
  return cookieHeader
    .split(";")
    .map((cookie) => cookie.trim().split("=")[0])
    .filter((name): name is string => Boolean(name));
}

function mergeCookieHeaders(
  ...cookieHeaders: Array<string | undefined>
): string {
  const cookies = new Map<string, string>();
  for (const cookieHeader of cookieHeaders) {
    if (!cookieHeader) continue;

    for (const cookie of cookieHeader.split(";")) {
      const trimmed = cookie.trim();
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex > 0) {
        cookies.set(
          trimmed.slice(0, separatorIndex),
          trimmed.slice(separatorIndex + 1),
        );
      }
    }
  }

  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function mergeSetCookiesIntoHeader(
  cookieHeader: string,
  setCookies: string[],
): string {
  return mergeCookieHeaders(
    cookieHeader,
    cookieHeaderFromSetCookies(setCookies),
  );
}

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function randomDigits(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 10)).join("");
}

function syntheticPublicCookies(): string {
  const now = Date.now();
  return mergeCookieHeaders(
    `finecostat=${randomUUID()}.${randomBase64Url(33)}`,
    `XID=${now}.${randomDigits(4)}`,
    "LBM=pubsapipr03",
    `PORTALSESSIONID=${randomDigits(8)}`,
    `gdate=${now + Math.floor(Math.random() * 60_000)}`,
    `store-sessionid=${randomUUID()}`,
    `finecoLogin=${randomUUID()}`,
  );
}

export function makeLogger(config: Config): (message: string) => void {
  return (message) => {
    if (config.debug) console.error(message);
  };
}

async function fetchWithCookieJar(
  url: string,
  options: RequestInit = {},
  cookieHeader = "",
  maxRedirects = 8,
): Promise<CookieFetchResult> {
  let currentUrl = url;
  let currentCookie = cookieHeader;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        ...options,
        redirect: "manual",
        headers: {
          ...(options.headers ?? {}),
          ...(currentCookie ? { Cookie: currentCookie } : {}),
        },
      });
    } catch (error) {
      const cause = (error as Error).cause;
      const causeText =
        cause instanceof Error
          ? `${cause.name}: ${cause.message}`
          : cause
            ? String(cause)
            : (error as Error).message;
      throw new Error(`Fetch failed for ${currentUrl}: ${causeText}`);
    }

    currentCookie = mergeSetCookiesIntoHeader(
      currentCookie,
      getSetCookieHeaders(response),
    );

    if (response.status < 300 || response.status >= 400) {
      return { response, cookie: currentCookie, url: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) return { response, cookie: currentCookie, url: currentUrl };
    currentUrl = new URL(location, currentUrl).toString();
  }

  throw new Error(`Too many redirects while fetching ${url}`);
}

export function toCsv(rows: Position[]): string {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const quote = (value: unknown): string => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  return [
    headers.map(quote).join(","),
    ...rows.map((row) =>
      headers.map((header) => quote(row[header as keyof Position])).join(","),
    ),
  ].join("\n");
}

// One formula for both the shareable renderers and the JSON payload. Two would
// drift, and the fixtures here carry `summary.show` but no `summary.total`, so a
// second formula reading `total` alone would silently disagree.
export function portfolioTotalMarketValue(summary: PositionsSummary): number {
  const total = summary.summary?.show ?? summary.summary?.total ?? {};
  return total.marketValue ?? 0;
}

export function positionWeightPerc(
  position: Position,
  totalMarketValue: number,
): number | undefined {
  return totalMarketValue > 0 && typeof position.marketValue === "number"
    ? (position.marketValue / totalMarketValue) * 100
    : undefined;
}

function shareableRows(
  summary: PositionsSummary,
): Array<Record<string, string>> {
  const rows = positionsAsRows(summary);
  const totalMarketValue = portfolioTotalMarketValue(summary);

  return [...rows]
    .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
    .map((position) => {
      const weight = positionWeightPerc(position, totalMarketValue);

      return {
        description: String(position.description ?? ""),
        symbol: String(position.symbol ?? ""),
        instrId: String(position.instrId ?? ""),
        venueSystem: String(position.venueSystem ?? ""),
        type: String(position.type ?? ""),
        currencyCd: String(position.currencyCd ?? ""),
        weightPerc:
          typeof weight === "number" && Number.isFinite(weight)
            ? String(weight)
            : "",
        profitLossPerc:
          typeof position.profitLossPerc === "number" &&
          Number.isFinite(position.profitLossPerc)
            ? String(position.profitLossPerc)
            : "",
      };
    });
}

function toRecordCsv(rows: Array<Record<string, string>>): string {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const quote = (value: unknown): string => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  return [
    headers.map(quote).join(","),
    ...rows.map((row) => headers.map((header) => quote(row[header])).join(",")),
  ].join("\n");
}

function firstArrayInPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const queue = Object.values(payload);
  for (const value of queue) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") queue.push(...Object.values(value));
  }
  return [];
}

function renderJsonOutput(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

function splitInstrumentKey(key: string): {
  instrId: string;
  venueSystem: string;
  key: string;
} {
  const [instrId, ...venueParts] = key.split(".");
  const venueSystem = venueParts.join(".");
  if (!instrId || !venueSystem) {
    throw new Error("Instrument key must look like INSTRUMENT.VENUE.");
  }
  return { instrId, venueSystem, key: `${instrId}.${venueSystem}` };
}

function collectInstrumentKeys(payload: unknown): string[] {
  const keys = new Set<string>();
  const rows = firstArrayInPayload(payload);

  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    const instrId =
      typeof record.instrId === "string" ? record.instrId : undefined;
    const venueSystem =
      typeof record.venueSystem === "string" ? record.venueSystem : undefined;
    if (instrId && venueSystem) keys.add(`${instrId}.${venueSystem}`);
  }

  return [...keys];
}

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatNumber(
  value: number | undefined,
  options: Intl.NumberFormatOptions = {},
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";

  return new Intl.NumberFormat("it-IT", {
    minimumFractionDigits: options.minimumFractionDigits ?? 2,
    maximumFractionDigits: options.maximumFractionDigits ?? 2,
  }).format(value);
}

function formatMoney(value: number | undefined, currency = "EUR"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";

  return new Intl.NumberFormat("it-IT", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatPercent(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${formatNumber(value)}%`
    : "";
}

export function positionsAsRows(summary: PositionsSummary): Position[] {
  return summary.positions?.show ?? [];
}

export function reportHtml(summary: PositionsSummary): string {
  const rows = positionsAsRows(summary);
  const capturedAtText = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "medium",
  }).format(new Date());
  const total = summary.summary?.show ?? summary.summary?.total ?? {};
  const currencies = summary.filters?.currencies?.show ?? [];

  const rowHtml = [...rows]
    .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
    .map((position) => {
      const profitLoss = position.profitLoss ?? 0;
      const profitClass =
        profitLoss > 0 ? "positive" : profitLoss < 0 ? "negative" : "";

      return `<tr>
        <td>
          <div class="asset">${htmlEscape(position.description)}</div>
          <div class="meta">${htmlEscape(
            position.symbol || position.instrId,
          )} · ${htmlEscape(position.venueSystem)} · ${htmlEscape(
            position.type,
          )}</div>
        </td>
        <td class="num">${formatNumber(position.qty, {
          maximumFractionDigits: 6,
        })}</td>
        <td class="num">${formatMoney(
          position.avgPrice,
          position.currencyCd,
        )}</td>
        <td class="num">${formatMoney(
          position.marketPrice,
          position.currencyCd,
        )}</td>
        <td class="num">${formatMoney(position.bookValue)}</td>
        <td class="num strong">${formatMoney(position.marketValue)}</td>
        <td class="num ${profitClass}">${formatMoney(position.profitLoss)}</td>
        <td class="num ${profitClass}">${formatPercent(
          position.profitLossPerc,
        )}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fineco Portfolio Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --panel: #ffffff;
      --ink: #182026;
      --muted: #69757f;
      --line: #dde4e8;
      --positive: #087443;
      --negative: #b42318;
      --accent: #006b8f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 32px auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      margin-bottom: 22px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 30px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .captured {
      color: var(--muted);
      font-size: 14px;
      text-align: right;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .05em;
      margin-bottom: 8px;
    }
    .value {
      font-size: 22px;
      font-weight: 700;
    }
    .subtle {
      color: var(--muted);
      font-size: 13px;
      margin-top: 6px;
    }
    .table-wrap {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 980px;
    }
    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-align: left;
      text-transform: uppercase;
      letter-spacing: .04em;
      background: #fbfcfd;
      position: sticky;
      top: 0;
    }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .strong { font-weight: 700; }
    .asset { font-weight: 650; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .positive { color: var(--positive); }
    .negative { color: var(--negative); }
    @media (max-width: 820px) {
      main { width: min(100vw - 20px, 1180px); margin: 20px auto; }
      header { align-items: start; flex-direction: column; }
      .captured { text-align: left; }
      .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Fineco Portfolio Report</h1>
        <div class="subtle">${rows.length} positions · ${htmlEscape(
          currencies.join(", "),
        )}</div>
      </div>
      <div class="captured">Captured<br>${htmlEscape(capturedAtText)}</div>
    </header>

    <section class="cards" aria-label="Portfolio summary">
      <div class="card"><div class="label">Book Value</div><div class="value">${formatMoney(
        total.bookValue,
        total.currencyCd,
      )}</div></div>
      <div class="card"><div class="label">Market Value</div><div class="value">${formatMoney(
        total.marketValue,
        total.currencyCd,
      )}</div></div>
      <div class="card"><div class="label">Profit / Loss</div><div class="value ${
        (total.profitLoss ?? 0) > 0
          ? "positive"
          : (total.profitLoss ?? 0) < 0
            ? "negative"
            : ""
      }">${formatMoney(total.profitLoss, total.currencyCd)}</div></div>
      <div class="card"><div class="label">Return</div><div class="value ${
        (total.profitLossPerc ?? 0) > 0
          ? "positive"
          : (total.profitLossPerc ?? 0) < 0
            ? "negative"
            : ""
      }">${formatPercent(total.profitLossPerc)}</div></div>
    </section>

    <section class="table-wrap" aria-label="Positions">
      <table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th class="num">Qty</th>
            <th class="num">Avg Price</th>
            <th class="num">Market Price</th>
            <th class="num">Book Value</th>
            <th class="num">Market Value</th>
            <th class="num">P/L</th>
            <th class="num">P/L %</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function shareableReportHtml(summary: PositionsSummary): string {
  const rows = positionsAsRows(summary);
  const capturedAtText = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "medium",
  }).format(new Date());
  const total = summary.summary?.show ?? summary.summary?.total ?? {};
  const totalMarketValue = total.marketValue ?? 0;
  const currencies = summary.filters?.currencies?.show ?? [];

  const rowHtml = [...rows]
    .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
    .map((position) => {
      const profitLossPerc = position.profitLossPerc ?? 0;
      const profitClass =
        profitLossPerc > 0 ? "positive" : profitLossPerc < 0 ? "negative" : "";
      const weight =
        totalMarketValue > 0 && typeof position.marketValue === "number"
          ? (position.marketValue / totalMarketValue) * 100
          : undefined;

      return `<tr>
        <td>
          <div class="asset">${htmlEscape(position.description)}</div>
          <div class="meta">${htmlEscape(
            position.symbol || position.instrId,
          )} · ${htmlEscape(position.venueSystem)} · ${htmlEscape(
            position.type,
          )}</div>
        </td>
        <td class="num strong">${formatPercent(weight)}</td>
        <td class="num ${profitClass}">${formatPercent(
          position.profitLossPerc,
        )}</td>
      </tr>`;
    })
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Fineco Shareable Portfolio Report</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7f8;
      --panel: #ffffff;
      --ink: #182026;
      --muted: #69757f;
      --line: #dde4e8;
      --positive: #087443;
      --negative: #b42318;
      --accent: #006b8f;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }
    main {
      width: min(960px, calc(100vw - 32px));
      margin: 32px auto;
    }
    header {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      margin-bottom: 22px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 30px;
      font-weight: 700;
      letter-spacing: 0;
    }
    .captured {
      color: var(--muted);
      font-size: 14px;
      text-align: right;
    }
    .cards {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .05em;
      margin-bottom: 8px;
    }
    .value {
      font-size: 22px;
      font-weight: 700;
    }
    .subtle {
      color: var(--muted);
      font-size: 13px;
      margin-top: 6px;
    }
    .table-wrap {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 700px;
    }
    th, td {
      padding: 11px 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      text-align: left;
      text-transform: uppercase;
      letter-spacing: .04em;
      background: #fbfcfd;
      position: sticky;
      top: 0;
    }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .strong { font-weight: 700; }
    .asset { font-weight: 650; }
    .meta { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .positive { color: var(--positive); }
    .negative { color: var(--negative); }
    @media (max-width: 720px) {
      main { width: min(100vw - 20px, 960px); margin: 20px auto; }
      header { align-items: start; flex-direction: column; }
      .captured { text-align: left; }
      .cards { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Fineco Shareable Portfolio Report</h1>
        <div class="subtle">${rows.length} positions · ${htmlEscape(
          currencies.join(", "),
        )}</div>
      </div>
      <div class="captured">Captured<br>${htmlEscape(capturedAtText)}</div>
    </header>

    <section class="cards" aria-label="Portfolio summary">
      <div class="card"><div class="label">Portfolio Return</div><div class="value ${
        (total.profitLossPerc ?? 0) > 0
          ? "positive"
          : (total.profitLossPerc ?? 0) < 0
            ? "negative"
            : ""
      }">${formatPercent(total.profitLossPerc)}</div></div>
      <div class="card"><div class="label">Positions</div><div class="value">${
        rows.length
      }</div></div>
    </section>

    <section class="table-wrap" aria-label="Shareable positions">
      <table>
        <thead>
          <tr>
            <th>Instrument</th>
            <th class="num">Weight</th>
            <th class="num">P/L %</th>
          </tr>
        </thead>
        <tbody>${rowHtml}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

export function renderOutput(
  summary: PositionsSummary,
  format: OutputFormat,
): string {
  const rows = positionsAsRows(summary);

  if (format === "raw") {
    return JSON.stringify(summary, null, 2);
  }

  if (format === "csv") {
    return toCsv(rows);
  }

  if (format === "html") {
    return reportHtml(summary);
  }

  if (format === "shareable-html") {
    return shareableReportHtml(summary);
  }

  if (format === "shareable-csv") {
    return toRecordCsv(shareableRows(summary));
  }

  const totalMarketValue = portfolioTotalMarketValue(summary);

  return JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      summary: summary.summary,
      // Copies, never the live Position objects: `positionsAsRows` hands back
      // `summary.positions.show` by reference, and `toCsv` builds its header row
      // from `Object.keys`, so an in-place field would leak a column into a later
      // csv/html render of the same summary.
      rows: rows.map((position) => {
        const weightPerc = positionWeightPerc(position, totalMarketValue);
        return weightPerc === undefined
          ? { ...position }
          : { ...position, weightPerc };
      }),
      rowCount: rows.length,
    },
    null,
    2,
  );
}

async function emitOutput(
  content: string,
  outPath: string | undefined,
): Promise<void> {
  if (outPath) {
    await writeFile(outPath, content);
    return;
  }

  console.log(content);
}

export async function fetchPositionsSummary(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<PositionsSummary>> {
  const positions = await fetchWithCookieJar(
    config.positionsUrl,
    {
      headers: {
        ...browserHeaders,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Origin: "https://finecobank.com",
        Referer: PORTFOLIO_URL,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        ...indexHeaders(config),
      },
    },
    cookie,
  );

  const body = await positions.response.text();
  debug(
    `Positions summary API: HTTP ${positions.response.status}, url=${positions.url}, bytes=${body.length}`,
  );

  if (!positions.response.ok) {
    const retryAfter =
      positions.response.status === 429
        ? retryAfterSeconds(positions.response)
        : undefined;
    return {
      ok: false,
      status: positions.response.status,
      authExpired:
        positions.response.status === 401 || positions.response.status === 403,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      error: `Positions summary API failed: HTTP ${
        positions.response.status
      } ${body.slice(0, 500)}`,
    };
  }

  try {
    return { ok: true, data: JSON.parse(body) as PositionsSummary };
  } catch {
    return {
      ok: false,
      error: `Positions summary API returned non-JSON: ${body.slice(0, 500)}`,
    };
  }
}

async function fetchJsonApi<T>(
  url: string,
  config: Config,
  cookie: string,
  debug: (message: string) => void,
  options: {
    label: string;
    method?: "GET" | "POST";
    referer?: string;
    body?: unknown;
  },
): Promise<ApiResult<T>> {
  const response = await fetchWithCookieJar(
    url,
    {
      method: options.method ?? "GET",
      headers: {
        ...browserHeaders,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json",
        Origin: "https://finecobank.com",
        Referer: options.referer ?? PORTFOLIO_URL,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        ...indexHeaders(config),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
    cookie,
  );

  const body = await response.response.text();
  debug(
    `${options.label}: HTTP ${response.response.status}, url=${response.url}, bytes=${body.length}`,
  );

  if (!response.response.ok) {
    const retryAfter =
      response.response.status === 429
        ? retryAfterSeconds(response.response)
        : undefined;
    return {
      ok: false,
      status: response.response.status,
      authExpired:
        response.response.status === 401 || response.response.status === 403,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      error: `${options.label} failed: HTTP ${
        response.response.status
      } ${body.slice(0, 500)}`,
    };
  }

  try {
    return { ok: true, data: JSON.parse(body) as T };
  } catch {
    return {
      ok: false,
      error: `${options.label} returned non-JSON: ${body.slice(0, 500)}`,
    };
  }
}

export async function searchAssets(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<unknown>> {
  if (!config.query) throw new Error("Missing asset search query.");
  const url = new URL(config.marketSearchUrl);
  url.searchParams.set("term", config.query);

  return fetchJsonApi(url.toString(), config, cookie, debug, {
    label: "Market search API",
    referer: "https://finecobank.com/pvt/home",
  });
}

export async function fetchAssetDetails(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<unknown>> {
  if (!config.query) throw new Error("Missing asset details instrument key.");
  const instrument = splitInstrumentKey(config.query);
  const referer = `https://finecobank.com/pvt/trading/snapshot/${encodeURIComponent(
    instrument.key,
  )}`;

  const marketSnapshotUrl = `${config.snapshotUrl}/${encodeURIComponent(
    instrument.venueSystem,
  )}/${encodeURIComponent(instrument.instrId)}`;
  const instrumentSnapshotUrl = new URL(config.instrumentSnapshotUrl);
  instrumentSnapshotUrl.searchParams.set("instruments", instrument.key);

  const chartUrl = new URL(config.chartDataUrl);
  chartUrl.searchParams.set("instrId", instrument.instrId);
  chartUrl.searchParams.set("venueSystem", instrument.venueSystem);
  chartUrl.searchParams.set("period", "LAST");
  chartUrl.searchParams.set("freq", "5m");
  chartUrl.searchParams.set("output", "all");
  chartUrl.searchParams.set("useStartTime", "true");

  const linkedIndicesUrl = `${config.linkedIndicesUrl}/${encodeURIComponent(
    instrument.key,
  )}/linked-instrument/all`;

  const eventsUrl = new URL(config.economicEventsUrl);
  eventsUrl.searchParams.set("instruments", instrument.key);

  const similarUrl = new URL(config.similarInstrumentsUrl);
  similarUrl.searchParams.set("instrId", instrument.instrId);
  similarUrl.searchParams.set("venueSystem", instrument.venueSystem);

  const newsUrl = new URL(config.newsUrl);
  newsUrl.searchParams.set("symbol", instrument.instrId);
  newsUrl.searchParams.set("limit", "4");

  const [
    staticDetails,
    marketSnapshot,
    instrumentSnapshot,
    chart,
    linkedIndices,
    events,
    similar,
    news,
  ] = await Promise.all([
    fetchJsonApi(config.assetDetailsUrl, config, cookie, debug, {
      label: "Asset details API",
      method: "POST",
      referer,
      body: {
        instruments: [instrument.key],
        fields: assetDetailFields,
        withWarnings: true,
      },
    }),
    fetchJsonApi(marketSnapshotUrl, config, cookie, debug, {
      label: "Market snapshot API",
      referer,
    }),
    fetchJsonApi(instrumentSnapshotUrl.toString(), config, cookie, debug, {
      label: "Instrument snapshot API",
      referer,
    }),
    fetchJsonApi(chartUrl.toString(), config, cookie, debug, {
      label: "Chart API",
      referer,
    }),
    fetchJsonApi(linkedIndicesUrl, config, cookie, debug, {
      label: "Linked indices API",
      referer,
    }),
    fetchJsonApi(eventsUrl.toString(), config, cookie, debug, {
      label: "Economic events API",
      referer,
    }),
    fetchJsonApi(similarUrl.toString(), config, cookie, debug, {
      label: "Similar instruments API",
      referer,
    }),
    fetchJsonApi(newsUrl.toString(), config, cookie, debug, {
      label: "News API",
      referer,
    }),
  ]);
  if (!staticDetails.ok) return staticDetails;

  const relatedKeys = [
    ...new Set([
      ...collectInstrumentKeys(similar.ok ? similar.data : undefined),
      ...collectInstrumentKeys(
        linkedIndices.ok ? linkedIndices.data : undefined,
      ),
    ]),
  ].filter((key) => key !== instrument.key);

  const [relatedList, relatedStatic] =
    relatedKeys.length > 0
      ? await Promise.all([
          fetchJsonApi(config.instrumentListUrl, config, cookie, debug, {
            label: "Related instrument list API",
            method: "POST",
            referer,
            body: { instruments: relatedKeys },
          }),
          fetchJsonApi(config.assetDetailsUrl, config, cookie, debug, {
            label: "Related static instruments API",
            method: "POST",
            referer,
            body: {
              instruments: relatedKeys,
              fields: relatedInstrumentFields,
              withWarnings: true,
            },
          }),
        ])
      : [undefined, undefined];

  return {
    ok: true,
    data: {
      instrument,
      static: staticDetails.data,
      marketSnapshot: marketSnapshot.ok ? marketSnapshot.data : null,
      instrumentSnapshot: instrumentSnapshot.ok
        ? instrumentSnapshot.data
        : null,
      chart: chart.ok ? chart.data : null,
      linkedIndices: linkedIndices.ok ? linkedIndices.data : null,
      economicEvents: events.ok ? events.data : null,
      similarInstruments: similar.ok ? similar.data : null,
      news: news.ok ? news.data : null,
      relatedInstruments: {
        keys: relatedKeys,
        list: relatedList?.ok ? relatedList.data : null,
        static: relatedStatic?.ok ? relatedStatic.data : null,
      },
      warnings: [
        marketSnapshot.ok ? undefined : marketSnapshot.error,
        instrumentSnapshot.ok ? undefined : instrumentSnapshot.error,
        chart.ok ? undefined : chart.error,
        linkedIndices.ok ? undefined : linkedIndices.error,
        events.ok ? undefined : events.error,
        similar.ok ? undefined : similar.error,
        news.ok ? undefined : news.error,
        relatedList?.ok === false ? relatedList.error : undefined,
        relatedStatic?.ok === false ? relatedStatic.error : undefined,
      ].filter((warning): warning is string => Boolean(warning)),
    },
  };
}

export async function fetchMarketIndices(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<unknown>> {
  return fetchJsonApi(config.marketIndicesUrl, config, cookie, debug, {
    label: "Market indices API",
    referer: "https://finecobank.com/pvt/trading/home",
  });
}

export async function fetchTaxCarryForward(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<unknown>> {
  if (!config.dateFrom || !config.dateTo) {
    throw new Error("Missing tax carry-forward date range.");
  }

  const url = new URL(config.taxCarryForwardUrl);
  url.searchParams.set("dateFrom", config.dateFrom);
  url.searchParams.set("dateTo", config.dateTo);

  return fetchJsonApi(url.toString(), config, cookie, debug, {
    label: "Tax carry-forward API",
    referer:
      "https://finecobank.com/pvt/portfolio/report/tax-carry-forward/current-month",
  });
}

export async function fetchTaxMinusByYear(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<unknown>> {
  return fetchJsonApi(config.taxCarryForwardMinusUrl, config, cookie, debug, {
    label: "Tax minus by year API",
    referer:
      "https://finecobank.com/pvt/portfolio/report/tax-carry-forward/current-month",
  });
}

export async function fetchOrderMonitor(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<unknown>> {
  const url = new URL(config.orderMonitorUrl);
  url.searchParams.set("type", config.orderType);
  url.searchParams.set("days", String(config.orderDays));

  return fetchJsonApi(url.toString(), config, cookie, debug, {
    label: "Order monitor API",
    referer: "https://finecobank.com/pvt/portfolio/order-monitor/shares",
  });
}

export async function fetchOrderMonitorFilters(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<unknown>> {
  const url = new URL(config.orderMonitorFiltersUrl);
  url.searchParams.set("type", config.orderType);

  return fetchJsonApi(url.toString(), config, cookie, debug, {
    label: "Order monitor filters API",
    referer: "https://finecobank.com/pvt/portfolio/order-monitor/shares",
  });
}

export type Movement = {
  dataOperazione: string;
  dataValuta?: string;
  causale?: string;
  descrizione?: string;
  descrizioneBreve?: string;
  importo: number;
  causaleMovimento?: string;
  tipoMovimento?: string;
  bfCategoria?: string | null;
  bfSottocategoria?: string | null;
  bfIdBrand?: string | null;
  progressivoMovimento?: string;
};

type MovementsPage = {
  movimenti?: Movement[];
  lastPage?: boolean;
  limitedResult?: boolean;
  balanceAccountAtSearchDate?: number;
  balanceAccountAtMovement?: number;
};

export type MovementsResult = {
  movimenti: Movement[];
  count: number;
  dateFrom: string;
  dateTo: string;
  limitedResult: boolean;
  balanceAccountAtSearchDate?: number;
  balanceAccountAtMovement?: number;
};

// 200_000 rows at the 250-row page size is 800 requests; the cap sits just above
// that so a normal full range never reaches it.
const MAX_MOVEMENT_PAGES = 1_000;

// Pulls current-account + cards movements over an arbitrary date range,
// auto-paginating with offset/limit until the API reports the last page.
// This is what bypasses the web UI's statement-download cap.
export async function fetchMovements(
  config: Config,
  cookie: string,
  debug: (message: string) => void,
): Promise<ApiResult<MovementsResult>> {
  if (!config.dateFrom || !config.dateTo) {
    throw new Error("Missing movements date range.");
  }
  const dateFromIso = `${config.dateFrom}T00:00:00.000Z`;
  const dateToIso = `${config.dateTo}T23:59:59.999Z`;
  const limit = 250;
  const all: Movement[] = [];
  let offset = 0;
  let requests = 0;
  let limited = false;
  let balanceAtSearch: number | undefined;
  let balanceAtMovement: number | undefined;

  for (;;) {
    requests += 1;
    const page = await fetchJsonApi<MovementsPage>(
      MOVEMENTS_URL,
      config,
      cookie,
      debug,
      {
        label: "Movements API",
        method: "POST",
        referer: "https://finecobank.com/pvt/conto-corrente/saldo-e-movimenti",
        body: {
          dateFrom: dateFromIso,
          dateTo: dateToIso,
          offset,
          limit,
          keyword: "",
        },
      },
    );
    if (!page.ok) {
      // 451 here is always the SCA window, and the raw bank body does not say so.
      return page.status === 451
        ? { ...page, error: `${SCA_WINDOW_MESSAGE} (${page.error})` }
        : page;
    }

    const batch = page.data.movimenti ?? [];
    if (page.data.limitedResult) limited = true;
    if (offset === 0) {
      balanceAtSearch = page.data.balanceAccountAtSearchDate;
      balanceAtMovement = page.data.balanceAccountAtMovement;
    }
    all.push(...batch);
    debug(
      `Movements: offset=${offset}, batch=${batch.length}, total=${all.length}, lastPage=${page.data.lastPage}`,
    );

    if (page.data.lastPage || batch.length === 0) break;
    // Advance by what the page actually returned, not by `limit`. `lastPage` is
    // optional in the response, so a short page without it would leave the next
    // request starting past every row the server did not send. Advancing by the
    // batch size skips nothing, and a short page that really was the last one
    // costs one extra request that comes back empty and ends the loop.
    offset += batch.length;
    // Two backstops, because the offset alone no longer bounds the request count:
    // pages advance by their own size now, so a server that answers one row at a
    // time would keep the loop under the row cap for 200_000 requests.
    if (offset > 200_000 || requests >= MAX_MOVEMENT_PAGES) {
      // Stopping early truncates the range just as surely as the API's own cap does.
      limited = true;
      break;
    }
  }

  return {
    ok: true,
    data: {
      movimenti: all,
      count: all.length,
      dateFrom: config.dateFrom,
      dateTo: config.dateTo,
      limitedResult: limited,
      ...(balanceAtSearch === undefined
        ? {}
        : { balanceAccountAtSearchDate: balanceAtSearch }),
      ...(balanceAtMovement === undefined
        ? {}
        : { balanceAccountAtMovement: balanceAtMovement }),
    },
  };
}

export type DividendKind = "dividend" | "remunerated_portfolio";

export type DividendEvent = {
  payDate: string;
  security: string;
  kind: DividendKind;
  grossCents: number;
  withholdingCents: number;
  netCents: number;
  unpaired?: "gross" | "withholding";
};

export type DividendReport = {
  capturedAt: string;
  dateFrom: string;
  dateTo: string;
  assumedCurrency: "EUR";
  truncated: boolean;
  events: DividendEvent[];
  totals: {
    grossCents: number;
    withholdingCents: number;
    netCents: number;
    count: number;
  };
};

// `causaleMovimento` is the stable key. `causale` is display text and lies: a
// NVIDIA dividend arrives under "Dividendo Italia" too, so the code means
// "dividend credit", not "Italian dividend".
const DIVIDEND_LEGS: Record<
  string,
  { leg: "gross" | "withholding"; kind: DividendKind; prefix: string }
> = {
  DII: { leg: "gross", kind: "dividend", prefix: "Div.su " },
  DIR: { leg: "withholding", kind: "dividend", prefix: "Rit.div.su " },
  DER: { leg: "withholding", kind: "dividend", prefix: "Rit.div.su " },
  DPR: {
    leg: "gross",
    kind: "remunerated_portfolio",
    prefix: "Acc.div.Port.Rem. ",
  },
  RPR: {
    leg: "withholding",
    kind: "remunerated_portfolio",
    prefix: "Add.rit.Port.Rem. ",
  },
};

const UNLABELLED_SECURITY = "(unlabelled movement)";

function toCents(amount: number | undefined): number {
  // `importo` is typed as a number but comes from an untyped bank response. A
  // string or null would make `Math.round` return NaN, which then spreads through
  // every total silently. On a money path a loud stop beats a wrong number.
  if (amount === undefined) return 0;
  if (!Number.isFinite(amount)) {
    throw new Error(
      `Movement has an unreadable importo: ${JSON.stringify(amount)}.`,
    );
  }
  return Math.round(amount * 100);
}

// Returns the security label when the description carries the known prefix, and
// undefined otherwise. Never falls back to the whole description: that would put
// every prefix-less row in one bucket and merge unrelated securities.
function securityLabel(
  description: string | undefined,
  prefix: string,
): string | undefined {
  if (!description) return undefined;
  const trimmed = description.trim();
  if (!trimmed.startsWith(prefix)) return undefined;
  // A description that is nothing but the prefix parses to "", which is not a
  // label. Returning it would put a blank `security` in the report and let two
  // unrelated blank rows share a group key.
  const label = trimmed.slice(prefix.length).trim();
  return label === "" ? undefined : label;
}

export function dividendsFromMovements(
  movements: Movement[],
  meta: {
    dateFrom: string;
    dateTo: string;
    capturedAt: string;
    truncated?: boolean;
  },
): DividendReport {
  type Group = {
    payDate: string;
    security: string;
    kind: DividendKind;
    grossCents: number;
    withholdingCents: number;
    sawGross: boolean;
    sawWithholding: boolean;
  };

  const groups = new Map<string, Group>();

  movements.forEach((movement, index) => {
    const code = movement.causaleMovimento;
    const leg = code === undefined ? undefined : DIVIDEND_LEGS[code];
    if (!leg) return;

    const label = securityLabel(movement.descrizione, leg.prefix);
    // The grouping key only has to be unique and stable; `security` is what a
    // caller reads. `progressivoMovimento` is optional too, so the last resort is
    // the row index, which is unique by construction.
    const key =
      label ?? movement.progressivoMovimento ?? `row:${String(index)}`;
    const groupKey = `${movement.dataOperazione}|${leg.kind}|${key}`;

    const group = groups.get(groupKey) ?? {
      payDate: movement.dataOperazione,
      security: label ?? movement.progressivoMovimento ?? UNLABELLED_SECURITY,
      kind: leg.kind,
      grossCents: 0,
      withholdingCents: 0,
      sawGross: false,
      sawWithholding: false,
    };

    if (leg.leg === "gross") {
      // Signed on purpose: a reversal posts negative and must stay negative.
      group.grossCents += toCents(movement.importo);
      group.sawGross = true;
    } else {
      // Negated, not abs()'d: a normal withholding is a debit and becomes a
      // positive charge, while a refund stays negative instead of flipping into one.
      group.withholdingCents += -toCents(movement.importo);
      group.sawWithholding = true;
    }

    groups.set(groupKey, group);
  });

  const events: DividendEvent[] = [...groups.values()].map((group) => ({
    payDate: group.payDate,
    security: group.security,
    kind: group.kind,
    grossCents: group.grossCents,
    withholdingCents: group.withholdingCents,
    netCents: group.grossCents - group.withholdingCents,
    // Both flags matter. An orphan withholding without its gross understates
    // income; an orphan gross is either an instrument with no withholding or a
    // window that clipped the second leg, and nothing here can tell those apart.
    ...(group.sawGross && group.sawWithholding
      ? {}
      : {
          unpaired: group.sawGross
            ? ("withholding" as const)
            : ("gross" as const),
        }),
  }));

  return {
    capturedAt: meta.capturedAt,
    dateFrom: meta.dateFrom,
    dateTo: meta.dateTo,
    assumedCurrency: "EUR",
    truncated: meta.truncated ?? false,
    events,
    totals: {
      grossCents: events.reduce((sum, event) => sum + event.grossCents, 0),
      withholdingCents: events.reduce(
        (sum, event) => sum + event.withholdingCents,
        0,
      ),
      netCents: events.reduce((sum, event) => sum + event.netCents, 0),
      count: events.length,
    },
  };
}

export function filterZeroCommissionEtfs(
  instruments: ZeroCommissionEtf[],
  query: string | undefined,
): ZeroCommissionEtf[] {
  const needle = query?.trim().toLocaleLowerCase("en");
  if (!needle) return instruments;

  return instruments.filter((instrument) =>
    [
      instrument.instrId,
      instrument.venueSystem,
      instrument.description,
      instrument.issuer,
    ].some((value) => value?.toLocaleLowerCase("en").includes(needle)),
  );
}

export async function fetchZeroCommissionEtfs(
  options: {
    url?: string;
    query?: string;
    debug?: (message: string) => void;
  } = {},
): Promise<ApiResult<ZeroCommissionEtfs>> {
  const url =
    options.url ??
    process.env.FINECO_ZERO_COMMISSION_ETFS_URL ??
    ZERO_COMMISSION_ETFS_URL;
  const debug = options.debug ?? (() => {});
  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      "Accept-Language": "it,en;q=0.9",
      "Cache-Control": "no-cache",
      Origin: "https://finecobank.com",
      Pragma: "no-cache",
      Referer: "https://finecobank.com/pvt/trading/stocklist/etf/zero",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
      "User-Agent": browserHeaders["User-Agent"],
      "sec-ch-ua": browserHeaders["sec-ch-ua"],
      "sec-ch-ua-mobile": browserHeaders["sec-ch-ua-mobile"],
      "sec-ch-ua-platform": browserHeaders["sec-ch-ua-platform"],
      "sec-gpc": browserHeaders["sec-gpc"],
    },
  });
  const body = await response.text();
  debug(
    `Zero-commission ETF list: HTTP ${response.status}, url=${url}, bytes=${body.length}`,
  );

  if (!response.ok) {
    const retryAfter =
      response.status === 429 ? retryAfterSeconds(response) : undefined;
    return {
      ok: false,
      status: response.status,
      ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
      error: `Zero-commission ETF list failed: HTTP ${
        response.status
      } ${body.slice(0, 500)}`,
    };
  }

  try {
    const parsed = JSON.parse(body) as { instruments?: ZeroCommissionEtf[] };
    const instruments = filterZeroCommissionEtfs(
      parsed.instruments ?? [],
      options.query,
    );
    return {
      ok: true,
      data: {
        capturedAt: new Date().toISOString(),
        sourceUrl: url,
        count: instruments.length,
        instruments,
      },
    };
  } catch {
    return {
      ok: false,
      error: `Zero-commission ETF list returned non-JSON: ${body.slice(
        0,
        500,
      )}`,
    };
  }
}

export async function logout(
  cookie: string,
  debug: (message: string) => void,
): Promise<void> {
  if (!cookie) return;

  try {
    const logoutResponse = await fetchWithCookieJar(
      LOGOUT_URL,
      {
        headers: {
          ...browserHeaders,
          Accept: "application/json, text/plain, */*",
          Origin: "https://finecobank.com",
          Referer: PORTFOLIO_URL,
          "Sec-Fetch-Dest": "empty",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-site",
          "X-Account-Index": "0",
          "X-Dossier-Index": "0",
        },
      },
      cookie,
    );

    debug(
      `Logout: HTTP ${logoutResponse.response.status}, url=${logoutResponse.url}`,
    );
  } catch (error) {
    debug(`Logout failed: ${(error as Error).message}`);
  }
}

export async function login(
  config: Config,
  debug: (message: string) => void,
): Promise<string> {
  debug(
    `Env present: userId length=${config.userId.length}, password length=${config.password.length}`,
  );

  let home: CookieFetchResult | undefined;
  try {
    home = await fetchWithCookieJar(HOME_URL, {
      headers: {
        ...browserHeaders,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
  } catch (error) {
    if (!config.syntheticCookies) throw error;
    debug(
      `Preflight failed, using synthetic cookies: ${(error as Error).message}`,
    );
  }
  const generatedCookie =
    config.syntheticCookies && !home?.cookie ? syntheticPublicCookies() : "";
  const loginRequestCookie = mergeCookieHeaders(generatedCookie, home?.cookie);

  debug(
    home
      ? `Preflight: HTTP ${home.response.status}, cookies=${
          cookieNamesFromHeader(home.cookie).join(", ") || "(none)"
        }`
      : "Preflight: skipped after fetch failure",
  );
  debug(
    `Synthetic cookies: ${
      cookieNamesFromHeader(generatedCookie).join(", ") || "(none)"
    }`,
  );
  debug(
    `Login request cookies: ${
      cookieNamesFromHeader(loginRequestCookie).join(", ") || "(none)"
    }`,
  );

  const loginResponse = await fetchWithCookieJar(
    LOGIN_URL,
    {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        userId: config.userId,
        password: config.password,
      }),
    },
    loginRequestCookie,
  );

  const body = await loginResponse.response.text();
  const loginCookie = cookieHeaderFromSetCookies(
    getSetCookieHeaders(loginResponse.response),
  );
  debug(
    `Login response: HTTP ${loginResponse.response.status}, set-cookie=${
      cookieNamesFromHeader(loginCookie).join(", ") || "(none)"
    }`,
  );

  if (!loginResponse.response.ok) {
    let issue = body;
    try {
      const parsed = JSON.parse(body) as {
        issues?: Array<{ code?: string; reason?: string }>;
      };
      issue =
        parsed.issues
          ?.map((entry) => entry.code || entry.reason)
          .filter(Boolean)
          .join(", ") || body;
    } catch {}

    throw new Error(
      `Login failed: HTTP ${loginResponse.response.status} ${issue}`,
    );
  }

  const cookie = mergeCookieHeaders(loginResponse.cookie, loginCookie);
  debug(
    `Portfolio request cookies: ${cookieNamesFromHeader(cookie).join(", ")}`,
  );
  return cookie;
}

async function main(): Promise<void> {
  let authenticatedCookie = "";
  const config = await configFromArgsAndEnv();
  const debug = makeLogger(config);

  try {
    if (config.command === "enrichment") {
      if (!config.query) throw new Error("Missing enrichment source URL.");
      const report = await fetchEnrichmentReport({
        url: config.query,
        ...(config.enrichmentTitle === undefined
          ? {}
          : { finecoTitle: config.enrichmentTitle }),
      });
      await emitOutput(
        config.outPath ? report.markdown : renderJsonOutput(report),
        config.outPath,
      );
      if (config.outPath) debug(`Output saved to ${config.outPath}`);
      return;
    }

    if (config.command === "zero-commission-etfs") {
      const zeroCommissionEtfs = await fetchZeroCommissionEtfs({
        debug,
        ...(config.query === undefined ? {} : { query: config.query }),
      });
      if (!zeroCommissionEtfs.ok) throw new Error(zeroCommissionEtfs.error);
      await emitOutput(
        renderJsonOutput(zeroCommissionEtfs.data),
        config.outPath,
      );
      if (config.outPath) debug(`Output saved to ${config.outPath}`);
      return;
    }

    authenticatedCookie = await login(config, debug);
    if (config.command === "portfolio") {
      const summary = await fetchPositionsSummary(
        config,
        authenticatedCookie,
        debug,
      );
      if (!summary.ok) throw new Error(summary.error);
      await emitOutput(
        renderOutput(summary.data, config.output),
        config.outPath,
      );
    } else if (config.command === "search-asset") {
      const search = await searchAssets(config, authenticatedCookie, debug);
      if (!search.ok) throw new Error(search.error);
      await emitOutput(renderJsonOutput(search.data), config.outPath);
    } else if (config.command === "asset-details") {
      const details = await fetchAssetDetails(
        config,
        authenticatedCookie,
        debug,
      );
      if (!details.ok) throw new Error(details.error);
      await emitOutput(renderJsonOutput(details.data), config.outPath);
    } else if (config.command === "market-indices") {
      const indices = await fetchMarketIndices(
        config,
        authenticatedCookie,
        debug,
      );
      if (!indices.ok) throw new Error(indices.error);
      await emitOutput(renderJsonOutput(indices.data), config.outPath);
    } else if (config.command === "tax-carry-forward") {
      const taxCarryForward = await fetchTaxCarryForward(
        config,
        authenticatedCookie,
        debug,
      );
      if (!taxCarryForward.ok) throw new Error(taxCarryForward.error);
      await emitOutput(renderJsonOutput(taxCarryForward.data), config.outPath);
    } else if (config.command === "tax-minus-by-year") {
      const taxMinusByYear = await fetchTaxMinusByYear(
        config,
        authenticatedCookie,
        debug,
      );
      if (!taxMinusByYear.ok) throw new Error(taxMinusByYear.error);
      await emitOutput(renderJsonOutput(taxMinusByYear.data), config.outPath);
    } else if (config.command === "order-monitor") {
      const orderMonitor = await fetchOrderMonitor(
        config,
        authenticatedCookie,
        debug,
      );
      if (!orderMonitor.ok) throw new Error(orderMonitor.error);
      await emitOutput(renderJsonOutput(orderMonitor.data), config.outPath);
    } else if (config.command === "order-monitor-filters") {
      const orderMonitorFilters = await fetchOrderMonitorFilters(
        config,
        authenticatedCookie,
        debug,
      );
      if (!orderMonitorFilters.ok) {
        throw new Error(orderMonitorFilters.error);
      }
      await emitOutput(
        renderJsonOutput(orderMonitorFilters.data),
        config.outPath,
      );
    } else if (config.command === "movements") {
      const movements = await fetchMovements(
        config,
        authenticatedCookie,
        debug,
      );
      if (!movements.ok) throw new Error(movements.error);
      await emitOutput(renderJsonOutput(movements.data), config.outPath);
    } else {
      const exhaustiveCheck: never = config.command;
      throw new Error(`Unsupported command: ${exhaustiveCheck}`);
    }
    if (config.outPath) debug(`Output saved to ${config.outPath}`);
  } finally {
    await logout(authenticatedCookie, debug);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((error: unknown) => {
    console.error((error as Error).message);
    if (error instanceof UsageError) {
      console.error(`\n${usage()}`);
    }
    process.exit(1);
  });
}
