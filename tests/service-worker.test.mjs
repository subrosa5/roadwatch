import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('push-only service worker displays a tagged message and does not cache private pages',async()=>{
 const handlers={},shown=[];
 const self={location:{origin:'https://roadwatch.test'},addEventListener:(name,fn)=>handlers[name]=fn,registration:{showNotification:async(...args)=>shown.push(args)}};
 vm.runInNewContext(readFileSync('web/sw.js','utf8'),{self,URL});
 assert.equal(handlers.fetch,undefined);
 let work;
 handlers.push({data:{json:()=>({title:'Possible smoke',body:'Review required',tag:'event-1',url:'/?event=one'})},waitUntil:p=>work=p});
 await work;assert.equal(shown.length,1);assert.equal(shown[0][1].tag,'event-1');
 assert.equal(shown[0][1].renotify,false);
});
test('notification click opens only this site and reuses an existing window',async()=>{
 const handlers={};let navigated,focused=false,closed=false;
 const self={location:{origin:'https://roadwatch.test'},addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>[{url:'https://roadwatch.test/',navigate:async url=>navigated=url,focus:async()=>focused=true}]}};
 vm.runInNewContext(readFileSync('web/sw.js','utf8'),{self,URL});
 let work;
 handlers.notificationclick({notification:{close:()=>closed=true,data:{url:'https://attacker.test/'}},waitUntil:p=>work=p});
 await work;assert.equal(navigated,'https://roadwatch.test/');assert.ok(focused&&closed);
});
