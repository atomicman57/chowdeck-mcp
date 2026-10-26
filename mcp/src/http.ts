import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

/** Single-account loopback transport. Never bind publicly or log credentials. */
export async function startHttpServer(port = Number(process.env.CHOWDECK_HTTP_PORT ?? 8147), token = process.env.CHOWDECK_HTTP_TOKEN) {
  if (!token || token.length < 32) throw new Error("HTTP transport requires a private token of at least 32 characters.");
  const expected = Buffer.from(`Bearer ${token}`);
  const listener = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? "");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"error":"Unauthorized"}'); return;
    }
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    // This transport is intended for the desktop MCP client, never browser JS.
    if (req.headers.origin) { res.writeHead(403).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 1024 * 1024) { res.writeHead(413).end(); return; }
      }
      let parsed;
      try { parsed = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      await server.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end('{"error":"MCP request failed"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(port, "127.0.0.1", () => resolve());
  });
  return listener;
}
