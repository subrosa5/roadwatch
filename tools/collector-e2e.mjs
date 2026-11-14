// Full collector -> private Worker API -> JPEG/MP4 round trip, on loopback only.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import assert from 'node:assert/strict';

execFileSync(process.execPath,['tools/build-cloud.mjs']);
const source=readFileSync('cloud-build/dist/server/index.js');
const {createWorker}=await import('data:text/javascript;base64,'+source.toString('base64'));
const sql=new DatabaseSync(':memory:');sql.exec(readFileSync('cloud/schema.sql','utf8'));
const DB={prepare(query){return{bind(...args){return{
 all:async()=>({results:sql.prepare(query).all(...args)}),first:async()=>sql.prepare(query).get(...args)||null,
 run:async()=>({meta:{changes:Number(sql.prepare(query).run(...args).changes)}}),
};}};},async batch(commands){sql.exec('BEGIN');try{const out=[];for(const c of commands)out.push(await c.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
const objects=new Map();
const BUCKET={async put(key,bytes,opts={}){objects.set(key,{bytes:Buffer.from(bytes),customMetadata:opts.customMetadata});},async delete(key){objects.delete(key);},async head(key){const o=objects.get(key);return o?{size:o.bytes.length,customMetadata:o.customMetadata}:null;},async get(key,options){const o=objects.get(key);return o?{customMetadata:o.customMetadata,body:options?.range?o.bytes.subarray(options.range.offset,options.range.offset+options.range.length):o.bytes}:null;}};
const token=randomBytes(32).toString('hex'),env={DB,BUCKET,INGEST_TOKEN:token},worker=createWorker();
const server=createServer(async(req,res)=>{
 try{const parts=[];for await(const b of req)parts.push(b);
 if(req.url.endsWith('/tracking')&&req.method==='POST')await new Promise(r=>setTimeout(r,600));
 const response=await worker.fetch(new Request('https://loopback.test'+req.url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(parts)}),env);
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Test harness failed');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const call=(path,method='GET',body)=>fetch(base+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
await call('/api/ops/init','POST',{});await call('/api/cameras/iowa-cbtv51/view','POST',{});
let log='';
const child=spawn(process.env.CV_PYTHON||'python3',['tools/collector_e2e.py'],{detached:true,env:{...process.env,INGEST_TOKEN:token,E2E_LOOPBACK_API:base,PYTHONUNBUFFERED:"1"},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',b=>{log=(log+b).slice(-5000);});child.stderr.on('data',b=>{log=(log+b).slice(-5000);});
try{
 const deadline=Date.now()+45000;let event,preview,stats,tracking,switched=false;
 while(Date.now()<deadline){
  if(child.exitCode!==null)throw Error('Collector exited: '+log);
  event=(await(await call('/api/events')).json())[0];
  stats=await(await call('/api/stats')).json();
  const r=await call('/api/cameras/iowa-cbtv51/preview');if(r.ok)preview=await r.json();
  if(preview&&!switched){await call('/api/cameras/iowa-cbtv51/view','POST',{kind:'tracking'});switched=true;}
  const tr=await call('/api/cameras/iowa-cbtv51/tracking');if(tr.ok)tracking=await tr.json();
  if(event?.evidence_id&&preview&&tracking?.observation?.detections?.length&&tracking.frames?.length>1&&stats.collectors_online===1)break;
  await new Promise(r=>setTimeout(r,1000));
 }
 assert.ok(event?.evidence_id,'Synthetic event clip was not persisted: '+JSON.stringify({stats,preview:!!preview,cameras:await(await call('/api/cameras')).json()})+' '+log);
 assert.ok(tracking?.observation?.detections[0]?.track_id,'Tracking transport missing');
 assert.equal(tracking.observation.frame_id,createHash('sha256').update(Buffer.from(tracking.jpeg,'base64')).digest('hex'));
 assert.ok(tracking.frames.length>1,'Slow transport must deliver multiple actual frames per packet');
 for(const f of tracking.frames)assert.equal(f.observation.frame_id,createHash('sha256').update(Buffer.from(f.jpeg,'base64')).digest('hex'));
 assert.ok(preview?.observation?.frame_id);assert.equal(stats.collectors_online,1);
 const r=await call('/api/evidence/'+event.evidence_id),bytes=Buffer.from(await r.arrayBuffer());
 assert.equal(bytes.subarray(4,8).toString(),'ftyp');
 const hash=createHash('sha256').update(bytes).digest('hex');assert.equal(r.headers.get('X-Content-SHA256'),hash);
 const range=await fetch(base+'/api/evidence/'+event.evidence_id,{headers:{Authorization:'Bearer '+token,Range:'bytes=4-7'}});assert.equal(range.status,206);assert.equal(await range.text(),'ftyp');
 console.log(JSON.stringify({synthetic_fixture:true,production_writes:false,collector_online:true,event_persisted:true,clip_bytes:bytes.length,clip_sha256:hash,range_playback:true,tracking_transport:true,tracking_batch_frames:tracking.frames.length,tracking_id:tracking.observation.detections[0].track_id,preview_frame_id:preview.observation.frame_id,preview_model:preview.observation.model}));
}finally{
 try{process.kill(-child.pid,'SIGTERM');}catch{}
 await new Promise(r=>server.close(r));sql.close();
}
