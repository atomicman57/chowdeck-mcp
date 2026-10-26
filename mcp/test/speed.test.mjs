import {test,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.CHOWDECK_SESSION_PERSISTENCE='memory';
let calls=[],open=true,stock=true,balance=9990000,revision='2026-10-26T10:00:00Z',failOrder=false,latency=0,inflight=0,peak=0,incompleteGroups=false;
const image='https://files.chowdeck.com/'+Buffer.from(JSON.stringify({bucket:'menu-images-production',key:'synthetic.webp'})).toString('base64');
const item=()=>({id:11,name:'3-in-1 Viral Check HIV kit',price:500000,in_stock:stock,updated_at:revision,description:'x'.repeat(100),category:{name:'Tests'},images:[{path:image}],menu_group_ids:incompleteGroups?'8':''});
const server=http.createServer(async(req,res)=>{
 const parts=[];for await(const c of req)parts.push(c);const body=parts.length?JSON.parse(Buffer.concat(parts)):null;calls.push({url:req.url,method:req.method,body});res.setHeader('content-type','application/json');let data={};
 if(req.url.startsWith('/customer/vendor/v2')){const next=new URL(req.url,'http://test').searchParams.get('next_cursor');return res.end(JSON.stringify({data:next?[{id:3,name:'Third Pharmacy',is_open:true,distance:3,delivery_price:10000}]:[{id:1,name:'First Pharmacy',is_open:true,distance:1,delivery_price:10000},{id:2,name:'Closed Pharmacy',is_open:false,distance:2,delivery_price:10000}],meta:{has_more:!next,next_cursor:next?null:'cursor-two'}}));}
 if(req.url.startsWith('/customer/vendor/99/menu'))return;
 if(req.url.startsWith('/customer/vendor/98/menu/'))return;
 if(req.url.startsWith('/customer/vendor/98/menu?')){await new Promise(r=>setTimeout(r,100));return res.end(JSON.stringify({data:[{...item(),menu_group_ids:'8'}]}));}
 if(/\/menu\?/.test(req.url)){inflight++;peak=Math.max(peak,inflight);if(latency)await new Promise(r=>setTimeout(r,latency));inflight--;}
 if(/\/menu\?/.test(req.url))data=[item(),{id:12,name:'Option-group pseudo row',group_id:8,price:0,in_stock:true},{id:15,name:'HIV option group',minimum_selection:1,items:[]},{id:16,name:'HIV group row',type:'group',price:100,in_stock:true},{id:13,name:'Chivita juice',price:100000,in_stock:true,images:[]}];
 else if(/\/menu\/11/.test(req.url))data=item();
 else if(req.url.startsWith('/customer/vendor/'))data={id:1,address_id:77,name:'Synthetic Pharmacy',is_open:open,minimum_order_amount:0};
 else if(req.url.startsWith('/auth/me'))data={id:1};
 else if(req.url.startsWith('/customer/wallet'))data={total:balance};
 else if(req.url.startsWith('/customer/config'))data={bag_information:{amount:0}};
 else if(req.url==='/customer/address/active')data={id:5,tag:'Home',pretty_name:'Synthetic address'};
 else if(req.url==='/customer/address')data=[{id:5,tag:'Home',pretty_name:'Synthetic address',is_active:true}];
 else if(req.url==='/customer/delivery/amount')data={id:4,final_delivery_amount:10000,final_service_amount:10000};
 else if(req.url==='/customer/discount/apply')data=[];
 else if(req.url==='/customer/cart/vendor/1')data={id:9,class:'delivery',bag_quantity:0,cart_items:[{item_id:11,name:'Test kit',quantity:1,price_per_quantity:500000,in_stock:stock,pack_reference:'quick-1'}]};
 else if(req.url.startsWith('/customer/order/old'))data={id:'old',vendor_id:1,customer_address_id:5,gift_recipient:JSON.stringify({name:'Test Recipient',phone:'08012345678',donor_name:'Sender',country_code:'NG'}),order_items:[{item_id:11,type:'menu',quantity:1,pack_reference:'A'}]};
 else if(req.url==='/customer/order'){if(failOrder){res.statusCode=503;return res.end('{"message":"synthetic unavailable"}');}data={id:123,order_number:'TEST123',delivery_pin:'0000'};}
 else data=[];
 res.end(JSON.stringify({status:'success',data}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.CHOWDECK_API_BASE=`http://127.0.0.1:${server.address().port}`;
const fast=await import('../dist/fast.js'),quick=await import('../dist/quick.js'),{session}=await import('../dist/session.js');
const kvData=new Map(),kv={get:async k=>kvData.get(k)??null,put:async(k,v)=>kvData.set(k,JSON.parse(v)),delete:async k=>kvData.delete(k)};
beforeEach(()=>{calls=[];incompleteGroups=false;open=stock=true;failOrder=false;latency=inflight=peak=0;balance=9990000;revision='2026-10-26T10:00:00Z';session.token='synthetic';session.addressId=5;session.data={};kvData.clear();fast.resetFastCache();fast.configureFastCache(kv);quick.configureQuickDefaults({gift_recipient:{name:'Test Recipient',phone:'08012345678',donor_name:'Sender',country_code:'NG'},rider_note:'Synthetic note'});});after(()=>server.close());
const args=()=>({vendor_id:1,items:[{menu_id:11,qty:1,options:[]}],max_total_naira:6000,idempotency_key:'test-quick'});
test('paged open-vendor search matches synonyms, excludes group rows and avoids HIV/Chivita false positives',async()=>{
 const result=await fast.searchEverywhere({queries:['3 in 1','viralcheck','hiv'],vendor_type:'pharmacy',open_now:true});assert.equal(result.vendors_checked,2);assert.equal(result.vendors_skipped,1);assert.equal(result.coverage_complete,true);assert.equal(result.items.length,6);assert.ok(result.items.every(i=>i.item_id===11));assert.equal(fast.normalize('3-in-1'),fast.normalize('3 in 1'));assert.equal(fast.normalize('3in1'),fast.normalize('3 in 1'));assert.ok(calls.some(c=>c.url.includes('next_cursor=cursor-two')));incompleteGroups=true;fast.resetFastCache();kvData.clear();const partial=await fast.searchEverywhere({queries:['hiv'],open_now:true});assert.equal(partial.coverage_complete,false);assert.equal(partial.vendors_incomplete,2);
});
test('menu cache survives memory reset via KV and invalidates when an observed revision changes',async()=>{
 const first=await fast.cachedMenu(1,{hint:'v1'});assert.equal(first.cache_hit,false);fast.resetFastCache();assert.equal((await fast.cachedMenu(1,{hint:'v1'})).cache_hit,true);const count=calls.length;revision='2026-10-27T11:00:00Z';const next=await fast.cachedMenu(1,{hint:'v2'});assert.equal(next.updated_at,revision);assert.ok(calls.length>count);
});
test('slim multi-menu response retains photos and capped descriptions without option rows',async()=>{
 const result=await fast.menuSlim({vendor_ids:[1,3]});assert.equal(result.vendors.length,2);assert.ok(result.vendors.every(v=>v.items.length===2));assert.equal(result.vendors[0].items[0].description.length,80);assert.equal(result.vendors[0].items[0].image_url,'https://menu-images-production.s3.amazonaws.com/synthetic.webp');
});
test('batch photos decode URLs once per vendor without downloading images',async()=>{
 const result=await fast.imagesBatch([{vendor_id:1,menu_id:11},{vendor_id:1,menu_id:13}],1);assert.equal(result.embedded_images,false);assert.equal(result.items[0].image_urls.length,1);assert.equal(calls.filter(c=>c.url.includes('/menu?')).length,1);
});
test('quick dry-run returns a live quote and defaults with no cart writes or purchases',async()=>{
 const result=await quick.quickOrder({...args(),confirm:false});assert.equal(result.total_naira,5200);assert.equal(result.gift_recipient.name,'Test Recipient');assert.equal(result.placed,false);assert.ok(calls.every(c=>c.method==='GET'||['/customer/delivery/amount','/customer/discount/apply'].includes(c.url)));
});
test('closed vendors, stock, budget and changed approvals abort without a charge',async()=>{
 open=false;assert.equal((await quick.quickOrder(args())).reason,'vendor_closed');open=true;stock=false;assert.equal((await quick.quickOrder(args())).reason,'out_of_stock');stock=true;assert.equal((await quick.quickOrder({...args(),max_total_naira:5000})).reason,'over_budget');assert.equal((await quick.quickOrder({...args(),confirm:true,expected_total_naira:5100})).reason,'approved_total_changed');assert.ok(!calls.some(c=>c.method==='DELETE'||c.url==='/customer/order'));
});
test('confirmed synthetic quick order preserves idempotency before clearing any cart again',async()=>{
 const request={...args(),confirm:true,expected_total_naira:5200};const first=await quick.quickOrder(request);assert.equal(first.order_number,'TEST123');assert.equal(first.wallet_balance_after,99900);const writes=calls.filter(c=>c.method!=='GET').length;const replay=await quick.quickOrder(request);assert.equal(replay.idempotent_replay,true);assert.equal(calls.filter(c=>c.method!=='GET').length,writes);await assert.rejects(quick.quickOrder({...request,items:[{menu_id:13,qty:1}]}),/different quick-order/);
});
test('unknown synthetic placement reconciles and never rebuilds or blindly retries',async()=>{
 failOrder=true;const request={...args(),confirm:true,expected_total_naira:5200};assert.equal((await quick.quickOrder(request)).status,'unknown');const writes=calls.filter(c=>c.method!=='GET').length;assert.equal((await quick.quickOrder(request)).status,'unknown');assert.equal(calls.filter(c=>c.method!=='GET').length,writes);assert.equal(calls.filter(c=>c.url==='/customer/order').length,1);
});
test('fast reorder dry-run reconstructs a past order without calling native repeat or changing a cart',async()=>{
 const result=await quick.reorderFast({past_order_id:'old',max_total_naira:6000,idempotency_key:'repeat-test',confirm:false});assert.equal(result.total_naira,5200);assert.ok(!calls.some(c=>c.url.endsWith('/repeat')||c.method==='DELETE'||c.url==='/customer/order'));
});

test('multi-menu fetching runs at bounded concurrency twelve',async()=>{latency=30;const result=await fast.menuSlim({vendor_ids:Array.from({length:24},(_,i)=>i+1)});assert.equal(result.vendors.length,24);assert.ok(peak>=10&&peak<=12);});
test('one timed-out vendor does not discard successful menus or run indefinitely',async()=>{const start=Date.now();const result=await fast.menuSlim({vendor_ids:[1,99,98]});assert.ok(Date.now()-start<3800);assert.ok(result.vendors[0].items.length>0);assert.equal(result.vendors[1].error,'menu_timeout_or_unavailable');assert.equal(result.vendors[2].option_groups_complete,false);assert.ok(result.vendors[2].items.length>0);});
