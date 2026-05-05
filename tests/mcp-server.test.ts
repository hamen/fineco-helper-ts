import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function spawnServer(
  env?: Record<string, string>,
): StdioClientTransport {
  return new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp-server.ts"],
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: process.env.PATH ?? "", ...env },
    stderr: "pipe",
  });
}

describe("MCP server", () => {
  it("exposes get_portfolio and generate_report tools", async () => {
    const transport = spawnServer({
      FINECO_USER_ID: "test",
      FINECO_PASSWORD: "test",
    });
    const client = new Client({ name: "test-client", version: "0.1.0" });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      assert.deepEqual(names, ["generate_report", "get_portfolio"]);
      assert.equal(tools.length, 2);

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
