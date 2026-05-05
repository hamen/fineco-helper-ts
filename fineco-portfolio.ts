import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

export type OutputFormat =
  | "json"
  | "raw"
  | "csv"
  | "html"
  | "shareable-html"
  | "shareable-csv";

type CliArgs =
  | {
      kind: "empty";
      format: OutputFormat | undefined;
      outPath: string | undefined;
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
    }
  | {
      kind: "onePassword";
      itemName: string;
      format: OutputFormat | undefined;
      outPath: string | undefined;
    };

export type Config = {
  userId: string;
  password: string;
  debug: boolean;
  output: OutputFormat;
  outPath: string | undefined;
  positionsUrl: string;
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

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

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
  npm start -- USER PASSWORD [--format json|raw|csv|html|shareable-html|shareable-csv] [--out path]
  npm start -- --op-item "Fineco" [--format json|raw|csv|html|shareable-html|shareable-csv] [--out path]

Credentials:
  USER PASSWORD          Fineco user id and password.
  --op-item ITEM         Read username/password from a 1Password CLI item.
  FINECO_USER_ID/PASSWORD and FINECO_OP_ITEM work too.

Output:
  --format FORMAT        json, raw, csv, html, shareable-html, or shareable-csv. Default: json.
  --out PATH             Write output to a file instead of stdout.

Examples:
  npm start -- 12345678 'secret'
  npm start -- --op-item Fineco --format html > portfolio-report.html
  npm start -- --op-item Fineco --format shareable-html > shareable-report.html
  npm start -- --op-item Fineco --format shareable-csv > shareable-positions.csv
  npm start -- 12345678 'secret' --format csv --out positions.csv
`;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  let itemName: string | undefined;
  let format: OutputFormat | undefined;
  let outPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--help" || arg === "-h") return { kind: "help" };

    if (arg === "--op-item") {
      itemName = argv[index + 1];
      if (!itemName || itemName.startsWith("--")) {
        throw new Error("Expected item name after --op-item.");
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--op-item=")) {
      itemName = arg.slice("--op-item=".length);
      if (!itemName) throw new Error("Expected item name after --op-item.");
      continue;
    }

    if (arg === "--format") {
      format = parseOutputFormat(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--format=")) {
      format = parseOutputFormat(arg.slice("--format=".length));
      continue;
    }

    if (arg === "--out") {
      outPath = argv[index + 1];
      if (!outPath || outPath.startsWith("--")) {
        throw new Error("Expected path after --out.");
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--out=")) {
      outPath = arg.slice("--out=".length);
      if (!outPath) throw new Error("Expected path after --out.");
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    positional.push(arg);
  }

  if (itemName && positional.length > 0) {
    throw new Error("Use either USER PASSWORD or --op-item ITEM, not both.");
  }

  if (itemName) return { kind: "onePassword", itemName, format, outPath };
  if (positional.length === 0) return { kind: "empty", format, outPath };
  if (positional.length === 2) {
    return {
      kind: "credentials",
      userId: positional[0]!,
      password: positional[1]!,
      format,
      outPath,
    };
  }

  throw new Error("Expected USER PASSWORD or --op-item ITEM.");
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

  const opItemName =
    args.kind === "onePassword" ? args.itemName : process.env.FINECO_OP_ITEM;
  if ((!userId || !password) && opItemName) {
    try {
      ({ userId, password } = await credentialsFrom1Password(opItemName));
    } catch (error) {
      throw new Error(
        `Could not read 1Password item "${opItemName}": ${(error as Error).message}`,
      );
    }
  }

  if (!userId || !password) {
    throw new Error("Missing Fineco credentials.");
  }

  return {
    userId,
    password,
    debug: process.env.FINECO_DEBUG === "1",
    output: args.format ?? parseOutputFormat(process.env.FINECO_OUTPUT),
    outPath: args.outPath,
    positionsUrl: process.env.FINECO_POSITIONS_URL ?? POSITIONS_SUMMARY_URL,
    syntheticCookies: process.env.FINECO_SYNTHETIC_COOKIES !== "0",
  };
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
    const response = await fetch(currentUrl, {
      ...options,
      redirect: "manual",
      headers: {
        ...(options.headers ?? {}),
        ...(currentCookie ? { Cookie: currentCookie } : {}),
      },
    });

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

function shareableRows(
  summary: PositionsSummary,
): Array<Record<string, string>> {
  const rows = positionsAsRows(summary);
  const total = summary.summary?.show ?? summary.summary?.total ?? {};
  const totalMarketValue = total.marketValue ?? 0;

  return [...rows]
    .sort((a, b) => (b.marketValue ?? 0) - (a.marketValue ?? 0))
    .map((position) => {
      const weight =
        totalMarketValue > 0 && typeof position.marketValue === "number"
          ? (position.marketValue / totalMarketValue) * 100
          : undefined;

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
          <div class="meta">${htmlEscape(position.symbol || position.instrId)} · ${htmlEscape(position.venueSystem)} · ${htmlEscape(position.type)}</div>
        </td>
        <td class="num">${formatNumber(position.qty, { maximumFractionDigits: 6 })}</td>
        <td class="num">${formatMoney(position.avgPrice, position.currencyCd)}</td>
        <td class="num">${formatMoney(position.marketPrice, position.currencyCd)}</td>
        <td class="num">${formatMoney(position.bookValue)}</td>
        <td class="num strong">${formatMoney(position.marketValue)}</td>
        <td class="num ${profitClass}">${formatMoney(position.profitLoss)}</td>
        <td class="num ${profitClass}">${formatPercent(position.profitLossPerc)}</td>
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
        <div class="subtle">${rows.length} positions · ${htmlEscape(currencies.join(", "))}</div>
      </div>
      <div class="captured">Captured<br>${htmlEscape(capturedAtText)}</div>
    </header>

    <section class="cards" aria-label="Portfolio summary">
      <div class="card"><div class="label">Book Value</div><div class="value">${formatMoney(total.bookValue, total.currencyCd)}</div></div>
      <div class="card"><div class="label">Market Value</div><div class="value">${formatMoney(total.marketValue, total.currencyCd)}</div></div>
      <div class="card"><div class="label">Profit / Loss</div><div class="value ${(total.profitLoss ?? 0) > 0 ? "positive" : (total.profitLoss ?? 0) < 0 ? "negative" : ""}">${formatMoney(total.profitLoss, total.currencyCd)}</div></div>
      <div class="card"><div class="label">Return</div><div class="value ${(total.profitLossPerc ?? 0) > 0 ? "positive" : (total.profitLossPerc ?? 0) < 0 ? "negative" : ""}">${formatPercent(total.profitLossPerc)}</div></div>
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
          <div class="meta">${htmlEscape(position.symbol || position.instrId)} · ${htmlEscape(position.venueSystem)} · ${htmlEscape(position.type)}</div>
        </td>
        <td class="num strong">${formatPercent(weight)}</td>
        <td class="num ${profitClass}">${formatPercent(position.profitLossPerc)}</td>
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
        <div class="subtle">${rows.length} positions · ${htmlEscape(currencies.join(", "))}</div>
      </div>
      <div class="captured">Captured<br>${htmlEscape(capturedAtText)}</div>
    </header>

    <section class="cards" aria-label="Portfolio summary">
      <div class="card"><div class="label">Portfolio Return</div><div class="value ${(total.profitLossPerc ?? 0) > 0 ? "positive" : (total.profitLossPerc ?? 0) < 0 ? "negative" : ""}">${formatPercent(total.profitLossPerc)}</div></div>
      <div class="card"><div class="label">Positions</div><div class="value">${rows.length}</div></div>
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

function renderOutput(summary: PositionsSummary, format: OutputFormat): string {
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

  return JSON.stringify(
    {
      summary: summary.summary,
      rows,
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
        "X-Account-Index": "0",
        "X-Dossier-Index": "0",
      },
    },
    cookie,
  );

  const body = await positions.response.text();
  debug(
    `Positions summary API: HTTP ${positions.response.status}, url=${positions.url}, bytes=${body.length}`,
  );

  if (!positions.response.ok) {
    return {
      ok: false,
      error: `Positions summary API failed: HTTP ${positions.response.status} ${body.slice(0, 500)}`,
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

  const home = await fetchWithCookieJar(HOME_URL, {
    headers: {
      ...browserHeaders,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  const generatedCookie =
    config.syntheticCookies && !home.cookie ? syntheticPublicCookies() : "";
  const loginRequestCookie = mergeCookieHeaders(generatedCookie, home.cookie);

  debug(
    `Preflight: HTTP ${home.response.status}, cookies=${cookieNamesFromHeader(home.cookie).join(", ") || "(none)"}`,
  );
  debug(
    `Synthetic cookies: ${cookieNamesFromHeader(generatedCookie).join(", ") || "(none)"}`,
  );
  debug(
    `Login request cookies: ${cookieNamesFromHeader(loginRequestCookie).join(", ") || "(none)"}`,
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
    `Login response: HTTP ${loginResponse.response.status}, set-cookie=${cookieNamesFromHeader(loginCookie).join(", ") || "(none)"}`,
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
    authenticatedCookie = await login(config, debug);
    const summary = await fetchPositionsSummary(
      config,
      authenticatedCookie,
      debug,
    );
    if (!summary.ok) throw new Error(summary.error);

    await emitOutput(renderOutput(summary.data, config.output), config.outPath);
    if (config.outPath) debug(`Output saved to ${config.outPath}`);
  } finally {
    await logout(authenticatedCookie, debug);
  }
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main().catch((error: unknown) => {
    console.error(`${(error as Error).message}\n`);
    console.error(usage());
    process.exit(1);
  });
}
