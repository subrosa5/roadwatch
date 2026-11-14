import { signingKey, subscription, pushRequest } from './push.mjs';

export function createRuntime({env,config,observation,fail,first,rows,stmt,bodyJSON,sha256,now}) {
  const read = async id => {const r=await first(env,'SELECT checked_at,data FROM rw_probes WHERE source_id=?',id);return r?{...JSON.parse(r.data),received_at:r.checked_at}:null;};
  const write = (id,data,time=now()) => stmt(env,'INSERT INTO rw_probes(source_id,checked_at,data) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,data=excluded.data',id,time,JSON.stringify(data)).run();
  const camera = async id => {
    if(!config.some(c=>c.id===id && !c.demo)) fail('Unknown real camera',404);
    const row=await first(env,'SELECT data FROM rw_cameras WHERE id=?',id);
    const c=row&&JSON.parse(row.data);
    if(!c?.enabled || !c?.approved)fail('Camera not enabled',403);
    return c;
  };
  async function heartbeat(id,request,auth) {
    if(!auth.service)fail('Collector role required',403);
    await camera(id);
    const raw=await bodyJSON(request);
    if(!['starting','running','backoff','stopped','quota_exhausted'].includes(raw.state))fail('Invalid collector state');
    const finite=(v,min,max)=>Number.isFinite(v)&&v>=min&&v<=max;
    if(!finite(raw.frames_analyzed,0,1e10)||!finite(raw.cpu_seconds,0,1e9)||!finite(raw.uptime_seconds,0,1e9)||!finite(raw.fps,.1,30))fail('Invalid collector counters');
    let last=null;try{last=raw.last_frame_at===null?null:new Date(raw.last_frame_at).toISOString();}catch{fail("Invalid frame time");}
    if(last && (Date.parse(last)>Date.now()+5000 || Date.parse(last)<Date.now()-86400000))fail('Invalid frame time');
    const data={camera_id:id,state:raw.state,frames_analyzed:raw.frames_analyzed,cpu_seconds:raw.cpu_seconds,uptime_seconds:raw.uptime_seconds,fps:raw.fps,last_frame_at:last,model:String(raw.model||'').slice(0,120),capabilities:Array.isArray(raw.capabilities)?raw.capabilities.filter(x=>['fire','smoke','collision_experimental','vehicle_tracking'].includes(x)).slice(0,3):[],last_error:['network','stream','inference','auth','quota',null].includes(raw.last_error)?raw.last_error:null};
    await write('collector:'+id,data);
    return {stored:true,received_at:now()};
  }
  async function health(id) {
    const h=await read('collector:'+id);if(!h)return {online:false,state:'not_started',last_frame_at:null};
    const heartbeat_fresh=Date.now()-Date.parse(h.received_at)<180000;
    const frame_fresh=h.last_frame_at && Date.now()-Date.parse(h.last_frame_at)<20000;
    return {...h,heartbeat_fresh,frame_fresh:!!frame_fresh,online:!!(heartbeat_fresh&&frame_fresh&&h.state==='running')};
  }
  async function viewing(id,request,auth) {
    await camera(id);
    if(request.method==='DELETE') {await stmt(env,'DELETE FROM rw_probes WHERE source_id=?','view:'+id).run();return {active:false};}
    const raw=await bodyJSON(request),kind=raw.kind||'analysis';if(!['analysis','tracking'].includes(kind))fail('Invalid viewer mode');
    const until=new Date(Date.now()+35000).toISOString();await write('view:'+id,{until,kind});return {active:true,until};
  }
  async function demand(id,auth) {
    if(!auth.service)fail('Collector role required',403);
    await camera(id);
    const v=await read('view:'+id);return {active:!!v&&Date.parse(v.until)>Date.now(),until:v?.until||null,kind:v?.kind||'analysis',preview_interval_seconds:5};
  }
  async function preview(id,request,auth) {
    await camera(id);
    const key='previews/'+id+'.jpg';
    if(request.method==='GET') {
      const object=await env.BUCKET.get(key);if(!object)fail('No analyzed preview yet',404);
      const raw=object.customMetadata?.observation;if(!raw)fail('Preview metadata missing',409);
      const meta=JSON.parse(raw),bytes=new Uint8Array(await new Response(object.body).arrayBuffer());
      let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.slice(i,i+8192));
      return {observation:meta,jpeg:btoa(binary),stale:Date.now()-Date.parse(meta.captured_at)>20000};
    }
    if(!auth.service)fail('Collector role required',403);
    const view=await demand(id,auth);if(!view.active)return {stored:false,reason:'no_viewer'};
    const raw=await bodyJSON(request),o=observation(raw.observation);
    if(o.camera_id!==id)fail('Camera mismatch');
    if(Date.now()-Date.parse(o.captured_at)>20000)fail('Preview too old');
    let bytes;try{if(typeof raw.jpeg!=='string'||raw.jpeg.length>350000)throw Error();bytes=Uint8Array.from(atob(raw.jpeg),c=>c.charCodeAt(0));}catch{fail('Invalid preview JPEG');}
    if(bytes.length>256*1024||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail('JPEG required');
    const reserved=await stmt(env,`INSERT INTO rw_probes(source_id,checked_at,data) VALUES(?,?,json_object('count',1)) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,data=json_set(rw_probes.data,'$.count',json_extract(rw_probes.data,'$.count')+1) WHERE json_extract(rw_probes.data,'$.count')<6000`,'preview-quota:'+now().slice(0,10),now()).run();
    if(!reserved.meta.changes)fail('Daily preview quota reached',429);
    const total=o.detections.length;
    while(new TextEncoder().encode(JSON.stringify(o)).length>1700 && o.detections.length)o.detections.pop();
    if(new TextEncoder().encode(JSON.stringify(o)).length>1700)fail('Preview metadata too large');
    await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:'image/jpeg'},customMetadata:{observation:JSON.stringify(o),captured_at:o.captured_at}});
    return {stored:true,frame_id:o.frame_id,detections_returned:o.detections.length,detections_total:total};
  }
  async function tracking(id,request,auth) {
    await camera(id);const key='tracking/'+id+'.json';
    if(request.method==='GET') {
      const object=await env.BUCKET.get(key);if(!object)fail('No tracking frames yet',404);
      const data=JSON.parse(await new Response(object.body).text());
      return {...data,stale:Date.now()-Date.parse(data.observation.captured_at)>3000};
    }
    if(!auth.service)fail('Collector role required',403);
    const view=await demand(id,auth);if(!view.active||view.kind!=='tracking')return {stored:false,reason:'no_viewer'};
    const raw=await bodyJSON(request),o=observation(raw.observation);
    if(o.camera_id!==id||o.detections.some(d=>d.label!=='vehicle'))fail('Invalid tracking camera or labels');
    if(Date.now()-Date.parse(o.captured_at)>5000)fail('Tracking frame too old');
    let bytes;try{if(typeof raw.jpeg!=='string'||raw.jpeg.length>350000)throw Error();bytes=Uint8Array.from(atob(raw.jpeg),c=>c.charCodeAt(0));}catch{fail('Invalid tracking JPEG');}
    if(bytes.length>256*1024||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail('JPEG required');
    if(await sha256(bytes)!==o.frame_id)fail('Tracking frame hash mismatch');
    o.detections=o.detections.map((d,i)=>{
      const source=raw.observation.detections[i];
      if(typeof source.track_id!=='string'||! /^[a-zA-Z0-9-]{1,60}$/.test(source.track_id)||!['detector','optical_flow'].includes(source.tracking_method))fail('Invalid tracking identity');
      return {...d,track_id:source.track_id,tracking_method:source.tracking_method};
    });
    const reserved=await stmt(env,`INSERT INTO rw_probes(source_id,checked_at,data) VALUES(?,?,json_object('count',1)) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,data=json_set(rw_probes.data,'$.count',json_extract(rw_probes.data,'$.count')+1) WHERE json_extract(rw_probes.data,'$.count')<24000`,'tracking-quota:'+now().slice(0,10),now()).run();
    if(!reserved.meta.changes)fail('Daily tracking display quota reached',429);
    await env.BUCKET.put(key,new TextEncoder().encode(JSON.stringify({observation:o,jpeg:raw.jpeg})),{httpMetadata:{contentType:'application/json'},customMetadata:{captured_at:o.captured_at}});
    return {stored:true,frame_id:o.frame_id};
  }
  async function pushSettings() {
    const {publicKey}=await signingKey(env.INGEST_TOKEN);
    await stmt(env,"DELETE FROM rw_probes WHERE source_id LIKE 'subscription:%' AND json_extract(data,'$.public_key')<>?",publicKey).run();
    const n=await first(env,"SELECT COUNT(*) AS n FROM rw_probes WHERE source_id LIKE 'subscription:%'");
    return {available:true,public_key:publicKey,subscriptions:n.n,requires_browser_permission:true};
  }
  async function subscribe(request,auth) {
    if(auth.service)fail('Viewer role required',403);
    let sub;try{sub=subscription(await bodyJSON(request));}catch{fail('Unsupported or invalid push subscription');}
    const id='subscription:'+await sha256(new TextEncoder().encode(sub.endpoint));
    if(request.method==='DELETE'){await stmt(env,'DELETE FROM rw_probes WHERE source_id=?',id).run();return {removed:true};}
    const settings=await pushSettings(),old=await read(id);
    if(!old&&settings.subscriptions>=5)fail('Subscription limit reached',429);
    await write(id,{...sub,public_key:settings.public_key});return {stored:true};
  }
  function queueStatement(eventId) {
    return stmt(env,`INSERT OR IGNORE INTO rw_probes(source_id,checked_at,data)
      SELECT 'pushq:'||?||':'||source_id,?,json_object('event_id',?,'subscription_id',source_id,'state','pending','attempts',0,'next_attempt',?)
      FROM rw_probes WHERE source_id LIKE 'subscription:%' AND EXISTS(SELECT 1 FROM rw_events WHERE id=? AND demo=0)`,eventId,now(),eventId,new Date(Date.now()+25000).toISOString(),eventId);
  }
  async function dispatch(fetcher,origin) {
    const pending=await rows(env,"SELECT source_id,data FROM rw_probes WHERE source_id LIKE 'pushq:%' AND json_extract(data,'$.state')='pending' AND json_extract(data,'$.next_attempt')<=? LIMIT 2",now());
    const result={sent:0,retry:0,removed:0,failed:0};
    for(const row of pending) {
      const q=JSON.parse(row.data),sub=await read(q.subscription_id);
      const event=await first(env,'SELECT * FROM rw_events WHERE id=?',q.event_id);
      const finish=async state=>{q.state=state;await write(row.source_id,q);};
      if(!sub||!event||event.demo||event.status==='dismissed'||Date.now()-Date.parse(event.created_at)>86400000){await finish('discarded');continue;}
      const key=await signingKey(env.INGEST_TOKEN);
      if(sub.public_key!==key.publicKey){await stmt(env,'DELETE FROM rw_probes WHERE source_id=?',q.subscription_id).run();await finish('expired');result.removed++;continue;}
      q.attempts++;
      // Lease before network I/O; interrupted delivery can be retried after a
      // minute. Browser notification tags suppress duplicate visible notices.
      q.next_attempt=new Date(Date.now()+60000).toISOString();await write(row.source_id,q);
      try {
        const c=config.find(c=>c.id===event.camera_id),names={fire:'Возможное пламя',smoke:'Возможный дым',collision:'Возможное ДТП'};
        const prepared=await pushRequest(sub,{title:names[event.type]||'Кандидат на событие',body:(c?.name||event.camera_id)+' · требуется проверка',event_id:event.id,url:'/?event='+encodeURIComponent(event.id),tag:'roadwatch-'+event.id},env.INGEST_TOKEN,origin);
        const response=await fetcher(prepared.url,prepared.options);await response.body?.cancel();
        if(response.ok){await finish('sent');result.sent++;}
        else if([404,410].includes(response.status)){await stmt(env,'DELETE FROM rw_probes WHERE source_id=?',q.subscription_id).run();await finish('expired');result.removed++;}
        else if(response.status===429||response.status>=500)throw Error('Retryable push service');
        else {await finish('failed');result.failed++;}
      }catch{
        if(q.attempts>=5){await finish('failed');result.failed++;}
        else {q.next_attempt=new Date(Date.now()+Math.min(3600,30*2**q.attempts)*1000).toISOString();await write(row.source_id,q);result.retry++;}
      }
    }
    return result;
  }
  return {read,write,heartbeat,health,viewing,demand,preview,tracking,pushSettings,subscribe,queueStatement,dispatch};
}
