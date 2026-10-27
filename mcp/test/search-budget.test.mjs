import {test,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.CHOWDECK_SESSION_PERSISTENCE='memory';
let calls=[], count=215, groups=false, fail=false, retired=false, alternateNames=false;
const server=http.createServer((req,res)=>{
 calls.push({url:req.url,method:req.method});res.setHeader('content-type','application/json');
 const u=new URL(req.url,'http://test');
 if(u.pathname==='/customer/vendor/v2'){
  const offset=Number(u.searchParams.get('next_cursor')??0),end=Math.min(offset+30,count);
  return res.end(JSON.stringify({data:Array.from({length:end-offset},(_,i)=>({id:offset+i+1,name:`Shop ${offset+i+1}`,is_open:(offset+i+1)%10!==0,distance:1,delivery_price:10000})),meta:{has_more:end<count,next_cursor:end<count?String(end):null}}));
 }
 if(/^\/customer\/vendor\/\d+$/.test(u.pathname)){const id=Number(u.pathname.split('/').at(-1));return res.end(JSON.stringify({data:{id,name:`Shop ${id}`,is_open:id%10!==0,vendor_type:'supermarket',distance:1,delivery_price:10000}}));}
 if(fail){res.statusCode=503;return res.end('{}');}
 if(/\/menu\/\d+$/.test(u.pathname))return res.end(JSON.stringify({data:{id:11,modifiers:retired?[]:[{id:8,name:'Cable extras',items:[]}]}}));
 res.end(JSON.stringify({data:alternateNames?[{id:11,name:'APPLE TYPE C TO TYPE C CHORD (2M)',in_stock:false,price:1070000},{id:12,name:'Jollof',category:{name:'Rice'},in_stock:true,price:100000},{id:13,name:'Pounded Yam',in_stock:true,price:150000}]:[{id:11,name:'USB-C cable 3-in-1',in_stock:true,price:100000,menu_group_ids:groups?'8':''}]}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.CHOWDECK_API_BASE=`http://127.0.0.1:${server.address().port}`;
const fast=await import('../dist/fast.js'),budget=await import('../dist/budget.js'),{session}=await import('../dist/session.js');
const data=new Map(),kv={get:async k=>Array.isArray(k)?new Map(k.map(key=>[key,data.get(key)??null])):data.get(k)??null,put:async(k,v)=>data.set(k,JSON.parse(v)),delete:async k=>data.delete(k)};
beforeEach(()=>{calls=[];count=215;groups=fail=retired=false, alternateNames=false;session.token='synthetic';session.addressId=5;data.clear();fast.resetFastCache();fast.configureFastCache(kv);});after(()=>server.close());
const queries=['cable','usb c','3 in 1','3-in-1','3in1','USB-C','charger','extras'];
test('free budget + KV cursor covers every eligible vendor, even beyond 200; queries never multiply menu requests',async()=>{
 let cursor, pages=0;const seen=new Set();
 do {
  const before=calls.length;
  const r=await fast.searchEverywhere({queries,vendor_type:'shop',open_now:true,max_vendors:60,...(cursor?{cursor}:{})});
  assert.ok(r.subrequests.external<=42);assert.equal(r.subrequests.external,calls.length-before);
  assert.equal(r.vendor_type,'supermarket');assert.ok(r.skip_reasons);assert.ok(Number.isInteger(r.elapsed_ms));
  for(const i of r.items)seen.add(i.vendor_id);
  cursor=r.next_cursor;assert.ok(r.coverage_complete||cursor);
  fast.resetFastCache(); // Resume after isolate eviction using persisted cursor and menus.
  assert.ok(++pages<20);
 }while(cursor);
 assert.equal(seen.size,194);assert.equal(calls.filter(c=>/\/menu\?/.test(c.url)).length,194);
 assert.ok(calls.every(c=>c.method==='GET'));
});
test('cap continuation, invalid types and cursor scope binding are explicit',async()=>{
 count=80;const first=await fast.searchEverywhere({queries,max_vendors:5});assert.equal(first.vendors_checked,5);assert.ok(first.skip_reasons.cap_reached>0);assert.ok(first.next_cursor);
 await assert.rejects(fast.searchEverywhere({queries:['different'],cursor:first.next_cursor}),/does not match/);
 const invalid=await fast.searchEverywhere({queries,vendor_type:'store'});assert.equal(invalid.error,'invalid_vendor_type');assert.ok(invalid.valid_vendor_types.includes('supermarket'));
});
test('paid config permits 200 in one call; warm 60 menus have zero external requests',async()=>{
 count=200;const first=await budget.withRequestBudget({plan:'paid',limit:1000},()=>fast.searchEverywhere({queries,max_vendors:200}));assert.equal(first.vendors_checked,180);assert.equal(first.coverage_complete,true);assert.ok(first.subrequests.external>50);
 const t=Date.now();const warm=await fast.searchEverywhere({queries,max_vendors:60});assert.equal(warm.cache_hits,60);assert.equal(warm.subrequests.external,0);assert.ok(Date.now()-t<3000);
 const cached=await fast.searchEverywhere({queries,max_vendors:60});assert.equal(cached.result_cache_hit,true);assert.equal(cached.vendors_from_result_cache,60);assert.equal(cached.subrequests.external,0);
});
test('option-detail fetches share budget and incomplete menus resume without refetching the root',async()=>{
 count=40;groups=true;let cursor,pages=0;const seen=new Set();
 do {const r=await fast.searchEverywhere({queries,max_vendors:200,...(cursor?{cursor}:{})});for(const i of r.items)seen.add(i.vendor_id);assert.ok(r.subrequests.external<=42);cursor=r.next_cursor;assert.ok(++pages<10);}while(cursor);
 assert.equal(seen.size,36);assert.equal(calls.filter(c=>/\/menu\?/.test(c.url)).length,36);
});
test('network failures are explained and not automatically retried inside an invocation',async()=>{
 count=5;fail=true;const r=await fast.searchEverywhere({queries});assert.equal(r.skip_reasons.error,5);assert.equal(calls.length,6);assert.ok(r.next_cursor);const done=await fast.searchEverywhere({queries,cursor:r.next_cursor});assert.equal(done.coverage_complete,false);assert.ok(done.next_cursor);const final=await fast.searchEverywhere({queries,cursor:done.next_cursor});assert.equal(final.next_cursor,null);assert.equal(final.errors.length,5);
});

test('successful item-detail membership resolves retired root group references',async()=>{
 count=5;groups=retired=true;const r=await fast.searchEverywhere({queries});assert.equal(r.coverage_complete,true);assert.equal(r.vendors_incomplete,0);assert.equal(r.vendors_checked,5);assert.equal(r.next_cursor,null);
});


test('free D1 search bounds actual SQL queries, persists cursors and bulk-loads 60 cached menus',async(t)=>{
 let DatabaseSync;try{({DatabaseSync}=await import('node:sqlite'));}catch(error){if(error.code==='ERR_UNKNOWN_BUILTIN_MODULE'){t.skip('SQLite coverage requires Node 22 or later');return;}throw error;}const {D1KV}=await import('../hosting/d1-kv.mjs');const fs=await import('node:fs');
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(fs.readFileSync(new URL('../hosting/d1-schema.sql',import.meta.url),'utf8'));
 let sqlCalls=0;const execute=()=>{if(++sqlCalls>50)throw Error('Synthetic D1 invocation query limit exceeded');};
 const db={prepare(sql){const stmt=sqlite.prepare(sql);return {bind(...params){return {async first(){execute();return stmt.get(...params)??null;},async all(){execute();return {results:stmt.all(...params)};},async run(){execute();return stmt.run(...params);}};}};}};
 const store=new D1KV(db);fast.configureFastCache(store);count=80;let cursor;const ids=new Set();let pages=0;
 do {sqlCalls=0;const r=await budget.withRequestBudget({plan:'free',storage:'d1'},()=>fast.searchEverywhere({queries,max_vendors:200,...(cursor?{cursor}:{})}));assert.ok(sqlCalls<=42);assert.ok(r.subrequests.internal<=42);for(const id of r.vendor_ids_checked)ids.add(id);cursor=r.next_cursor;assert.ok(++pages<15);fast.resetFastCache();}while(cursor);
 assert.equal(ids.size,72);
 // Repeated first-page reads may hydrate memory from persisted menus before the
 // complete 60-vendor result page is cached; no root menu refetch is needed.
 const roots=calls.filter(c=>/\/menu\?/.test(c.url)).length;
 let r;for(let i=0;i<5;i++){sqlCalls=0;r=await budget.withRequestBudget({plan:'free',storage:'d1'},()=>fast.searchEverywhere({queries,max_vendors:60}));assert.ok(sqlCalls<=42);if(r.vendors_checked===60)break;}
 assert.equal(r.vendors_checked,60);const warmedRoots=calls.filter(c=>/\/menu\?/.test(c.url)).length;
 sqlCalls=0;const warm=await budget.withRequestBudget({plan:'free',storage:'d1'},()=>fast.searchEverywhere({queries,max_vendors:60}));assert.equal(warm.result_cache_hit,true);assert.equal(warm.vendors_from_result_cache,60);assert.equal(warm.subrequests.external,0);assert.ok(sqlCalls<=1);assert.equal(calls.filter(c=>/\/menu\?/.test(c.url)).length,warmedRoots);sqlite.close();
});

test('Apple type c cord matches catalogue CHORD spelling; food names combine with their actual category',async()=>{
 count=1;alternateNames=true;const r=await fast.searchEverywhere({queries:['Apple type c cord','jollof rice','pounded yam']});assert.equal(r.coverage_complete,true);assert.equal(r.items.length,3);const apple=r.items.find(i=>i.item_id===11);assert.equal(apple.price_naira,10700);assert.equal(apple.in_stock,false);assert.equal(apple.matched_query,'Apple type c cord');assert.ok(r.items.some(i=>i.item_id===12&&i.matched_query==='jollof rice'));assert.ok(r.items.some(i=>i.item_id===13&&i.matched_query==='pounded yam'));
});

test('selected-vendor scope checks only requested menus and reports the explicit scope',async()=>{
 const r=await fast.searchEverywhere({queries,vendor_ids:[1,3,10]});assert.deepEqual(r.scope_vendor_ids,[1,3,10]);assert.equal(r.vendors_checked,2);assert.equal(r.skip_reasons.closed,1);assert.equal(r.coverage_complete,true);assert.ok(!calls.some(c=>c.url.startsWith('/customer/vendor/v2')));assert.equal(calls.filter(c=>/\/menu\?/.test(c.url)).length,2);
});
