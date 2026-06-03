import { createHash } from "node:crypto";
import vm from "node:vm";

const STOCK_PATH_SUFFIX =
  /\/(valuation|future|past|health|dividend|management|ownership|information)\/?$/;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const ALLOWED_HOST_SHA256 = new Set([
  "b86a6280d91ca65578ced06cd64040a720a2e3c00fe09c09eb38cccfe2a6cfdd",
  "68b6aa599b7ee11a2540b949c894bdc8969bb7d1de983aaf0c6e613f6a5af572",
]);

type QueryState = {
  queries?: Array<{
    queryKey?: unknown[];
    state?: {
      data?: unknown;
    };
  }>;
};

type CompanyInfo = {
  name?: string;
  unique_symbol?: string;
  exchange_symbol?: string;
  isin_symbol?: string;
  country?: string;
  type?: string;
  year_founded?: number | string;
  url?: string;
  description?: string;
};

type CompanyPayload = {
  name?: string;
  unique_symbol?: string;
  exchange_symbol?: string;
  isin_symbol?: string;
  last_updated?: number | string;
  info?: CompanyInfo;
  score?: {
    data?: Record<string, unknown>;
  };
  analysis?: {
    data?: {
      extended?: {
        data?: {
          raw_data?: {
            data?: Record<string, unknown>;
          };
          analysis?: Record<string, unknown>;
          scores?: Record<string, unknown>;
        };
      };
    };
  };
};

export type EnrichmentMatch = {
  finecoTitle: string;
  enrichmentTitle: string;
  score: number;
  verdict: "strong" | "possible" | "weak";
  reasons: string[];
};

export type EnrichmentReport = {
  capturedAt: string;
  sourceUrl: string;
  company: {
    name: string;
    ticker: string;
    exchange: string;
    isin: string;
    country: string;
    website: string;
    description: string;
  };
  scores: Record<string, unknown>;
  metrics: Record<string, Record<string, unknown>>;
  match?: EnrichmentMatch;
  warnings: string[];
  markdown: string;
};

function clean(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function cell(value: unknown): string {
  return clean(value).replace(/\|/g, "\\|");
}

function table(headers: string[], rows: unknown[][]): string {
  const filtered = rows.filter((row) =>
    row.some((value) => value !== "" && value !== null && value !== undefined),
  );
  if (!filtered.length) return "";
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...filtered.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

function formatDate(value: unknown): string {
  if (!value) return "";
  const number = Number(value);
  const timestamp =
    Number.isFinite(number) &&
    number > 1_000_000_000 &&
    number < 100_000_000_000
      ? number * 1000
      : value;
  const date = new Date(timestamp as string | number);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toISOString().slice(0, 10);
}

function formatNumber(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "number") return String(value);
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}b`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}k`;
  return value.toFixed(abs >= 10 ? 2 : 4).replace(/\.?0+$/, "");
}

function formatField(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (
    typeof value === "number" &&
    /date|release|updated|update|filing/i.test(key) &&
    Math.abs(value) > 1_000_000_000
  ) {
    return formatDate(value);
  }
  return formatNumber(value);
}

function titleCaseKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function pickRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function primitiveRows(object: unknown, keys: string[]): string[][] {
  const record = pickRecord(object);
  return keys
    .filter((key) => {
      const value = record[key];
      return (
        value === null || ["string", "number", "boolean"].includes(typeof value)
      );
    })
    .map((key) => [titleCaseKey(key), formatField(key, record[key])]);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedHost(parsed: URL): string {
  return parsed.hostname.toLocaleLowerCase("en").replace(/\.$/, "");
}

function normalizedPath(parsed: URL): string {
  return parsed.pathname.replace(
    /^\/(?:de|en|es|fr|it|ja|ko|nl|sv|tr)(?=\/stocks\/)/,
    "",
  );
}

function validateSourceUrl(parsed: URL): void {
  if (parsed.protocol !== "https:") {
    throw new Error("Enrichment source URL must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Enrichment source URL must not include credentials.");
  }
  if (!ALLOWED_HOST_SHA256.has(sha256(normalizedHost(parsed)))) {
    throw new Error("Enrichment source host is not allowed.");
  }
  if (!normalizedPath(parsed).startsWith("/stocks/")) {
    throw new Error("Enrichment source URL does not look like a stock page.");
  }
}

function canonicalReportUrl(inputUrl: string): string {
  const parsed = new URL(inputUrl);
  validateSourceUrl(parsed);
  parsed.pathname = normalizedPath(parsed).replace(STOCK_PATH_SUFFIX, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function fetchText(
  url: string,
  userAgent = DEFAULT_USER_AGENT,
  validateResponses = true,
): Promise<string> {
  let currentUrl = url;
  for (let redirect = 0; redirect < 8; redirect += 1) {
    if (validateResponses) validateSourceUrl(new URL(currentUrl));

    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en",
        "User-Agent": userAgent,
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, currentUrl);
      if (validateResponses) validateSourceUrl(nextUrl);
      currentUrl = nextUrl.toString();
      continue;
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Enrichment source failed: HTTP ${response.status} ${body.slice(0, 500)}`,
      );
    }
    return body;
  }

  throw new Error(`Too many redirects while fetching enrichment source.`);
}

export function parseEnrichmentState(html: string): QueryState {
  const match = html.match(
    /<script>window\.__REACT_QUERY_STATE__ = ([\s\S]*?)<\/script>/,
  );
  if (!match) {
    throw new Error(
      "Could not find the embedded query cache in the page HTML.",
    );
  }

  const sandbox = { window: {} as { __REACT_QUERY_STATE__?: QueryState } };
  vm.createContext(sandbox);
  vm.runInContext(`window.__REACT_QUERY_STATE__ = ${match[1]}`, sandbox);
  return sandbox.window.__REACT_QUERY_STATE__ ?? {};
}

function query(state: QueryState, name: string): unknown {
  return state.queries?.find((entry) => entry.queryKey?.[0] === name)?.state
    ?.data;
}

function collectData(state: QueryState) {
  const companyRoot = pickRecord(query(state, "company"));
  const company = pickRecord(companyRoot.data) as CompanyPayload;
  const extended = company.analysis?.data?.extended?.data;
  const raw = pickRecord(extended?.raw_data?.data);
  return {
    company,
    raw,
    analysis: pickRecord(extended?.analysis),
    scores: pickRecord(extended?.scores ?? company.score?.data),
  };
}

function stopwords(): Set<string> {
  return new Set([
    "spa",
    "s",
    "p",
    "a",
    "sa",
    "ag",
    "nv",
    "plc",
    "ltd",
    "limited",
    "inc",
    "corp",
    "corporation",
    "company",
    "co",
    "ordinary",
    "shares",
    "stock",
    "adr",
    "the",
    "and",
    "di",
    "de",
    "del",
  ]);
}

function tokens(value: string): string[] {
  const ignored = stopwords();
  return clean(value)
    .normalize("NFKD")
    .toLocaleLowerCase("en")
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !ignored.has(token));
}

export function matchEnrichmentTitle(
  finecoTitle: string,
  company: EnrichmentReport["company"],
): EnrichmentMatch {
  const enrichmentTitle = [company.name, company.ticker, company.isin]
    .filter(Boolean)
    .join(" ");
  const finecoTokens = new Set(tokens(finecoTitle));
  const sourceTokens = new Set(tokens(enrichmentTitle));
  const overlap = [...finecoTokens].filter((token) => sourceTokens.has(token));
  const ticker = company.ticker.split(":").pop()?.toLocaleLowerCase("en") ?? "";
  const reasons: string[] = [];
  let score = 0;

  if (
    company.isin &&
    finecoTitle
      .toLocaleLowerCase("en")
      .includes(company.isin.toLocaleLowerCase("en"))
  ) {
    score += 0.55;
    reasons.push("ISIN match");
  }
  if (ticker && finecoTokens.has(ticker)) {
    score += 0.35;
    reasons.push("ticker match");
  }
  if (finecoTokens.size > 0) {
    const tokenScore =
      overlap.length / Math.max(finecoTokens.size, sourceTokens.size, 1);
    score += Math.min(0.55, tokenScore);
    if (overlap.length)
      reasons.push(`shared title tokens: ${overlap.join(", ")}`);
  }

  const boundedScore = Math.max(0, Math.min(1, Number(score.toFixed(3))));
  return {
    finecoTitle,
    enrichmentTitle,
    score: boundedScore,
    verdict:
      boundedScore >= 0.7
        ? "strong"
        : boundedScore >= 0.35
          ? "possible"
          : "weak",
    reasons,
  };
}

function sectionMetrics(
  analysis: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const sections = [
    "value",
    "future",
    "past",
    "health",
    "dividend",
    "management",
  ];
  return Object.fromEntries(
    sections.map((section) => [section, pickRecord(analysis[section])]),
  );
}

function reportMarkdown(report: Omit<EnrichmentReport, "markdown">): string {
  const metricSections = Object.entries(report.metrics)
    .map(([section, metrics]) => {
      const rows = primitiveRows(metrics, Object.keys(metrics).slice(0, 16));
      return rows.length
        ? `## ${titleCaseKey(section)}\n\n${table(["Metric", "Value"], rows)}`
        : "";
    })
    .filter(Boolean);

  return [
    `# ${report.company.name || "Enrichment"} Stock Report`,
    "",
    `- Source: ${report.sourceUrl}`,
    `- Exported: ${report.capturedAt}`,
    report.match
      ? `- Fineco title match: ${report.match.verdict} (${report.match.score})`
      : "",
    "",
    "## Company Overview",
    table(
      ["Field", "Value"],
      [
        ["Name", report.company.name],
        ["Ticker", report.company.ticker],
        ["Exchange", report.company.exchange],
        ["ISIN", report.company.isin],
        ["Country", report.company.country],
        ["Website", report.company.website],
      ],
    ),
    report.company.description
      ? `\n### Description\n\n${report.company.description}`
      : "",
    "\n## Scores",
    table(
      ["Area", "Score"],
      Object.entries(report.scores).map(([key, value]) => [
        titleCaseKey(key),
        formatField(key, value),
      ]),
    ),
    ...metricSections,
    report.warnings.length
      ? `## Diagnostics\n\n${report.warnings
          .map((warning) => `- ${warning}`)
          .join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .concat("\n");
}

export async function fetchEnrichmentReport(options: {
  url: string;
  finecoTitle?: string;
  userAgent?: string;
  validateSource?: boolean;
}): Promise<EnrichmentReport> {
  const sourceUrl =
    options.validateSource === false
      ? options.url
      : canonicalReportUrl(options.url);
  const html = await fetchText(
    sourceUrl,
    options.userAgent,
    options.validateSource !== false,
  );
  const state = parseEnrichmentState(html);
  const data = collectData(state);
  const companyInfo = pickRecord(
    data.raw.company_info ?? data.company.info,
  ) as CompanyInfo;
  const company = {
    name: clean(companyInfo.name ?? data.company.name),
    ticker: clean(companyInfo.unique_symbol ?? data.company.unique_symbol),
    exchange: clean(
      companyInfo.exchange_symbol ?? data.company.exchange_symbol,
    ),
    isin: clean(companyInfo.isin_symbol ?? data.company.isin_symbol),
    country: clean(companyInfo.country),
    website: clean(companyInfo.url),
    description: clean(companyInfo.description),
  };
  const warnings = [];
  if (!company.name) warnings.push("Missing company name.");
  if (!Object.keys(data.raw).length) warnings.push("Missing raw company data.");
  if (!Object.keys(data.analysis).length)
    warnings.push("Missing analysis metrics.");
  const baseReport = {
    capturedAt: new Date().toISOString(),
    sourceUrl,
    company,
    scores: data.scores,
    metrics: sectionMetrics(data.analysis),
    ...(options.finecoTitle
      ? { match: matchEnrichmentTitle(options.finecoTitle, company) }
      : {}),
    warnings,
  };

  return {
    ...baseReport,
    markdown: reportMarkdown(baseReport),
  };
}
