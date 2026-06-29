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
const okf = require("./okf_reliability");
const OKF_SID = "geo";

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
        { const _t = JSON.stringify({ billing: gate.billing, ...result }); const _ah = (result && (result.attestation_hash || (result.attestation && result.attestation.attestation_hash))) || null; const _now = new Date().toISOString(); return { content: [{ type: "text", text: _t }], _meta: okf.mcpMeta(okf.forAttestedAnalysis({ attestationHash: _ah, asOf: (result && result.created_at) || _now, score: 0.7 }), { serverId: OKF_SID, producedAt: _now, outputText: _t }) }; }
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
