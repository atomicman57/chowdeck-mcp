import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
test('MCP end-to-end: login, wallet preference, gift checkout, confirmation gate and payment status',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chowdeck-mcp-'));let calls=[];
 const mock=http.createServer(async(req,res)=>{
  let chunks=[];for await(const c of req)chunks.push(c);
  const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;calls.push({url:req.url,method:req.method,body});
  res.setHeader('content-type','application/json');let data={};
  if(req.url==='/auth/login/validate-otp')data={token:'synthetic-secret',id:1};
  else if(req.url==='/customer/cart/vendor/7')data={id:9,class:'delivery',cart_items:[{item_id:11,quantity:1,pack_reference:'A'}],total_price:4000};
  else if(req.url.startsWith('/customer/vendor/7'))data={id:7,address_id:77,name:'Test Kitchen'};
  else if(req.url.startsWith('/customer/wallet'))data={total_balance:5000000,currency:'NGN'};
  else if(req.url==='/customer/beneficiary')data=[{name:'Test Recipient',phone:'08012345678'}];
  else if(req.url.startsWith('/customer/payment/methods'))data=[{type:'wallet'}];
  else if(req.url==='/customer/delivery/amount')data={id:4,final_delivery_amount:1000,final_service_amount:0};
  else if(req.url==='/customer/discount/apply')data=[];
  else if(req.url==='/customer/order')data={id:123,payment_status:'paid'};
  else if(req.url==='/order/123/payment')data={status:'paid'};
  res.end(JSON.stringify({status:true,data}));
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,CHOWDECK_CREDENTIAL_HELPER:'',CHOWDECK_API_BASE:`http://127.0.0.1:${mock.address().port}`,CHOWDECK_SESSION_DIR:dir},stderr:'pipe'});
 const client=new Client({name:'integration-test',version:'1'});
 const call=async(name,args={})=>{
  const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));assert.equal(typeof r._meta.elapsed_ms,'number');const body=JSON.parse(r.content[0].text);assert.equal(typeof body.elapsed_ms,'number');return body;
 };
 try {
  await client.connect(transport);
  const list=await client.listTools();
  for(const name of ['prepare_checkout','list_beneficiaries','get_order_timeline','get_live_tracking','get_order_payment_status','duplicate_pack','delete_pack','update_delivery_note'])assert.ok(list.tools.some(t=>t.name===name));
  const schema=list.tools.find(t=>t.name==='place_order').inputSchema;
  assert.ok(schema.properties.gift_recipient);assert.ok(schema.properties.split_payment_with_wallet);
  const auth=await call('login_verify_otp',{phone:'08012345678',otp:'synthetic'});
  assert.ok(!JSON.stringify(auth).includes('synthetic-secret'));
  const pref=await call('set_payment_pref',{mode:'default',payment_method:'wallet'});assert.equal(pref.payment_pref.paymentMethod,'wallet');
  const checkout=await call('prepare_checkout',{vendor_id:7,address_id:5});assert.equal(checkout.needs_confirmation,true);
  assert.equal(calls.find(c=>c.url==='/customer/delivery/amount').body.destination_id,5);
  assert.equal(calls.filter(c=>c.url==='/customer/order').length,0);
  const order={idempotency_key:'protocol-gift-1',vendor_id:7,cart_id:9,fee_id:4,address_id:5,payment_method:'wallet',gift_recipient:{name:'Test Recipient',donor_name:'Test Sender',phone:'08012345678'}};
  const gated=await call('place_order',order);assert.equal(gated.needs_confirmation,true);
  assert.equal(calls.filter(c=>c.url==='/customer/order').length,0);
  const result=await call('place_order',{...order,confirm:true});assert.equal(result.data.id,123);
  assert.equal(calls.find(c=>c.url==='/customer/order').body.gift_recipient.name,'Test Recipient');
  const status=await call('get_order_payment_status',{order_id:'123'});assert.equal(status.data.status,'paid');
  const paymentGate=await call('start_order_payment',{order_id:123,method:'bank_transfer'});assert.equal(paymentGate.needs_confirmation,true);
  assert.equal(calls.filter(c=>c.url==='/customer/payment/start/v2').length,0);
  const session=await call('get_session');assert.equal(session.authenticated,true);assert.equal(session.payment_pref.paymentMethod,'wallet');
  console.log(`Verified ${list.tools.length} MCP tools; synthetic gift-wallet flow completed without live API access.`);
 } finally {await client.close();mock.close();rmSync(dir,{recursive:true,force:true});}
});
