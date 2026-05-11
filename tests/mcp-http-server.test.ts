import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createFinecoMcpHttpServer } from "../mcp-http-server.js";

describe("MCP HTTP server", () => {
  it("serves tools over Streamable HTTP", async () => {
    const server = createFinecoMcpHttpServer({ path: "/mcp" });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${address.port}/mcp`),
    );
    const client = new Client({ name: "test-http-client", version: "0.1.0" });

    try {
      await client.connect(transport as Transport);
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();

      assert.deepEqual(names, [
        "fineco_logout",
        "fineco_session_status",
        "generate_report",
        "get_asset_details",
        "get_market_indices",
        "get_portfolio",
        "get_tax_carry_forward",
        "get_tax_minus_by_year",
        "get_zero_commission_etfs",
        "search_asset",
      ]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
