import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";

import {
  createFinecoMcpServer,
  shutdownFinecoMcpSession,
} from "./fineco-mcp.js";

export type FinecoMcpHttpServerOptions = {
  path?: string;
};

export type FinecoMcpHttpServerStartOptions = FinecoMcpHttpServerOptions & {
  host?: string;
  port?: number;
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3333;
const DEFAULT_PATH = "/mcp";

function normalizePath(path: string | undefined): string {
  if (!path) return DEFAULT_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return body.length === 0 ? undefined : JSON.parse(body);
}

function writeJsonRpcError(
  response: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

export function createFinecoMcpHttpServer(
  options: FinecoMcpHttpServerOptions = {},
): Server {
  const path = normalizePath(options.path);

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== path) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    if (request.method !== "POST") {
      response.writeHead(405, {
        allow: "POST",
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Method not allowed. Use POST for MCP requests.",
          },
          id: null,
        }),
      );
      return;
    }

    const server = createFinecoMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    } as unknown as ConstructorParameters<
      typeof StreamableHTTPServerTransport
    >[0]);

    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      const body = await readJsonBody(request);
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        writeJsonRpcError(
          response,
          400,
          -32700,
          (error as Error).message || "Invalid JSON-RPC request",
        );
      }
    }
  });
}

function readPort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT;
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid FINECO_MCP_PORT value: ${value}`);
  }
  return port;
}

export async function startFinecoMcpHttpServer(
  options: FinecoMcpHttpServerStartOptions = {},
): Promise<Server> {
  const host = options.host ?? process.env.FINECO_MCP_HOST ?? DEFAULT_HOST;
  const port = options.port ?? readPort(process.env.FINECO_MCP_PORT);
  const path = normalizePath(options.path ?? process.env.FINECO_MCP_PATH);
  const server = createFinecoMcpHttpServer({ path });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  console.error(
    `fineco-helper MCP HTTP listening on http://${host}:${port}${path}`,
  );
  return server;
}

function installHttpShutdownHandlers(server: Server): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => {
        void shutdownFinecoMcpSession().finally(() => process.exit(0));
      });
    });
  }
}

const isEntrypoint = process.argv[1] === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const server = await startFinecoMcpHttpServer();
  installHttpShutdownHandlers(server);
}
