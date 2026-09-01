import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  seenHeaders?: { value?: Headers },
): Promise<ToolText> {
  const originalFetch = globalThis.fetch;
  const originalUser = process.env.FINECO_USER_ID;
  const originalPassword = process.env.FINECO_PASSWORD;

  process.env.FINECO_USER_ID = "test";
  process.env.FINECO_PASSWORD = "test";

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (seenHeaders && !url.includes("/authentications/")) {
      seenHeaders.value = new Headers(init?.headers);
    }
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

  for (const tool of ["get_dividends", "get_movements"]) {
    it(`explains the SCA window on a 451 from ${tool}`, async () => {
      // Both movement tools reach the same endpoint, and the explanation has to
      // survive to the tool response on each of them, not only in fetchMovements.
      const result = await callTool(
        tool,
        RANGE,
        () => new Response("Sca di sessione non valida", { status: 451 }),
      );

      assert.ok(result.content[0]!.text.includes("90 days"));
    });
  }

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

  it("parses the HTTP-date form of Retry-After at the tool level", async () => {
    const when = new Date(Date.now() + 45_000).toUTCString();
    const result = await callTool(
      "get_movements",
      RANGE,
      () =>
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": when },
        }),
    );

    const text = result.content[0]!.text;
    assert.ok(text.includes("retryAfterSeconds"), text);
    const parsed = JSON.parse(text.slice(text.indexOf("{"))) as {
      retryAfterSeconds: number;
    };
    // toUTCString() drops milliseconds, so the value lands at 44 or 45. The bound
    // that matters is that it is a finite, non-negative number: a loose upper
    // bound would let NaN or an absurd wait through.
    assert.ok(Number.isFinite(parsed.retryAfterSeconds));
    assert.ok(parsed.retryAfterSeconds >= 0);
    assert.ok(parsed.retryAfterSeconds <= 45);
  });

  it("omits retryAfterSeconds when the header is absent or unparseable", async () => {
    for (const headers of [{}, { "retry-after": "soon" }]) {
      const result = await callTool(
        "get_movements",
        RANGE,
        () => new Response("slow down", { status: 429, headers }),
      );

      const text = result.content[0]!.text;
      assert.ok(!text.includes("retryAfterSeconds"), text);
      // The status still travels, so the caller knows it was rate limited.
      assert.ok(text.includes("429"), text);
    }
  });
});

describe("MCP per-call account and dossier index", () => {
  it("reaches the wire from get_movements", async () => {
    const seen: { value?: Headers } = {};

    await callTool(
      "get_movements",
      { ...RANGE, account_index: 2, dossier_index: 3 },
      () =>
        new Response(JSON.stringify({ movimenti: [], lastPage: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      seen,
    );

    assert.equal(seen.value?.get("x-account-index"), "2");
    assert.equal(seen.value?.get("x-dossier-index"), "3");
  });

  it("reaches the wire from get_dividends", async () => {
    const seen: { value?: Headers } = {};

    await callTool(
      "get_dividends",
      { ...RANGE, account_index: 4, dossier_index: 5 },
      () =>
        new Response(JSON.stringify({ movimenti: [], lastPage: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      seen,
    );

    assert.equal(seen.value?.get("x-account-index"), "4");
    assert.equal(seen.value?.get("x-dossier-index"), "5");
  });

  it("reaches the wire from get_portfolio", async () => {
    const seen: { value?: Headers } = {};

    await callTool(
      "get_portfolio",
      { account_index: 6, dossier_index: 7 },
      () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      seen,
    );

    assert.equal(seen.value?.get("x-account-index"), "6");
    assert.equal(seen.value?.get("x-dossier-index"), "7");
  });

  it("reaches the wire from generate_report", async () => {
    const seen: { value?: Headers } = {};
    const reportDir = await mkdtemp(join(tmpdir(), "fineco-"));
    const reportPath = join(reportDir, "r.html");

    try {
      await callTool(
        "generate_report",
        { output_path: reportPath, account_index: 8, dossier_index: 9 },
        () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        seen,
      );

      assert.equal(seen.value?.get("x-account-index"), "8");
      assert.equal(seen.value?.get("x-dossier-index"), "9");
    } finally {
      // This tool writes a real file; a header check should not leave one behind.
      // The file alone left the mkdtemp directory behind on every run.
      await rm(reportDir, { recursive: true, force: true });
    }
  });

  it("prefers the per-call value over the environment", async () => {
    const original = process.env.FINECO_ACCOUNT_INDEX;
    process.env.FINECO_ACCOUNT_INDEX = "1";
    const seen: { value?: Headers } = {};

    try {
      await callTool(
        "get_movements",
        { ...RANGE, account_index: 9 },
        () =>
          new Response(JSON.stringify({ movimenti: [], lastPage: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        seen,
      );

      assert.equal(seen.value?.get("x-account-index"), "9");
    } finally {
      if (original === undefined) delete process.env.FINECO_ACCOUNT_INDEX;
      else process.env.FINECO_ACCOUNT_INDEX = original;
    }
  });

  it("uses the environment when no per-call value is given, and 0 with neither", async () => {
    const original = process.env.FINECO_ACCOUNT_INDEX;
    const respond = () =>
      new Response(JSON.stringify({ movimenti: [], lastPage: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    try {
      process.env.FINECO_ACCOUNT_INDEX = "5";
      const fromEnv: { value?: Headers } = {};
      await callTool("get_movements", RANGE, respond, fromEnv);
      assert.equal(fromEnv.value?.get("x-account-index"), "5");

      delete process.env.FINECO_ACCOUNT_INDEX;
      const fromDefault: { value?: Headers } = {};
      await callTool("get_movements", RANGE, respond, fromDefault);
      assert.equal(fromDefault.value?.get("x-account-index"), "0");
    } finally {
      if (original === undefined) delete process.env.FINECO_ACCOUNT_INDEX;
      else process.env.FINECO_ACCOUNT_INDEX = original;
    }
  });
});

describe("MCP date range validation", () => {
  // Zod only enforces the YYYY-MM-DD shape; the ordering check lives in
  // parseDateRange, and nothing reached it through a tool before this.
  const neverCalled = () => {
    throw new Error("the tool should not have reached the network");
  };

  for (const tool of ["get_movements", "get_dividends"]) {
    it(`rejects an inverted range in ${tool}`, async () => {
      const result = await callTool(
        tool,
        { date_from: "2026-03-31", date_to: "2026-01-01" },
        neverCalled,
      );

      assert.ok(
        result.content[0]!.text.includes("on or before"),
        result.content[0]!.text,
      );
    });
  }
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

describe("get_movements success payload", () => {
  // Only the 429/451 and index paths were asserted at the tool: a 200 could have
  // returned any shape at all and no test would have noticed.
  it("returns the rows, the count, and both balances", async () => {
    const result = await callTool(
      "get_movements",
      RANGE,
      () =>
        new Response(
          JSON.stringify({
            movimenti: [
              {
                dataOperazione: "2026-01-02",
                descrizione: "Div.su 100 EXAMPLE SPA",
                importo: 147.73,
                causaleMovimento: "DII",
              },
            ],
            lastPage: true,
            balanceAccountAtSearchDate: 1234.56,
            balanceAccountAtMovement: 1000,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const payload = JSON.parse(result.content[0]!.text) as {
      count: number;
      dateFrom: string;
      dateTo: string;
      limitedResult: boolean;
      balanceAccountAtSearchDate: number;
      balanceAccountAtMovement: number;
      movimenti: Array<{ descrizione?: string; importo: number }>;
    };

    assert.equal(payload.count, 1);
    assert.equal(payload.movimenti.length, 1);
    assert.equal(payload.movimenti[0]!.importo, 147.73);
    assert.equal(payload.movimenti[0]!.descrizione, "Div.su 100 EXAMPLE SPA");
    assert.equal(payload.dateFrom, RANGE.date_from);
    assert.equal(payload.dateTo, RANGE.date_to);
    assert.equal(payload.limitedResult, false);
    assert.equal(payload.balanceAccountAtSearchDate, 1234.56);
    assert.equal(payload.balanceAccountAtMovement, 1000);
  });
});

describe("MCP calendar dates", () => {
  // The zod schema only checks the YYYY-MM-DD shape. `isIsoDate` is what rejects
  // a day that does not exist, and nothing asserted that at the tool.
  it("rejects a date that passes the shape check but is not a real day", async () => {
    let reachedNetwork = false;

    const result = await callTool(
      "get_movements",
      { date_from: "2026-02-30", date_to: "2026-03-31" },
      () => {
        reachedNetwork = true;
        return new Response(JSON.stringify({ movimenti: [], lastPage: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    assert.equal(reachedNetwork, false);
    assert.match(result.content[0]!.text, /must (use|be in) YYYY-MM-DD format/);
  });
});

describe("MCP index env misconfiguration", () => {
  // envIndex throws on a non-integer value, and buildConfig runs outside the
  // handler's try. The SDK still turns that into an isError tool result rather
  // than a protocol error, and this pins that: the caller must be told what is
  // wrong with its configuration, and no request may go out.
  for (const tool of ["get_portfolio", "get_movements"]) {
    it(`reports a bad FINECO_ACCOUNT_INDEX as a tool error from ${tool}`, async () => {
      const original = process.env.FINECO_ACCOUNT_INDEX;
      process.env.FINECO_ACCOUNT_INDEX = "abc";
      let reachedNetwork = false;

      try {
        const result = await callTool(
          tool,
          tool === "get_movements" ? RANGE : {},
          () => {
            reachedNetwork = true;
            return new Response(
              JSON.stringify({ movimenti: [], lastPage: true }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          },
        );

        assert.equal(reachedNetwork, false);
        assert.match(result.content[0]!.text, /non-negative integer/);
      } finally {
        if (original === undefined) delete process.env.FINECO_ACCOUNT_INDEX;
        else process.env.FINECO_ACCOUNT_INDEX = original;
      }
    });
  }
});
