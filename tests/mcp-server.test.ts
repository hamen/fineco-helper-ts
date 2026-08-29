import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function spawnServer(env?: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp-server.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
}

describe("MCP server", () => {
  it("exposes portfolio and market tools", async () => {
    const transport = spawnServer({
      FINECO_USER_ID: "test",
      FINECO_PASSWORD: "test",
    });
    const client = new Client({ name: "test-client", version: "0.1.0" });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      assert.deepEqual(names, [
        "fineco_logout",
        "fineco_session_status",
        "generate_report",
        "get_asset_details",
        "get_dividends",
        "get_enrichment",
        "get_market_indices",
        "get_movements",
        "get_order_monitor",
        "get_order_monitor_filters",
        "get_portfolio",
        "get_tax_carry_forward",
        "get_tax_minus_by_year",
        "get_zero_commission_etfs",
        "search_asset",
      ]);
      assert.equal(tools.length, 15);

      // Verify get_portfolio has format parameter
      const getPf = tools.find((t) => t.name === "get_portfolio")!;
      assert.ok(
        JSON.stringify(getPf.inputSchema).includes("format"),
        "get_portfolio should have a format parameter",
      );

      // Verify generate_report has output_path parameter
      const genRpt = tools.find((t) => t.name === "generate_report")!;
      assert.ok(
        JSON.stringify(genRpt.inputSchema).includes("output_path"),
        "generate_report should have an output_path parameter",
      );

      // The date range is required on both movement tools, and the optional index
      // params have to be present or a caller cannot reach a second dossier.
      for (const name of ["get_movements", "get_dividends"]) {
        const tool = tools.find((t) => t.name === name)!;
        const schema = tool.inputSchema as {
          properties?: Record<string, unknown>;
          required?: string[];
        };

        assert.deepEqual(
          [...(schema.required ?? [])].sort(),
          ["date_from", "date_to"],
          `${name} should require date_from and date_to`,
        );
        assert.ok(
          schema.properties?.["account_index"] !== undefined &&
            schema.properties["dossier_index"] !== undefined,
          `${name} should accept account_index and dossier_index`,
        );
      }

      const search = tools.find((t) => t.name === "search_asset")!;
      assert.ok(
        JSON.stringify(search.inputSchema).includes("query"),
        "search_asset should have a query parameter",
      );

      const details = tools.find((t) => t.name === "get_asset_details")!;
      assert.ok(
        JSON.stringify(details.inputSchema).includes("instrument"),
        "get_asset_details should have an instrument parameter",
      );

      const status = tools.find((t) => t.name === "fineco_session_status")!;
      assert.ok(status, "fineco_session_status should be exposed");

      const logout = tools.find((t) => t.name === "fineco_logout")!;
      assert.ok(logout, "fineco_logout should be exposed");

      const zeroCommission = tools.find(
        (t) => t.name === "get_zero_commission_etfs",
      )!;
      assert.ok(zeroCommission, "get_zero_commission_etfs should be exposed");
      assert.ok(
        JSON.stringify(zeroCommission.inputSchema).includes("query"),
        "get_zero_commission_etfs should have an optional query parameter",
      );

      const enrichment = tools.find((t) => t.name === "get_enrichment")!;
      assert.ok(enrichment, "get_enrichment should be exposed");
      assert.ok(
        JSON.stringify(enrichment.inputSchema).includes("fineco_title"),
        "get_enrichment should have an optional fineco_title parameter",
      );
      assert.equal(
        JSON.stringify(enrichment.inputSchema).includes("markdown"),
        false,
        "get_enrichment should not expose Markdown through MCP",
      );

      const taxCarryForward = tools.find(
        (t) => t.name === "get_tax_carry_forward",
      )!;
      assert.ok(taxCarryForward, "get_tax_carry_forward should be exposed");
      assert.ok(
        JSON.stringify(taxCarryForward.inputSchema).includes("date_from"),
        "get_tax_carry_forward should have a date_from parameter",
      );
      assert.ok(
        JSON.stringify(taxCarryForward.inputSchema).includes("date_to"),
        "get_tax_carry_forward should have a date_to parameter",
      );

      const taxMinusByYear = tools.find(
        (t) => t.name === "get_tax_minus_by_year",
      )!;
      assert.ok(taxMinusByYear, "get_tax_minus_by_year should be exposed");

      const orderMonitor = tools.find((t) => t.name === "get_order_monitor")!;
      assert.ok(orderMonitor, "get_order_monitor should be exposed");
      assert.ok(
        JSON.stringify(orderMonitor.inputSchema).includes("days"),
        "get_order_monitor should have an optional days parameter",
      );

      const orderMonitorFilters = tools.find(
        (t) => t.name === "get_order_monitor_filters",
      )!;
      assert.ok(
        orderMonitorFilters,
        "get_order_monitor_filters should be exposed",
      );
    } finally {
      await client.close();
    }
  });

  it("reports session status without logging in", async () => {
    const transport = spawnServer({
      FINECO_USER_ID: "test",
      FINECO_PASSWORD: "test",
    });
    const client = new Client({ name: "test-client", version: "0.1.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "fineco_session_status",
        arguments: {},
      });

      assert.equal(result.isError, undefined);
      const text =
        (result.content as Array<{ type: string; text: string }>)[0]?.text ??
        "";
      const status = JSON.parse(text) as {
        authenticated: boolean;
        loginInFlight: boolean;
        maxAgeMs: number;
        maxIdleMs: number;
      };

      assert.equal(status.authenticated, false);
      assert.equal(status.loginInFlight, false);
      assert.ok(status.maxAgeMs > 0);
      assert.ok(status.maxIdleMs > 0);
    } finally {
      await client.close();
    }
  });

  it("logout is safe when no session exists", async () => {
    const transport = spawnServer({
      FINECO_USER_ID: "test",
      FINECO_PASSWORD: "test",
    });
    const client = new Client({ name: "test-client", version: "0.1.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "fineco_logout",
        arguments: {},
      });

      assert.equal(result.isError, undefined);
      const text =
        (result.content as Array<{ type: string; text: string }>)[0]?.text ??
        "";
      assert.equal(text, "No Fineco session was active.");
    } finally {
      await client.close();
    }
  });

  it("returns error when credentials are missing", async () => {
    const transport = spawnServer(); // no credentials in env
    const client = new Client({ name: "test-client", version: "0.1.0" });

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "get_portfolio",
        arguments: {},
      });

      assert.ok(result.isError, "Expected isError to be true");
      const text =
        (result.content as Array<{ type: string; text: string }>)[0]?.text ??
        "";
      assert.ok(
        text.includes("Credentials missing"),
        `Expected 'Credentials missing' in error, got: ${text}`,
      );
    } finally {
      await client.close();
    }
  });
});
