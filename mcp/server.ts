// MCP-001 spike: prove the MCP SDK compiles under this repo's tsconfig and a
// stdio server boots. One stub tool only — real ledger tools come after go/no-go.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'cf-ledger', version: '0.0.1' });

  server.registerTool('ping', { description: 'Liveness check' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
  }));

  return server;
}

// Only start stdio when run as a script — the smoke test imports buildServer
// and wires its own InMemoryTransport instead.
if (process.argv[1]?.endsWith('mcp/server.ts')) {
  // stderr only: the stdio transport owns stdout, so any stray console.log
  // would corrupt the JSON-RPC stream.
  buildServer()
    .connect(new StdioServerTransport())
    .then(() => console.error('cf-ledger MCP server on stdio'))
    .catch((err) => {
      console.error('MCP server failed to start:', err);
      process.exit(1);
    });
}
