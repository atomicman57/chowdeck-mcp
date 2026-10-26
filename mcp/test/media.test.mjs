import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageUrl,downloadFoodImage} from '../dist/media.js';
test('food photos accept only known HTTPS image hosts without credentials or custom ports',()=>{
 assert.equal(imageUrl('https://files.chowdeck.com/images/food.jpg'),'https://files.chowdeck.com/images/food.jpg');
 for(const value of ['http://files.chowdeck.com/food.jpg','https://localhost/secret','https://files.chowdeck.com.attacker.test/food','https://user:password@files.chowdeck.com/food.jpg','https://files.chowdeck.com:8443/food.jpg','data:text/html,bad'])assert.equal(imageUrl(value),null);
});
test('MCP image response contains source bytes and never sends an account token',async()=>{
 let headers;
 const result=await downloadFoodImage('https://files.chowdeck.com/images/food.jpg',async(url,init)=>{headers=init.headers;return new Response(new Uint8Array([255,216,255,217]),{headers:{'content-type':'image/jpeg'}});});
 assert.equal(result.type,'image');assert.equal(result.mimeType,'image/jpeg');assert.equal(result.data,'/9j/2Q==');
 assert.equal(headers.Authorization,undefined);assert.equal(headers.authorization,undefined);
});
test('image fetching rejects hostile redirects, HTML and oversized responses',async()=>{
 await assert.rejects(downloadFoodImage('https://files.chowdeck.com/images/x',async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}})),/unsupported host/);
 await assert.rejects(downloadFoodImage('https://files.chowdeck.com/images/x',async()=>new Response('<html>',{headers:{'content-type':'text/html'}})),/not a supported food image/);
 await assert.rejects(downloadFoodImage('https://files.chowdeck.com/images/x',async()=>new Response('x',{headers:{'content-type':'image/jpeg','content-length':String(3*1024*1024)}})),/too large/);
});
