import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
process.env.CHOWDECK_SESSION_PERSISTENCE='memory';
const { startHttpServer }=await import('../dist/http.js');
test('HTTP transport rejects unauthenticated/browser requests and supports authenticated MCP',async()=>{
 const token='test-only-credential-01234567890123456789';
 await assert.rejects(startHttpServer(0,'short'),/private token/);
 const server=await startHttpServer(0,token);
 const url=new URL(`http://127.0.0.1:${server.address().port}/mcp`);
 const client=new Client({name:'http-test',version:'1'});
 try {
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'POST',body:'{}',headers:{Authorization:`Bearer ${token}`,Origin:'https://example.org'}})).status,403);
  assert.equal((await fetch(url,{headers:{Authorization:`Bearer ${token}`}})).status,405);
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const tools=await client.listTools();assert.ok(tools.tools.length>=56);
  const result=await client.callTool({name:'get_session',arguments:{}});assert.equal(result.structuredContent.authenticated,false);
 }finally{await client.close();await new Promise(r=>server.close(r));}
});
