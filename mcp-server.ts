import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createFinecoMcpServer,
  installFinecoMcpShutdownHandlers,
} from "./fineco-mcp.js";

installFinecoMcpShutdownHandlers();

const server = createFinecoMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
