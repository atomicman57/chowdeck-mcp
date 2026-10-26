import { createServer } from '../src/server.ts';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as api from "../src/api.ts";
import { session, loadSession, exportSession, setPersistenceHook } from './session.mjs';
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','cache-control':'no-store',...headers}});
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const hash=async value=>b64(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const page=(body,headers={})=>new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Chowdeck sign-in</title><style>body{font:17px system-ui;max-width:600px;margin:6vh auto;padding:24px}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:10px 0}small{color:#555}</style>${body}`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",'referrer-policy':'strict-origin-when-cross-origin',...headers}});
const now=()=>Math.floor(Date.now()/1000);
const validRedirect=value=>{try{const u=new URL(value);return u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname));}catch{return false;}};
async function encryptionKey(hex){return crypto.subtle.importKey('raw',Uint8Array.from(hex.match(/../g),v=>parseInt(v,16)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
async function seal(value,key){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},await encryptionKey(key),new TextEncoder().encode(JSON.stringify(value)));return {iv:Array.from(iv),data:Array.from(new Uint8Array(data))};}
async function unseal(value,key){if(!value)return null;const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(value.iv)},await encryptionKey(key),new Uint8Array(value.data));return JSON.parse(new TextDecoder().decode(data));}
const READ_SCOPE='chowdeck.read',WRITE_SCOPE='chowdeck.write';
const readTool=name=>/^(get_|list_|search|place_details$|reverse_geocode$|ip_location$|track_order$|prepare_checkout$|session_status$|find_item$|find_vendor_alternatives$|order_log$|check_order_refund$|wallet_shortfall$)/.test(name);

export class ChowdeckAccount {
 constructor(ctx,env){this.ctx=ctx;this.env=env;this.queue=Promise.resolve();}
 fetch(request){const task=this.queue.then(()=>this.handle(request));this.queue=task.catch(()=>{});return task.catch(()=>json({error:'Request failed; no details logged.'},500));}
 async handle(request){
  const url=new URL(request.url),base=url.origin,store=this.ctx.storage;
  if(url.pathname==='/health')return json({service:'chowdeck-mcp',version:'0.7.0-rc.1',status:'ok',authentication:'required',live_paid_checkout_verified:false});
  if(url.pathname.startsWith('/.well-known/oauth-protected-resource'))return json({resource:`${base}/mcp`,authorization_servers:[base],scopes_supported:[READ_SCOPE,WRITE_SCOPE],bearer_methods_supported:['header']});
  if(url.pathname==='/.well-known/oauth-authorization-server'||url.pathname==='/.well-known/openid-configuration')return json({issuer:base,authorization_endpoint:`${base}/authorize`,token_endpoint:`${base}/token`,registration_endpoint:`${base}/register`,revocation_endpoint:`${base}/revoke`,response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],scopes_supported:[READ_SCOPE,WRITE_SCOPE]});
  if(!this.env.OWNER_ACCESS_KEY||!this.env.SESSION_ENCRYPTION_KEY)return json({error:'Service configuration incomplete'},503);
  if(['/register','/authorize','/token','/setup/unlock','/setup/send-otp','/setup/verify-otp'].includes(url.pathname)){
   const bucket=`rate:${await hash(request.headers.get('cf-connecting-ip')??'local')}:${Math.floor(now()/60)}`;
   const count=await store.get(bucket)??0;if(count>=30)return json({error:'Too many authentication requests'},429);await store.put(bucket,count+1);
  }
  if(url.pathname==='/oauth-status'&&request.method==='GET'){
   const bearer=(request.headers.get('authorization')??'').replace(/^Bearer /,'');
   if(!bearer||await hash(bearer)!==await hash(this.env.OWNER_ACCESS_KEY))return json({error:'Authorization required'},401);
   return json({last_event:await store.get('oauth-last-event')??null});
  }
  if(url.pathname.startsWith('/setup')){
   const cookie=request.headers.get('cookie')??'';
   const cookieValue=name=>cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)??'';
   const adminCookie=cookieValue('chowdeck_setup');
   const admin=adminCookie?await store.get(`setup:${await hash(adminCookie)}`):null;
   const unlocked=admin&&admin.expires>now();
   if(request.method==='POST'&&request.headers.get('origin')!==base)return json({error:'Origin denied'},403);
   if(url.pathname==='/setup'&&request.method==='GET'&&!unlocked){
    const nonce=random();await store.put(`setup-nonce:${await hash(nonce)}`,{expires:now()+600});
    return page(`<h1>Connect your Chowdeck account</h1><p>Your agents will share this sign-in. It renews automatically when Chowdeck permits.</p><form method="post" action="/setup/unlock"><input type="hidden" name="csrf" value="${nonce}"><label>Connection key<input type="password" name="key" autocomplete="current-password" required></label><button>Unlock sign-in</button></form>`,{'set-cookie':`chowdeck_setup_csrf=${nonce}; HttpOnly; Secure; SameSite=Strict; Path=/setup; Max-Age=600`});
   }
   if(url.pathname==='/setup/unlock'&&request.method==='POST'){
    const form=await request.formData(),nonce=String(form.get('csrf')??''),pending=await store.get(`setup-nonce:${await hash(nonce)}`);
    if(!pending||pending.expires<now()||cookieValue('chowdeck_setup_csrf')!==nonce)return json({error:'Invalid sign-in request'},403);
    const failures=await store.get('auth-failures')??{count:0,until:0};
    if(failures.count>=8&&failures.until>now())return json({error:'Temporarily limited'},429);
    if(await hash(String(form.get('key')??''))!==await hash(this.env.OWNER_ACCESS_KEY)){
     await store.put('auth-failures',{count:failures.until>now()?failures.count+1:1,until:now()+900});return json({error:'Invalid connection key'},403);
    }
    await store.delete(`setup-nonce:${await hash(nonce)}`);await store.delete('auth-failures');
    const secret=random();await store.put(`setup:${await hash(secret)}`,{expires:now()+900});
    return new Response(null,{status:303,headers:{location:'/setup','cache-control':'no-store','set-cookie':`chowdeck_setup=${secret}; HttpOnly; Secure; SameSite=Strict; Path=/setup; Max-Age=900`}});
   }
   if(!unlocked)return json({error:'Unlock sign-in first'},401);
   loadSession(await unseal(await store.get('account-session'),this.env.SESSION_ENCRYPTION_KEY));
   setPersistenceHook(async()=>store.put('account-session',await seal(exportSession(),this.env.SESSION_ENCRYPTION_KEY)));
   if(url.pathname==='/setup'&&request.method==='GET'){
    if(session.token){try{await api.getMe();await store.put('account-session',await seal(exportSession(),this.env.SESSION_ENCRYPTION_KEY));}catch{session.token=null;await store.put('account-session',await seal(exportSession(),this.env.SESSION_ENCRYPTION_KEY));}}
    if(session.token)return page('<h1>Chowdeck is connected</h1><p>Your agents can use this shared account. Sign-in is saved securely and renewed automatically. Every order still needs your approval.</p><p>You can close this page.</p>');
    const pendingPhone=await store.get(`setup-phone:${await hash(adminCookie)}`);
    return pendingPhone?page('<h1>Enter your Chowdeck code</h1><p>Enter the code Chowdeck sent to your phone. It is sent directly to the service, not to the chat.</p><form method="post" action="/setup/verify-otp"><label>One-time code<input name="otp" inputmode="numeric" autocomplete="one-time-code" required></label><button>Complete sign-in</button></form>'):
     page('<h1>Sign in to Chowdeck</h1><p>Use the phone number on your Chowdeck account. Sending a code does not place an order.</p><form method="post" action="/setup/send-otp"><label>Phone number<input name="phone" type="tel" autocomplete="tel" required></label><button>Send my sign-in code</button></form>');
   }
   if(url.pathname==='/setup/send-otp'&&request.method==='POST'){
    const form=await request.formData(),phone=api.normalizePhone(String(form.get('phone')??''));
    try{await api.validatePhone(phone);await api.sendLoginOtp(phone);await store.put(`setup-phone:${await hash(adminCookie)}`,{phone,expires:now()+600});}
    catch{return page('<h1>The code could not be sent</h1><p>Chowdeck may require its website sign-in or a security check. No browser credentials were copied.</p><a href="/setup">Try sign-in again</a>');}
    return new Response(null,{status:303,headers:{location:'/setup','cache-control':'no-store'}});
   }
   if(url.pathname==='/setup/verify-otp'&&request.method==='POST'){
    const pendingPhone=await store.get(`setup-phone:${await hash(adminCookie)}`);if(!pendingPhone||pendingPhone.expires<now())return page('<h1>The code expired</h1><p>Start a new sign-in.</p>');
    const form=await request.formData();
    try{await api.verifyOtp(pendingPhone.phone,String(form.get('otp')??''));if(!session.token)throw Error();session.phone=pendingPhone.phone;await store.put('account-session',await seal(exportSession(),this.env.SESSION_ENCRYPTION_KEY));await store.delete(`setup-phone:${await hash(adminCookie)}`);}
    catch{return page('<h1>Sign-in was not completed</h1><p>Check the code and try again. No order was placed.</p><a href="/setup">Try again</a>');}
    return new Response(null,{status:303,headers:{location:'/setup','cache-control':'no-store'}});
   }
   return json({error:'Not found'},404);
  }
  if(url.pathname==='/register'&&request.method==='POST'){
   const size=Number(request.headers.get('content-length')??0);if(size>16384)return json({error:'invalid_client_metadata'},400);
   const body=await request.json();
   if(!Array.isArray(body.redirect_uris)||body.redirect_uris.length<1||body.redirect_uris.length>8||!body.redirect_uris.every(validRedirect))return json({error:'invalid_redirect_uri'},400);
   const id=random();await store.put(`client:${id}`,{name:String(body.client_name??'MCP agent').slice(0,100),redirect_uris:body.redirect_uris});
   return json({client_id:id,client_name:String(body.client_name??'MCP agent').slice(0,100),redirect_uris:body.redirect_uris,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']},201);
  }
  if(url.pathname==='/authorize'&&request.method==='GET'){
   const p=Object.fromEntries(url.searchParams),client=await store.get(`client:${p.client_id}`);
   if(!client||!client.redirect_uris.includes(p.redirect_uri)||p.response_type!=='code'||p.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge??''))return json({error:'invalid_request'},400);
   const scope=p.scope||READ_SCOPE;if(scope.split(' ').some(s=>![READ_SCOPE,WRITE_SCOPE].includes(s)))return json({error:'invalid_scope'},400);
   const nonce=random();await store.put(`pending:${await hash(nonce)}`,{...p,scope,expires:now()+600});
   const html=`<!doctype html><meta name="viewport" content="width=device-width"><title>Authorize Chowdeck MCP</title><style>body{font:17px system-ui;max-width:620px;margin:8vh auto;padding:24px}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:10px 0}</style><h1>Connect ${esc(client.name)}</h1><p>This agent will access the owner’s shared Chowdeck account.</p><p>Permissions: <strong>${esc(scope)}</strong></p><p>Callback: ${esc(p.redirect_uri)}</p><p>Only approve a connection you just requested. Ordering agents must still obtain approval of the exact order and total before charging.</p><form method="post" action="/authorize"><input type="hidden" name="csrf" value="${nonce}"><label>Owner access key<input type="password" name="key" autocomplete="current-password" required></label><button>Authorize this agent</button></form>`;
   return new Response(html,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':`default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(p.redirect_uri).origin}; frame-ancestors 'none'; base-uri 'none'`,'set-cookie':`chowdeck_consent=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=600`,'referrer-policy':'strict-origin-when-cross-origin'}});
  }
  if(url.pathname==='/authorize'&&request.method==='POST'){
   if(request.headers.get('origin')!==base)return json({error:'invalid_origin'},403);
   const form=await request.formData(),nonce=String(form.get('csrf')??''),cookie=request.headers.get('cookie')??'';
   const pendingKey=`pending:${await hash(nonce)}`,pending=await store.get(pendingKey);
   if(!pending||pending.expires<now()||!cookie.split(';').some(c=>c.trim()===`chowdeck_consent=${nonce}`))return json({error:'invalid_consent'},403);
   const failures=await store.get('auth-failures')??{count:0,until:0};
   if(failures.count>=8&&failures.until>now())return json({error:'temporarily_limited'},429);
   if(await hash(String(form.get('key')??''))!==await hash(this.env.OWNER_ACCESS_KEY)){
    await store.put('auth-failures',{count:failures.until>now()?failures.count+1:1,until:now()+900});return json({error:'invalid_owner_key'},403);
   }
   await store.delete(pendingKey);await store.delete('auth-failures');
   const code=random();await store.put(`code:${await hash(code)}`,{...pending,expires:now()+120});
   await store.put('oauth-last-event',{event:'authorization_code_issued',at:now()});
   const redirect=new URL(pending.redirect_uri);redirect.searchParams.set('code',code);if(pending.state)redirect.searchParams.set('state',pending.state);
   return new Response(null,{status:302,headers:{location:redirect.toString(),'cache-control':'no-store','set-cookie':'chowdeck_consent=; HttpOnly; Secure; SameSite=Lax; Path=/authorize; Max-Age=0'}});
  }
  if(url.pathname==='/token'&&request.method==='POST'){
   const form=await request.formData();let grant;
   if(form.get('grant_type')==='authorization_code'){
    const key=`code:${await hash(String(form.get('code')??''))}`;grant=await store.get(key);
    const reason=!grant?'code_missing_or_used':grant.expires<now()?'code_expired':grant.client_id!==form.get('client_id')?'client_id_mismatch':grant.redirect_uri!==form.get('redirect_uri')?'redirect_uri_mismatch':grant.code_challenge!==await hash(String(form.get('code_verifier')??''))?'pkce_mismatch':null;
    if(reason){await store.put('oauth-last-event',{event:'token_exchange_rejected',reason,at:now()});return json({error:'invalid_grant',error_description:reason},400);}
    await store.delete(key);
   }else if(form.get('grant_type')==='refresh_token'){
    const key=`refresh:${await hash(String(form.get('refresh_token')??''))}`;grant=await store.get(key);
    if(!grant||(grant.expires&&grant.expires<now())||grant.client_id!==form.get('client_id'))return json({error:'invalid_grant'},400);
    await store.delete(key);
   }else return json({error:'unsupported_grant_type'},400);
   await store.put('oauth-last-event',{event:'token_exchange_succeeded',at:now()});
   const access=random(),refresh=random(),metadata={client_id:grant.client_id,scope:grant.scope};
   await store.put(`access:${await hash(access)}`,{...metadata,expires:now()+3600});
   await store.put(`refresh:${await hash(refresh)}`,{...metadata,expires:null});
   return json({access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600,scope:grant.scope});
  }
  if(url.pathname==='/revoke'&&request.method==='POST'){
   const form=await request.formData(),digest=await hash(String(form.get('token')??''));await store.delete(`access:${digest}`);await store.delete(`refresh:${digest}`);return json({});
  }
  if(url.pathname!=='/mcp')return json({error:'Not found'},404);
  const token=(request.headers.get('authorization')??'').replace(/^Bearer /,'');
  const auth=await store.get(`access:${await hash(token)}`);
  const owner=token.length>0&&await hash(token)===await hash(this.env.OWNER_ACCESS_KEY);
  if(!owner&&(!auth||auth.expires<now()))return json({error:'Authorization required'},401,{'www-authenticate':`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`});
  if(request.headers.get('origin')&&request.headers.get('origin')!==base)return json({error:'Origin denied'},403);
  if(request.method!=='POST')return json({error:'Method not allowed'},405);
  if(Number(request.headers.get('content-length')??0)>1024*1024)return json({error:'Too large'},413);
  const raw=await request.text();if(raw.length>1024*1024)return json({error:'Too large'},413);
  let body;try{body=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
  if(Array.isArray(body))return json({error:'Batch requests unsupported'},400);
  const canWrite=owner||auth.scope.split(' ').includes(WRITE_SCOPE);
  if(body.method==='tools/call'&&!canWrite&&!readTool(body.params?.name??''))return json({jsonrpc:'2.0',id:body.id,error:{code:-32600,message:'This client has read-only access.'}},403);
  const savedSession=await unseal(await store.get('account-session'),this.env.SESSION_ENCRYPTION_KEY);loadSession(savedSession);
  setPersistenceHook(async()=>store.put('account-session',await seal(exportSession(),this.env.SESSION_ENCRYPTION_KEY)));
  const server=createServer(),transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
  try{
   await server.connect(transport);
   const response=await transport.handleRequest(new Request(request.url,{method:'POST',headers:request.headers,body:raw}),{parsedBody:body});
   // Buffer the JSON response before releasing the per-account queue.
   const payload=await response.arrayBuffer();
   await store.put('account-session',await seal(exportSession(),this.env.SESSION_ENCRYPTION_KEY));
   return new Response(payload,{status:response.status,headers:response.headers});
  }finally{await transport.close();await server.close();}
 }
}
export default {fetch(request,env){return env.CHOWDECK_ACCOUNT.getByName('owner').fetch(request);}};
