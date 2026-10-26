import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChowdeckAccount} from '../hosting/worker.bundle.mjs';
const key='synthetic-owner-key-012345678901234567890';
const make=()=>{
 const map=new Map();const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,structuredClone(v)),delete:async k=>map.delete(k)};
 const env={OWNER_ACCESS_KEY:key,SESSION_ENCRYPTION_KEY:'12'.repeat(32)};
 return {account:new ChowdeckAccount({storage},env),map,storage,env};
};
const url='https://chowdeck.example';
const request=(path,init={})=>new Request(url+path,init);
const form=body=>({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
const sha=async v=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))).toString('base64url');
test('hosted MCP denies anonymous access and serves authenticated protocol with encrypted session storage',async()=>{
 const {account,map}=make();assert.equal((await account.fetch(request('/mcp',{method:'POST',body:'{}'}))).status,401);
 const call=async body=>account.fetch(request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${key}`,'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(body)}));
 const response=await call({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'test',version:'1'}}});
 assert.equal(response.status,200);assert.equal((await response.json()).result.serverInfo.name,'chowdeck');
 assert.ok(map.get('account-session').iv);assert.ok(!JSON.stringify(map.get('account-session')).includes('paymentPref'));
 const tools=await call({jsonrpc:'2.0',id:2,method:'tools/list'});assert.ok((await tools.json()).result.tools.length>=56);
});
test('OAuth checks consent cookie/origin, PKCE, redirect binding, code reuse and read-only scope',async()=>{
 const {account}=make();
 const reg=await account.fetch(request('/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_name:'Test agent',redirect_uris:['https://agent.example/callback']})}));
 assert.equal(reg.status,201);const {client_id}=await reg.json();
 const verifier='v'.repeat(64),challenge=await sha(verifier);
 const p=new URLSearchParams({client_id,redirect_uri:'https://agent.example/callback',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',state:'expected',scope:'chowdeck.read'});
 const page=await account.fetch(request('/authorize?'+p));assert.equal(page.status,200);const cookie=page.headers.get('set-cookie').split(';')[0];
 const html=await page.text();const csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 assert.equal((await account.fetch(request('/authorize',form({csrf,key})))).status,403);
 const approval=await account.fetch(request('/authorize',{...form({csrf,key}),headers:{...form({}).headers,origin:url,cookie}}));
 assert.equal(approval.status,302);const redirect=new URL(approval.headers.get('location'));assert.equal(redirect.searchParams.get('state'),'expected');const code=redirect.searchParams.get('code');
 const grant={grant_type:'authorization_code',client_id,redirect_uri:'https://agent.example/callback',code,code_verifier:verifier};
 const rejected=await account.fetch(request('/token',form({...grant,code_verifier:'bad'})));assert.equal(rejected.status,400);assert.equal((await rejected.json()).error_description,'pkce_mismatch');
 assert.equal((await account.fetch(request('/oauth-status'))).status,401);
 const status=await(await account.fetch(request('/oauth-status',{headers:{Authorization:`Bearer ${key}`}}))).json();assert.equal(status.last_event.reason,'pkce_mismatch');assert.ok(!JSON.stringify(status).includes(code));
 const token=await(await account.fetch(request('/token',form(grant)))).json();assert.ok(token.access_token);
 assert.equal((await account.fetch(request('/token',form(grant)))).status,400);
 const write=await account.fetch(request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${token.access_token}`,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'place_order',arguments:{confirm:true}}})}));assert.equal(write.status,403);
 const refresh=await(await account.fetch(request('/token',form({grant_type:'refresh_token',client_id,refresh_token:token.refresh_token})))).json();assert.ok(refresh.access_token);
 assert.equal((await account.fetch(request('/token',form({grant_type:'refresh_token',client_id,refresh_token:token.refresh_token})))).status,400);
});

test('encrypted account state survives a new hosted instance',async()=>{
 const {account,map,storage,env}=make();
 const call=(target,body)=>target.fetch(request('/mcp',{method:'POST',headers:{Authorization:`Bearer ${key}`,'content-type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(body)}));
 await call(account,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'set_payment_pref',arguments:{mode:'default',payment_method:'wallet'}}});
 const restarted=new ChowdeckAccount({storage},env);
 const result=await(await call(restarted,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_session',arguments:{}}})).json();
 assert.equal(result.result.structuredContent.payment_pref.paymentMethod,'wallet');
 assert.ok(!JSON.stringify(map.get('account-session')).includes('wallet'));
});

test('browser sign-in is owner/CSRF protected and does not send an OTP on page load',async()=>{
 const {account}=make();
 const locked=await account.fetch(request('/setup'));assert.equal(locked.status,200);const cookie=locked.headers.get('set-cookie').split(';')[0];
 const html=await locked.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
 assert.equal((await account.fetch(request('/setup/send-otp',{...form({phone:'08012345678'}),headers:{...form({}).headers,origin:url}}))).status,401);
 const unlock=await account.fetch(request('/setup/unlock',{...form({key,csrf}),headers:{...form({}).headers,origin:url,cookie}}));assert.equal(unlock.status,303);
 const admin=unlock.headers.get('set-cookie').split(';')[0];
 const page=await account.fetch(request('/setup',{headers:{cookie:admin}}));assert.equal(page.status,200);assert.match(await page.text(),/I requested a code on Chowdeck/);
 const external=await account.fetch(request('/setup/use-code',{...form({phone:'08012345678'}),headers:{...form({}).headers,origin:url,cookie:admin}}));assert.equal(external.status,303);
 const codePage=await account.fetch(request('/setup',{headers:{cookie:admin}}));assert.match(await codePage.text(),/One-time code/);
 assert.equal((await account.fetch(request('/setup/use-code',form({phone:'08012345678'})))).status,403);
});
