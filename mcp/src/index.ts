#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
if (process.argv.includes("--http")) {
  const { startHttpServer } = await import("./http.js");
  await startHttpServer();
} else {
  await createServer().connect(new StdioServerTransport());
}
