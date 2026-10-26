import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'chowdeck-test-'));
process.env.CHOWDECK_SESSION_DIR=dir;
let calls=[], failPlacement=false;
const mock=http.createServer(async(req,res)=>{
 let chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
 calls.push({method:req.method,url:req.url,body});
 res.setHeader('content-type','application/json');
 if(req.url==='/customer/cart/vendor/7')return res.end(JSON.stringify({data:{id:9,class:'delivery',bag_quantity:2,customer_delivery_note:'Keep upright',cart_items:[{item_id:1,quantity:1,pack_reference:'A'},{item_id:2,quantity:1,pack_reference:'B'}]}}));
 if(req.url==='/customer/order' && failPlacement){res.statusCode=503;return res.end('{"error":"temporary"}');}
 if(req.url==='/customer/order')return res.end(JSON.stringify({data:{id:123,payment_status:'paid'}}));
 if(req.url==='/customer/payment/start/v2'||req.url==='/customer/cart/9/pack/A/duplicate'||req.url==='/customer/order/123/tip') {res.statusCode=503;return res.end('{"error":"temporary"}');}
 return res.end('{"data":[]}');
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
process.env.CHOWDECK_API_BASE=`http://127.0.0.1:${mock.address().port}`;
const api=await import('../dist/api.js');
const {session}=await import('../dist/session.js');
const cart={id:9,class:'delivery',cart_items:[{item_id:1,quantity:1,pack_reference:'A'},{item_id:2,quantity:2,pack_reference:'B'}]};
const base={vendor_id:7,cart_id:9,fee_id:4,address_id:5,payment_method:'wallet'};
beforeEach(()=>{session.data={};failPlacement=false;});
after(()=>{mock.close();rmSync(dir,{recursive:true,force:true});});
test('gift wallet payload carries exact recipient contract and preserves server cart packs',()=>{
 const p=api.buildOrderPayload({...base,rider_tip:500,gift_recipient:{name:'Recipient',donor_name:'Sender',phone:'+2348012345678',country_code:'NG',message:'Enjoy'}},cart);
 assert.equal(p.gift_recipient.phone,'08012345678');assert.equal(p.gift_recipient.save_as_beneficiary,false);
 assert.equal(p.payment_method,'wallet');assert.equal(p.gift_recipient.message,'Enjoy');
 assert.equal(p.tip,50000);assert.equal(p.rider_tip,undefined);assert.equal(p.order_items,undefined);
 assert.equal(p.cart_id,9);assert.equal(p.checkout_from_cart,true);
});
test('regular orders explicitly clear gifts; split card checkout carries chosen card',()=>{
 const p=api.buildOrderPayload({...base,payment_method:'card',payment_method_id:3,split_payment_with_wallet:true},cart);
 assert.equal(p.gift_recipient,null);assert.equal(p.payment_method_id,3);assert.equal(p.split_payment_with_wallet,true);
});
test('pickup needs neither address nor fee and disables delivery PIN',()=>{
 const p=api.buildOrderPayload({vendor_id:7,cart_id:9,payment_method:'wallet',order_class:'pickup'},cart);
 assert.equal(p.address_id,undefined);assert.equal(p.fee_id,undefined);assert.equal(p.requires_delivery_pin,false);
 assert.throws(()=>api.buildOrderPayload({...base,order_class:'pickup',gift_recipient:{}},cart),/Gift/);
});
test('changed/empty carts, missing delivery/card details and invalid schedules fail before charging',()=>{
 assert.throws(()=>api.buildOrderPayload(base,{...cart,id:8}),/Cart changed/);
 assert.throws(()=>api.buildOrderPayload(base,{...cart,cart_items:[]}),/empty/);
 assert.throws(()=>api.buildOrderPayload({...base,fee_id:undefined},cart),/Delivery requires/);
 assert.throws(()=>api.buildOrderPayload({...base,payment_method:'card'},cart),/requires payment_method_id/);
 assert.throws(()=>api.buildOrderPayload({...base,scheduled_for:'tomorrow'},cart),/arbitrary scheduling/);
 assert.throws(()=>api.buildOrderPayload({...base,order_class:'preorder_delivery'},cart),/date and time/);
 assert.throws(()=>api.buildOrderPayload({...base,split_payment_with_wallet:true},cart),/second payment/);
});
test('preorders preserve actual vendor date and time window',()=>{
 const p=api.buildOrderPayload({...base,order_class:'preorder_delivery',delivery_date:'2026-10-28',earliest_delivery_time:'12:00',latest_delivery_time:'14:00'},cart);
 assert.equal(p.class,'preorder_delivery');assert.equal(p.latest_delivery_time,'14:00');
});
test('wallet placement goes through cart read and one charge request',async()=>{
 calls=[];session.token='test-token';const r=await api.placeOrder(base);
 assert.equal(r.data.id,123);assert.equal(calls.filter(x=>x.method==='POST').length,1);
 assert.equal(calls[1].body.customer_delivery_note,'Keep upright');
});
test('online payment failure preserves created order id and never reorders',async()=>{
 calls=[];const r=await api.placeOrder({...base,payment_method:'online_payment',online_channel:'bank_transfer'});
 assert.equal(r.data.id,123);assert.match(r.data.payment_error,/Do not place another order/);
 assert.equal(calls.filter(x=>x.url==='/customer/order').length,1);
 assert.equal(calls.filter(x=>x.url==='/customer/payment/start/v2').length,1);
});
test('non-idempotent requests are never automatically retried',async()=>{
 calls=[];await assert.rejects(api.duplicatePack(9,'A'));
 assert.equal(calls.length,1);
 calls=[];await assert.rejects(api.tipRider('123',50000));assert.equal(calls.length,1);
});

test('durable idempotency returns the same order and blocks another key for the same meal',async()=>{
 calls=[];const input={...base,idempotency_key:'approved-unique-key'};
 const first=await api.placeOrder(input);const second=await api.placeOrder(input);
 assert.equal(first.data.id,second.data.id);assert.equal(second.idempotent_replay,true);
 assert.equal(calls.filter(c=>c.url==='/customer/order').length,1);
 const duplicate=await api.placeOrder({...input,idempotency_key:'another-key'});assert.equal(duplicate.duplicate_order_blocked,true);
 await assert.rejects(api.placeOrder({...input,address_id:10}),/different order/);
});
test('an ambiguous placement is reserved before charging and never retried with the same key',async()=>{
 calls=[];failPlacement=true;const input={...base,idempotency_key:'ambiguous-order-key'};
 const first=await api.placeOrder(input);assert.equal(first.status,'unknown');
 const second=await api.placeOrder(input);assert.equal(second.status,'unknown');
 assert.equal(calls.filter(c=>c.url==='/customer/order').length,1);
});
