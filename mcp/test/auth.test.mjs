import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
process.env.CHOWDECK_SESSION_PERSISTENCE='memory';
let reply={data:{token:'synthetic-session-token'}},sends=0;
const mock=http.createServer(async(req,res)=>{
 for await(const chunk of req){};
 res.setHeader('content-type','application/json');
 if(req.url==='/auth/login'){sends++;res.statusCode=400;return res.end(JSON.stringify({status:'failed',message:'Security check failed. Please refresh the page and try again.'}));}
 return res.end(JSON.stringify(reply));
});
await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
process.env.CHOWDECK_API_BASE=`http://127.0.0.1:${mock.address().port}`;
const api=await import('../dist/api.js');const {session}=await import('../dist/session.js');
after(()=>mock.close());
test('security rejection explains the browser handoff without retrying OTP requests',async()=>{
 await assert.rejects(api.sendLoginOtp('08012345678'),e=>{assert.equal(e.response.data.status,'browser_verification_required');assert.equal(e.response.data.otp_sent,false);assert.equal(e.response.data.login_url,'https://chowdeck.com/store/sign-in');return true;});assert.equal(sends,1);
});
test('OTP verification stores a login but returns no token for either supported response shape',async()=>{
 for(const payload of [{data:{token:'synthetic-session-token'}},{token:'synthetic-session-token'}]){
  session.token=null;reply=payload;const result=await api.verifyOtp('08012345678','0000');assert.equal(session.token,'synthetic-session-token');assert.deepEqual(result,{status:'success',authenticated:true});assert.ok(!JSON.stringify(result).includes('synthetic-session-token'));
 }
});
test('a nominally successful OTP response without a token never claims authenticated success',async()=>{
 session.token=null;reply={status:'success',data:{}};await assert.rejects(api.verifyOtp('08012345678','0000'),/did not establish a login/);assert.equal(session.token,null);
});
