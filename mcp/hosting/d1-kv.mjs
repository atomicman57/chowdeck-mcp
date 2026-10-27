// Bounded, disposable D1 cache. Account sessions and OAuth live separately in the Durable Object.
const cacheNow = () => Math.floor(Date.now()/1000);
const cacheEncode = bytes => {let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);};
const cacheDecode = value => Uint8Array.from(atob(value), c=>c.charCodeAt(0));
const cacheBytes = async value => typeof value==='string'?new TextEncoder().encode(value):new Uint8Array(await new Response(value).arrayBuffer());
const cacheTransform = async (bytes, decompress=false) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(decompress?new DecompressionStream('gzip'):new CompressionStream('gzip'))).arrayBuffer());
const cacheAsType = (bytes,options) => {const type=typeof options==='string'?options:options?.type||'text';if(type==='arrayBuffer')return bytes.buffer;if(type==='stream')return new Response(bytes).body;const s=new TextDecoder().decode(bytes);return type==='json'?JSON.parse(s):s;};
export class D1KV {
 constructor(db){this.db=db;}
 async get(key,options={}){if(Array.isArray(key))return this.getMany(key,options);return (await this.getMany([key],options)).get(key)??null;}
 async getWithMetadata(key,options={}){return {value:await this.get(key,options),metadata:null,cacheStatus:null};}
 async getMany(keys,options={}){
  const out=new Map(keys.map(key=>[key,null]));
  for(let i=0;i<keys.length;i+=90){const batch=keys.slice(i,i+90);if(!batch.length)continue;
   const result=await this.db.prepare(`SELECT key,value FROM cache_entries WHERE key IN (${batch.map(()=>'?').join(',')}) AND expires_at > ?`).bind(...batch,cacheNow()).all();
   await Promise.all(result.results.map(async row=>{try{out.set(row.key,cacheAsType(await cacheTransform(cacheDecode(row.value),true),options));}catch{out.set(row.key,null);}}));
  }return out;
 }
 async prepareEntry(key,value,options={}){
  const priority=key.startsWith('search:')?1:0;
  const bytes=await cacheBytes(value);
  if(bytes.length>1400000){if(priority)throw new Error('Search continuation exceeds cache capacity');return null;}
  const encoded=cacheEncode(await cacheTransform(bytes));
  if(encoded.length>(priority?524288:262144)){if(priority)throw new Error('Search continuation exceeds cache capacity');return null;}
  const ttl=Math.max(1,Math.min(900,Number(options.expirationTtl??(options.expiration-cacheNow()))||600));
  return [key,encoded,encoded.length,cacheNow()+ttl,priority];
 }
 async put(key,value,options={}){
  const entry=await this.prepareEntry(key,value,options);if(!entry)return;
  const r=await this.db.prepare(`INSERT INTO cache_entries(key,value,bytes,expires_at,priority) VALUES(?,?,?,?,?)
   ON CONFLICT(key) DO UPDATE SET value=excluded.value,bytes=excluded.bytes,expires_at=excluded.expires_at,priority=excluded.priority`).bind(...entry).run();
  // Never issue a continuation token that was not saved.
  if(entry[4] && r.meta?.changes===0)throw new Error('Daily search continuation cache budget reached; start a fresh search after the daily reset');
 }
 async putMany(entries){
  // One round trip for the menu + head pair. Triggers enforce caps atomically,
  // including across concurrent requests and Worker isolates.
  const prepared=(await Promise.all(entries.map(e=>this.prepareEntry(e.key,e.value,e)))).filter(Boolean);
  for(let i=0;i<prepared.length;i+=18){const part=prepared.slice(i,i+18);await this.db.prepare(`INSERT INTO cache_entries(key,value,bytes,expires_at,priority) VALUES ${part.map(()=>'(?,?,?,?,?)').join(',')}
   ON CONFLICT(key) DO UPDATE SET value=excluded.value,bytes=excluded.bytes,expires_at=excluded.expires_at,priority=excluded.priority`).bind(...part.flat()).run();}
 }
 async delete(key){await this.db.prepare('DELETE FROM cache_entries WHERE key=?').bind(key).run();}
}
export function withD1Storage(env,binding='CHOWDECK_CACHE'){
 if(!env.MCP_STORAGE)throw new Error('MCP_STORAGE D1 binding is required');
 return {...env,[binding]:new D1KV(env.MCP_STORAGE)};
}
export async function cleanupD1Storage(env){
 await env.MCP_STORAGE.prepare('DELETE FROM cache_entries WHERE key IN (SELECT key FROM cache_entries WHERE expires_at <= ? LIMIT 5000)').bind(cacheNow()).run();
}
