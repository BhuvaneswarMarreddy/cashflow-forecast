/**
 * cf-ledger MCP server (stdio). Tools live in tools.ts as plain functions; this file
 * owns the transport, load-dispatch, JSON serialization, the redaction pass and the
 * error contract — the handlers never see fs, firebase or the SDK.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// redactString, NOT redact(): the object walker caps arrays at 50 and destroys keys
// like `email` — it would corrupt tool output. String-level redaction only.
import { redactString } from '@/lib/obs/redact';
import { Ledger, fail, loadLedger } from './load';
import {
  TOOL_DESCRIPTIONS,
  findTransactions, findTransactionsShape,
  getLedgerSummary,
} from './tools';

/**
 * Load-dispatch + serialize + redact + error contract, once for every tool.
 * A handler throw becomes { isError, content:[{type:'text'}] } with the message
 * only — never a stack, which could carry paths and row data into the client.
 */
const wrap = (handler: (ledger: Ledger, args: Record<string, unknown>) => unknown) =>
  async (args: Record<string, unknown> = {}) => {
    const loaded = await loadLedger();
    if (!loaded.ok) return loaded.error;
    try {
      const text = redactString(JSON.stringify(handler(loaded.ledger, args)));
      return { content: [{ type: 'text' as const, text }] };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  };

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'cf-ledger', version: '0.1.0' });

  server.registerTool('get_ledger_summary',
    { description: TOOL_DESCRIPTIONS.get_ledger_summary },
    wrap(getLedgerSummary));

  server.registerTool('find_transactions',
    { description: TOOL_DESCRIPTIONS.find_transactions, inputSchema: findTransactionsShape },
    wrap(findTransactions));

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
