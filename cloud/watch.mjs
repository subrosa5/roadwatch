// Bounded, on-demand passthrough video. No encoding or inference in the Worker.
export function createVideoRelay({env,camera,demand,read,write,stmt,bodyJSON,sha256,observation,fail,now}) {
 const response=(body,type,status=200)=>new Response(body,{status,headers:{'Content-Type':type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 return async function watch(id,request,auth,asset=null){
  await camera(id);const key='watch:'+id,root='watch/'+id+'/';
  if(request.method==='GET'){
   const manifest=await read(key);
   if(!manifest?.segments?.length)fail('Video relay is waiting for the collector',404);
   if(asset&&asset!=='playlist'){
    if(!manifest.segments.some(s=>s.hash===asset))fail('Video segment expired',404);
    const object=await env.BUCKET.get(root+asset+'.ts');if(!object)fail('Video segment expired',404);
    return response(object.body,'video/mp2t');
   }
   const stale=Date.now()-Date.parse(manifest.segments.at(-1).captured_at)>20000;
   if(asset==='playlist'){
    if(stale)fail('Video relay is stale',503);
    const segments=manifest.segments;
    const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:'+Math.ceil(Math.max(...segments.map(s=>s.end-s.start))-.001),'#EXT-X-MEDIA-SEQUENCE:'+segments[0].media_sequence,'#EXT-X-INDEPENDENT-SEGMENTS'];
    for(let i=0;i<segments.length;i++){const s=segments[i];if(i&&Math.abs(s.start-segments[i-1].end)>.1)lines.push('#EXT-X-DISCONTINUITY');lines.push('#EXT-X-PROGRAM-DATE-TIME:'+new Date(Date.parse(manifest.timeline_origin)+s.start*1000).toISOString(),'#EXTINF:'+(s.end-s.start).toFixed(6)+',',s.hash+'.ts');}
    return response(lines.join('\n')+'\n','application/vnd.apple.mpegurl');
   }
   return {session_id:manifest.session_id,timeline_origin:manifest.timeline_origin,segments:manifest.segments,stale,frame_age_ms:Date.now()-Date.parse(manifest.segments.at(-1).captured_at)};
  }
  if(!auth.service)fail('Collector role required',403);
  const view=await demand(id,auth);if(!view.active||!view.kinds.includes('tracking'))return {stored:false,reason:'no_viewer'};
  const raw=await bodyJSON(request),finite=Number.isFinite;
  if(!/^[a-f0-9]{32}$/.test(raw.session_id||'')||!Number.isInteger(raw.sequence)||raw.sequence<0||raw.sequence>1000000)fail('Invalid video session');
  if(!finite(raw.start)||!finite(raw.end)||raw.start<0||raw.end<=raw.start||raw.end-raw.start>10||raw.end>86400)fail('Invalid video interval');
  const captured=Date.parse(raw.captured_at),origin=Date.parse(raw.timeline_origin);
  if(!finite(captured)||captured>Date.now()+5000||captured<Date.now()-20000||!finite(origin)||origin>Date.now()+5000||origin<Date.now()-86400000)fail('Stale video segment');
  let bytes;try{if(typeof raw.data!=='string'||raw.data.length>800000)throw Error();bytes=Uint8Array.from(atob(raw.data),c=>c.charCodeAt(0));}catch{fail('Invalid video bytes');}
  if(bytes.length<188||bytes.length>600000||bytes.length%188||bytes[0]!==0x47||bytes[188]!==0x47)fail('MPEG-TS required');
  if(!Array.isArray(raw.observations)||raw.observations.length>60)fail('Invalid video observations');
  const observations=raw.observations.map(input=>{
   const o=observation(input,Date.now(),{maxAgeMs:60000});
   if(o.camera_id!==id||o.detections.some(d=>d.label!=='vehicle')||!finite(input.media_time)||input.media_time<raw.start-1||input.media_time>raw.end+1)fail('Invalid media annotation');
   o.detections=o.detections.map((d,i)=>{const source=input.detections[i];if(!/^[a-zA-Z0-9-]{1,60}$/.test(source.track_id||''))fail('Invalid tracking identity');return {...d,track_id:source.track_id};});
   return {...o,media_time:input.media_time};
  });
  const hash=await sha256(bytes),previous=await read(key);
  if(previous?.session_id===raw.session_id&&previous.timeline_origin!==new Date(origin).toISOString())fail('Video clock changed',409);
  if(previous?.session_id===raw.session_id&&previous.segments.some(s=>s.hash===hash))return {stored:true,duplicate:true};
  if(previous?.session_id===raw.session_id&&previous.segments.at(-1).sequence>=raw.sequence)fail('Out-of-order video segment',409);
  const quota=await stmt(env,`INSERT INTO rw_probes(source_id,checked_at,data) VALUES(?,?,json_object('bytes',?)) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,data=json_set(rw_probes.data,'$.bytes',json_extract(rw_probes.data,'$.bytes')+?) WHERE json_extract(rw_probes.data,'$.bytes')+?<=209715200`,'watch-quota:'+now().slice(0,10),now(),bytes.length,bytes.length,bytes.length).run();
  if(!quota.meta.changes)fail('Daily video relay quota reached',429);
  await env.BUCKET.put(root+hash+'.ts',bytes,{httpMetadata:{contentType:'video/mp2t'}});
  const prior=previous?.session_id===raw.session_id?previous.segments:[];
  const media_sequence=(prior.at(-1)?.media_sequence??-1)+1;
  const segments=[...prior,{hash,sequence:raw.sequence,media_sequence,start:raw.start,end:raw.end,captured_at:new Date(captured).toISOString(),observations}].slice(-6);
  await write(key,{session_id:raw.session_id,timeline_origin:new Date(origin).toISOString(),segments});
  const retained=new Set(segments.map(s=>s.hash));
  for(const s of previous?.segments||[])if(!retained.has(s.hash))await env.BUCKET.delete(root+s.hash+'.ts');
  return {stored:true,segments:segments.length};
 };
}
