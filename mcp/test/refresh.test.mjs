import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.CHOWDECK_SESSION_PERSISTENCE='memory';
let refreshes=0,charges=0,gets=0;
const server=http.createServer(async(req,res)=>{
 let chunks=[];for await(const c of req)chunks.push(c);const data=chunks.length?JSON.parse(Buffer.concat(chunks)):{};
 res.setHeader('content-type','application/json');
 if(req.url==='/auth/refresh-token'){refreshes++;assert.ok(data.token);return res.end(JSON.stringify({token:'renewed-session'}));}
 if(req.headers.authorization!=='Bearer renewed-session'){res.statusCode=401;return res.end(JSON.stringify({message:'Token expired'}));}
 if(req.url==='/customer/order/123/tip'){charges++;return res.end('{"data":{"ok":true}}');}
 gets++;return res.end('{"data":{"id":1}}');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));process.env.CHOWDECK_API_BASE=`http://127.0.0.1:${server.address().port}`;
const api=await import('../dist/api.js');const {session}=await import('../dist/session.js');
test('concurrent expiry responses share one refresh and persist the renewed token',async()=>{
 session.token='expired-session';await Promise.all([api.getMe(),api.getWallet()]);assert.equal(refreshes,1);assert.equal(session.token,'renewed-session');assert.equal(gets,2);
});
test('explicit 401 authentication rejection permits one safe replay, with only one successful charge',async()=>{
 session.token='expired-session-again';await api.tipRider('123',50000);assert.equal(charges,1);assert.equal(session.token,'renewed-session');
});
test('near-expiry JWT is renewed before making the protected request',async()=>{
 const count=refreshes;session.token='header.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+15})).toString('base64url')+'.signature';await api.getMe();assert.equal(refreshes,count+1);assert.equal(session.token,'renewed-session');
});
import {after} from 'node:test';after(()=>server.close());
