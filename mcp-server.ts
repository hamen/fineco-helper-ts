import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFile } from "node:fs/promises";
import { z } from "zod";

import {
  POSITIONS_SUMMARY_URL,
  credentialsFrom1Password,
  fetchPositionsSummary,
  login,
  logout,
  makeLogger,
  positionsAsRows,
  reportHtml,
  toCsv,
  type Config,
} from "./fineco-portfolio.js";

async function buildConfig(overrides?: {
  outPath?: string;
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
    output: "json",
    outPath: overrides?.outPath ?? undefined,
    positionsUrl: process.env.FINECO_POSITIONS_URL ?? POSITIONS_SUMMARY_URL,
    syntheticCookies: process.env.FINECO_SYNTHETIC_COOKIES !== "0",
  };
}

const server = new McpServer({
  name: "fineco-helper",
  version: "0.1.0",
});

server.tool(
  "get_portfolio",
  "Fetch current Fineco portfolio positions and summary. Returns positions with quantities, prices, market values, P/L, and portfolio totals.",
  {
    format: z
      .enum(["json", "csv"])
      .optional()
      .describe("Output format: json (default) or csv"),
  },
  async ({ format }) => {
    let cookie = "";
    try {
      const config = await buildConfig();
      const debug = makeLogger(config);
      cookie = await login(config, debug);
      const result = await fetchPositionsSummary(config, cookie, debug);

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      const rows = positionsAsRows(result.data);
      const output =
        format === "csv"
          ? toCsv(rows)
          : JSON.stringify(
              {
                summary: result.data.summary,
                positions: rows,
                positionCount: rows.length,
                filters: result.data.filters,
              },
              null,
              2,
            );

      return { content: [{ type: "text" as const, text: output }] };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    } finally {
      if (cookie) {
        const config = await buildConfig();
        await logout(cookie, makeLogger(config));
      }
    }
  },
);

server.tool(
  "generate_report",
  "Generate a styled HTML portfolio report from current Fineco data and save it to a file.",
  {
    output_path: z
      .string()
      .optional()
      .describe("File path for the HTML report (default: portfolio-report.html)"),
  },
  async ({ output_path }) => {
    const reportPath = output_path ?? "portfolio-report.html";
    let cookie = "";
    try {
      const config = await buildConfig({ outPath: reportPath });
      const debug = makeLogger(config);
      cookie = await login(config, debug);
      const result = await fetchPositionsSummary(config, cookie, debug);

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Error: ${result.error}` }],
          isError: true,
        };
      }

      const html = reportHtml(result.data);
      await writeFile(reportPath, html);
      const rows = positionsAsRows(result.data);

      return {
        content: [
          {
            type: "text" as const,
            text: `HTML report saved to ${reportPath} (${rows.length} positions).`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    } finally {
      if (cookie) {
        const config = await buildConfig();
        await logout(cookie, makeLogger(config));
      }
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
