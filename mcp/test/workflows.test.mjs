import {test,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.CHOWDECK_SESSION_PERSISTENCE='memory';
let calls=[],open=true,balance=20000000;
const mock=http.createServer(async(req,res)=>{
 let chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
 calls.push({url:req.url,method:req.method,body});res.setHeader('content-type','application/json');let data={};
 if(req.url==='/customer/order/old')data={id:'old',vendor_id:7};
 else if(req.url==='/customer/order/old/repeat')data={vendor_id:7};
 else if(req.url==='/customer/cart/vendor/7')data={id:9,class:'delivery',bag_quantity:1,total_price:5000000,cart_items:[{item_id:11,name:'Jollof tray',quantity:1,price_per_quantity:5000000,pack_reference:'A'}]};
 else if(req.url.startsWith('/customer/vendor/7/menu'))data=[{id:11,name:'Rice plate',options:[{name:'Rice Option',required:true,items:[{id:21,name:'Mixed Rice',price:0},{id:22,name:'Jollof Rice',price:0}]}]}];
 else if(req.url.startsWith('/customer/vendor/7'))data={id:7,address_id:77,name:'Test Kitchen',is_open:open,minimum_order_amount:100000};
 else if(req.url.startsWith('/customer/wallet'))data={total_balance:balance,currency:'NGN'};
 else if(req.url.startsWith('/customer/config'))data={bag_information:{amount:50000}};
 else if(req.url==='/customer/delivery/amount')data={id:4,final_delivery_amount:900000,final_service_amount:40000};
 else if(req.url==='/customer/discount/apply')data=[];
 else if(req.url==='/customer/beneficiary'||req.url.startsWith('/customer/payment/methods'))data=[];
 else if(req.url.startsWith('/auth/virtual-account'))data={bank:'Synthetic Bank',account_number:'test-only'};
 else if(req.url==='/customer/order')data={id:123,payment_status:'paid'};
 res.end(JSON.stringify({status:true,data}));
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));process.env.CHOWDECK_API_BASE=`http://127.0.0.1:${mock.address().port}`;
const api=await import('../dist/api.js');const workflows=await import('../dist/workflows.js');const {session}=await import('../dist/session.js');
beforeEach(()=>{calls=[];open=true;balance=20000000;session.data={};session.token='synthetic';});after(()=>mock.close());
test('live preview mirrors kobo fees/bags and reports exact budget or wallet shortfall',async()=>{
 const preview=await api.prepareCheckout(7,5);assert.equal(preview.summary.total_naira,59900);assert.equal(preview.summary.ready,true);
 balance=4990000;const short=await workflows.shortfall(7,5);assert.equal(short.summary.shortfall_naira,10000);assert.equal(short.transfer_initiated,false);assert.equal(short.topup_account_from_live_api.data.account_number,'test-only');
 const over=await api.prepareCheckout(7,5,{max_total_naira:50000});assert.ok(over.summary.issues.some(x=>x.code==='over_budget'));
 assert.equal(calls.filter(c=>c.url==='/customer/order').length,0);
});
test('closed vendor and changed approval total block payment',async()=>{
 open=false;const preview=await api.prepareCheckout(7,5);assert.ok(preview.summary.issues.some(x=>x.code==='vendor_closed'));
 await assert.rejects(api.placeOrder({vendor_id:7,cart_id:9,fee_id:4,address_id:5,payment_method:'wallet',expected_total_naira:59900,max_total_naira:60000,idempotency_key:'closed-order'}),/Checkout blocked/);
 open=true;await assert.rejects(api.placeOrder({vendor_id:7,cart_id:9,fee_id:4,address_id:5,payment_method:'wallet',expected_total_naira:59000,max_total_naira:60000,idempotency_key:'changed-order'}),/total changed/);
 assert.equal(calls.filter(c=>c.url==='/customer/order').length,0);
});
test('saved/default recipient and one-call repeat gift preserve note, wallet and live price',async()=>{
 await workflows.saveRecipient({name:'Test Recipient',phone:'08012345678',donor_name:'Sender',address_id:5,rider_note:'Call the recipient',is_default:true});
 await workflows.saveRecipe('usual','old',59000);
 const draft=await workflows.reorderGift({favourite_name:'usual',max_total_naira:60000,request_id:'repeat-gift-key'});
 assert.equal(draft.recipient.name,'Test Recipient');assert.equal(draft.preview.summary.total_naira,59900);assert.equal(draft.price_changed,true);assert.equal(draft.place_order_args.customer_delivery_note,'Call the recipient');assert.equal(draft.place_order_args.payment_method,'wallet');
 await workflows.reorderGift({favourite_name:'usual',max_total_naira:60000,request_id:'repeat-gift-key'});assert.equal(calls.filter(c=>c.url==='/customer/order/old/repeat').length,1);
 assert.equal(calls.filter(c=>c.url==='/customer/order').length,0);
 await api.placeOrder({...draft.place_order_args,confirm:true});assert.equal(calls.filter(c=>c.url==='/customer/order').length,1);
 const log=workflows.orderLog(5);assert.equal(log[0].recipient,'Test Recipient');assert.equal(log[0].order_id,123);
});
test('option search returns ids and ambiguity without changing a cart',async()=>{
 const exact=await workflows.findItem(7,'Mixed Rice');assert.equal(exact.candidates[0].id,21);assert.equal(exact.candidates[0].required,true);
 const ambiguous=await workflows.findItem(7,'Rice');assert.equal(ambiguous.ambiguous,true);assert.equal(calls.filter(c=>c.method!=='GET').length,0);
});
test('session status never sends an OTP when signed out',async()=>{
 session.token=null;const status=await workflows.sessionStatus();assert.equal(status.status,'reauth_required');assert.equal(status.otp_sent,false);assert.equal(calls.length,0);
});
