// Boxes are interpolated only between actual measurements of the same ID.
// Images remain original continuous video; no generated or repeated pictures.
export function mediaBoxes(manifest,programDate){
 if(!manifest||manifest.stale||!Number.isFinite(programDate))return [];
 const time=(programDate-Date.parse(manifest.timeline_origin))/1000;
 const observations=manifest.segments.flatMap(s=>s.observations).sort((a,b)=>a.media_time-b.media_time);
 const before=observations.filter(o=>o.media_time<=time).at(-1);
 const after=observations.find(o=>o.media_time>time);
 if(!before||time-before.media_time>.55)return [];
 if(!after||after.media_time-before.media_time>1.1)return time-before.media_time<.2?before.detections:[];
 const ratio=(time-before.media_time)/(after.media_time-before.media_time);
 return before.detections.flatMap(box=>{
  const next=after.detections.find(d=>d.track_id===box.track_id);
  if(!next)return time-before.media_time<.2?[box]:[];
  return [{...box,box:box.box.map((v,i)=>v+(next.box[i]-v)*ratio)}];
 });
}
