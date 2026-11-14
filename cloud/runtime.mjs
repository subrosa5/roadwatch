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
    // Telemetry arrives once per minute; display freshness is checked separately.
    const frame_fresh=h.last_frame_at && Date.now()-Date.parse(h.last_frame_at)<90000;
    return {...h,heartbeat_fresh,frame_fresh:!!frame_fresh,online:!!(heartbeat_fresh&&frame_fresh&&h.state==='running')};
  }
  async function viewing(id,request,auth) {
    await camera(id);
    const raw=request.method==='DELETE'&&!request.headers.get('content-type')?{}:await bodyJSON(request);
    const viewer=raw.viewer_id;
    if(viewer!==undefined&&(typeof viewer!=='string'||! /^[a-zA-Z0-9-]{1,80}$/.test(viewer)))fail('Invalid viewer ID');
    const key='view:'+id+(viewer?':'+viewer:'');
    if(request.method==='DELETE'){await stmt(env,'DELETE FROM rw_probes WHERE source_id=?',key).run();return {active:false};}
    const kind=raw.kind||'analysis';if(!['analysis','tracking'].includes(kind))fail('Invalid viewer mode');
    const until=new Date(Date.now()+35000).toISOString();await write(key,{until,kind});return {active:true,until};
  }
  async function demand(id,auth) {
    if(!auth.service)fail('Collector role required',403);
    await camera(id);
    const leases=await rows(env,'SELECT data FROM rw_probes WHERE source_id=? OR source_id LIKE ?','view:'+id,'view:'+id+':%');
    const active=leases.map(r=>JSON.parse(r.data)).filter(v=>Date.parse(v.until)>Date.now());
    const kinds=[...new Set(active.map(v=>v.kind||'analysis'))];
    return {active:!!active.length,until:active.map(v=>v.until).sort().at(-1)||null,kind:kinds.includes('tracking')?'tracking':'analysis',kinds,preview_interval_seconds:5,tracking_format:'batch-v1'};
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
      const stored=JSON.parse(await new Response(object.body).text());
      const frames=stored.frames||[{observation:stored.observation,jpeg:stored.jpeg}];
      const latest=frames.at(-1),age=Date.now()-Date.parse(latest.observation.captured_at);
      return {...latest,frames,stale:age>5000,frame_age_ms:age,received_at:stored.received_at||null,server_now:now()};
    }
    if(!auth.service)fail('Collector role required',403);
    const view=await demand(id,auth);if(!view.active||!view.kinds.includes('tracking'))return {stored:false,reason:'no_viewer'};
    const raw=await bodyJSON(request),items=raw.frames||[raw];
    if(!Array.isArray(items)||items.length<1||items.length>12)fail('Invalid tracking batch');
    let frames=[];let previous=-Infinity;
    for(const item of items){
      const o=observation(item.observation),timestamp=Date.parse(o.captured_at);
      if(o.camera_id!==id||o.detections.some(d=>d.label!=='vehicle'))fail('Invalid tracking camera or labels');
      if(timestamp<=previous)fail('Tracking frames must be chronological');previous=timestamp;
      let bytes;try{if(typeof item.jpeg!=='string'||item.jpeg.length>350000)throw Error();bytes=Uint8Array.from(atob(item.jpeg),c=>c.charCodeAt(0));}catch{fail('Invalid tracking JPEG');}
      if(bytes.length>256*1024||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)fail('JPEG required');
      if(await sha256(bytes)!==o.frame_id)fail('Tracking frame hash mismatch');
      o.detections=o.detections.map((d,i)=>{
        const source=item.observation.detections[i];
        if(typeof source.track_id!=='string'||! /^[a-zA-Z0-9-]{1,60}$/.test(source.track_id)||!['detector','optical_flow'].includes(source.tracking_method))fail('Invalid tracking identity');
        return {...d,track_id:source.track_id,tracking_method:source.tracking_method};
      });
      frames.push({observation:o,jpeg:item.jpeg});
    }
    const latest=frames.at(-1).observation;
    if(Date.now()-Date.parse(latest.captured_at)>5000)fail('Tracking frame too old');
    // A scheduling/network pause may mix old buffered frames with a fresh tail.
    // Validate every pair above, then discard the obsolete prefix for display.
    // The latest frame must still pass the same five-second freshness limit.
    frames=frames.filter(f=>Date.parse(f.observation.captured_at)>=Date.parse(latest.captured_at)-3000);
    // Keep a bounded recent window so browser polling cannot miss an entire
    // packet. Retained frames do not spend the daily display quota again.
    const old=await env.BUCKET.get(key);
    const stored=old?JSON.parse(await new Response(old.body).text()):null;
    const previousFrames=stored?(stored.frames||[{observation:stored.observation,jpeg:stored.jpeg}]):[];
    const known=new Set(previousFrames.map(f=>f.observation.frame_id));
    const count=frames.filter(f=>!known.has(f.observation.frame_id)).length;
    if(!count)return {stored:true,frame_id:latest.frame_id,frames_stored:0};
    if(previousFrames.length&&Date.parse(previousFrames.at(-1).observation.captured_at)>Date.parse(latest.captured_at))fail('Out-of-order tracking packet',409);
    const window=new Map(previousFrames.map(f=>[f.observation.frame_id,f]));
    for(const f of frames)window.set(f.observation.frame_id,f);
    const cutoff=Date.parse(latest.captured_at)-3000;
    let retained=[...window.values()].filter(f=>Date.parse(f.observation.captured_at)>=cutoff).sort((a,b)=>Date.parse(a.observation.captured_at)-Date.parse(b.observation.captured_at)).slice(-12);
    while(retained.length>1&&new TextEncoder().encode(JSON.stringify(retained)).length>800000)retained.shift();
    const reserved=await stmt(env,`INSERT INTO rw_probes(source_id,checked_at,data) VALUES(?,?,json_object('count',?)) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,data=json_set(rw_probes.data,'$.count',json_extract(rw_probes.data,'$.count')+?) WHERE json_extract(rw_probes.data,'$.count')+?<=24000`,'tracking-quota:'+now().slice(0,10),now(),count,count,count).run();
    if(!reserved.meta.changes)fail('Daily tracking display quota reached',429);
    await env.BUCKET.put(key,new TextEncoder().encode(JSON.stringify({frames:retained,received_at:now()})),{httpMetadata:{contentType:'application/json'},customMetadata:{captured_at:latest.captured_at}});
    return {stored:true,frame_id:latest.frame_id,frames_stored:count};
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
