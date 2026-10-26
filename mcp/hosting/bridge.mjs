#!/usr/bin/env node
// Credential-free launcher source. The central helper injects the access key.
import readline from 'node:readline';
const endpoint=process.env.CHOWDECK_MCP_URL;
if(!endpoint){process.stderr.write('Set CHOWDECK_MCP_URL to your own hosted /mcp endpoint.\n');process.exit(1);}
const parsed=new URL(endpoint);
if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsed.hostname))){throw new Error('Hosted MCP requires HTTPS or loopback HTTP.');}
const token=process.env.CHOWDECK_MCP_TOKEN;
if(!token){process.stderr.write('Missing Chowdeck MCP credential; use the your secret-manager launcher.\n');process.exit(1);}
let protocol='2025-03-26';
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
for await(const line of input){
 if(!line.trim())continue;
 let message;
 try{message=JSON.parse(line);}catch{emit({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});continue;}
 if(message.method==='initialize')protocol=message.params?.protocolVersion??protocol;
 try{
  const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':protocol,'user-agent':'ChowdeckMCP-Bridge/0.7'},body:JSON.stringify(message),signal:AbortSignal.timeout(120000)});
  const text=await response.text();
  if(message.id===undefined)continue;
  if(!response.ok){emit({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:`Hosted Chowdeck MCP returned HTTP ${response.status}. No automatic retry was made. If an order was being placed, check active orders before any further placement.`}});continue;}
  if(text)emit(JSON.parse(text));
 }catch{
  if(message.id!==undefined)emit({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Hosted connection failed. No automatic retry was made. A purchase outcome may be unknown; inspect active orders/history before placing anything again.'}});
 }
}
