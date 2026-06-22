"use strict";
/**
 * Generic MCP (Streamable HTTP, stateless) transport for a FoundryNet gateway.
 * Driven by a toolSpecs array: [{ name, price, desc, schema (zod raw shape), fn }].
 * Each tool gates via x402 (fnet_ key bypasses; else returns payment_required),
 * then calls fn(args). Tools/list is never gated (Smithery/Glama scannable).
 */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { gateForMcp } = require("./x402");

function bearerFrom(extra) {
  try {
    const h = (extra && extra.requestInfo && extra.requestInfo.headers) || {};
    const a = h.authorization || h.Authorization || "";
    return a.toLowerCase().startsWith("bearer ") ? a.slice(7).trim() : null;
  } catch { return null; }
}

function buildServer(serviceName, toolSpecs) {
  const server = new McpServer({ name: serviceName, version: "1.0.0" }, { capabilities: {} });
  for (const t of toolSpecs) {
    const schema = { ...t.schema, api_key: t.schema.api_key };
    server.registerTool(t.name, { description: t.desc, inputSchema: t.schema }, async (args, extra) => {
      const gate = gateForMcp(t.name, t.price, t.desc, args.api_key || bearerFrom(extra));
      if (!gate.paid) return { content: [{ type: "text", text: JSON.stringify(gate.payment_required) }] };
      try {
        const result = await t.fn(args);
        return { content: [{ type: "text", text: JSON.stringify({ billing: gate.billing, ...result }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ error: e.code || "error", detail: String(e.message || e).slice(0, 300) }) }], isError: true };
      }
    });
  }
  return server;
}

function mountMcp(app, serviceName, toolSpecs) {
  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer(serviceName, toolSpecs);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  const na = (_req, res) => res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
  app.get("/mcp", na);
  app.delete("/mcp", na);
}
module.exports = { mountMcp, buildServer };
