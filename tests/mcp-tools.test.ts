import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  createFinecoMcpServer,
  shutdownFinecoMcpSession,
} from "../fineco-mcp.js";

type ToolText = { content: Array<{ type: string; text: string }> };

// The session in fineco-mcp.ts is module-global: without the shutdown in the
// finally block a cookie from a previous case skips login entirely and the stub
// below is never reached.
async function callTool(
  name: string,
  args: Record<string, unknown>,
  handler: (url: string) => Response,
): Promise<ToolText> {
  const originalFetch = globalThis.fetch;
  const originalUser = process.env.FINECO_USER_ID;
  const originalPassword = process.env.FINECO_PASSWORD;

  process.env.FINECO_USER_ID = "test";
  process.env.FINECO_PASSWORD = "test";

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/authentications/web/login")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "set-cookie": "session=stub; Path=/" },
      });
    }
    if (url.includes("/authentications/logout")) {
      return new Response("", { status: 200 });
    }
    return handler(url);
  };

  const server = createFinecoMcpServer();
  const client = new Client({ name: "test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    // Both ends of the pair have to be connected.
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return (await client.callTool({
      name,
      arguments: args,
    })) as unknown as ToolText;
  } finally {
    await client.close();
    await server.close();
    await shutdownFinecoMcpSession();
    globalThis.fetch = originalFetch;
    if (originalUser === undefined) delete process.env.FINECO_USER_ID;
    else process.env.FINECO_USER_ID = originalUser;
    if (originalPassword === undefined) delete process.env.FINECO_PASSWORD;
    else process.env.FINECO_PASSWORD = originalPassword;
  }
}

const RANGE = { date_from: "2026-01-01", date_to: "2026-01-31" };

describe("MCP tool error payloads", () => {
  // A fetch-layer assertion passes while the tool still returns a bare error
  // string, so these run at the tool response.
  it("surfaces retryAfterSeconds from a 429 on the JSON API path", async () => {
    const result = await callTool(
      "get_movements",
      RANGE,
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
    );

    const text = result.content[0]!.text;
    assert.ok(text.includes("retryAfterSeconds"), text);
    assert.ok(text.includes("30"), text);
  });

  it("surfaces retryAfterSeconds from a 429 on the positions path", async () => {
    const result = await callTool(
      "get_portfolio",
      {},
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": "45" },
        }),
    );

    const text = result.content[0]!.text;
    assert.ok(text.includes("retryAfterSeconds"), text);
    assert.ok(text.includes("45"), text);
  });

  it("explains the SCA window on a 451 from get_dividends", async () => {
    const result = await callTool(
      "get_dividends",
      RANGE,
      () => new Response("Sca di sessione non valida", { status: 451 }),
    );

    assert.ok(result.content[0]!.text.includes("90 days"));
  });

  it("still reports an expired session rather than a dead tool", async () => {
    // The authExpired arm has to survive the shared error mapper: a 401 must clear
    // the session and tell the caller to retry.
    const result = await callTool(
      "get_dividends",
      RANGE,
      () => new Response("expired", { status: 401 }),
    );

    const text = result.content[0]!.text;
    assert.ok(text.includes("authentication expired"), text);
    assert.ok(text.includes("authExpired"), text);
  });
});

describe("MCP dividend tool", () => {
  it("returns paired dividend events in minor units", async () => {
    const result = await callTool(
      "get_dividends",
      RANGE,
      () =>
        new Response(
          JSON.stringify({
            movimenti: [
              {
                dataOperazione: "2026-01-10",
                importo: 200,
                causaleMovimento: "DII",
                descrizione: "Div.su 100,000 EXAMPLE SPA",
              },
              {
                dataOperazione: "2026-01-10",
                importo: -52,
                causaleMovimento: "DIR",
                descrizione: "Rit.div.su 100,000 EXAMPLE SPA",
              },
            ],
            lastPage: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const report = JSON.parse(result.content[0]!.text) as {
      totals: { netCents: number };
      truncated: boolean;
      assumedCurrency: string;
    };

    assert.equal(report.totals.netCents, 14800);
    assert.equal(report.truncated, false);
    assert.equal(report.assumedCurrency, "EUR");
  });

  it("forwards the truncation flag from a limited page", async () => {
    const result = await callTool(
      "get_dividends",
      RANGE,
      () =>
        new Response(
          JSON.stringify({
            movimenti: [],
            lastPage: true,
            limitedResult: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const report = JSON.parse(result.content[0]!.text) as {
      truncated: boolean;
    };
    assert.equal(report.truncated, true);
  });
});
