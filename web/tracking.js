// Playout of actual image/annotation pairs; no extrapolated vehicle positions.
export class TrackingBuffer {
  constructor({playoutDelayMs=0,maxBacklogMs=Infinity}={}){this.delay=playoutDelayMs;this.maxBacklog=maxBacklogMs;this.reset();}
  reset(){this.queue=[];this.last=-Infinity;this.anchor=null;}
  advanceTo(frame){
    const at=Date.parse(frame?.observation?.captured_at);
    if(!Number.isFinite(at)||at<=this.last)return false;
    this.last=at;this.queue=this.queue.filter(f=>Date.parse(f.observation.captured_at)>at);this.anchor=null;
    return true;
  }
  trimBacklog(){
    if(!this.queue.length)return;
    const cutoff=Date.parse(this.queue.at(-1).observation.captured_at)-this.maxBacklog;
    this.queue=this.queue.filter(f=>Date.parse(f.observation.captured_at)>=cutoff);
  }
  add(frames){
    for(const frame of frames){
      const at=Date.parse(frame?.observation?.captured_at);
      if(!Number.isFinite(at)||at<=this.last||this.queue.some(f=>f.observation.frame_id===frame.observation.frame_id))continue;
      this.queue.push(frame);
    }
    this.queue.sort((a,b)=>Date.parse(a.observation.captured_at)-Date.parse(b.observation.captured_at));
    if(this.queue.length>24){this.queue=this.queue.slice(-24);this.anchor=null;}
    // Only trim when starting/recovering. A new packet must not evict the
    // unplayed tail of the previous one from an established source timeline.
    if(!this.anchor)this.trimBacklog();
  }
  take(now){
    if(!this.queue.length)return null;
    const first=Date.parse(this.queue[0].observation.captured_at);
    if(this.anchor&&first-(this.anchor.at+now-this.anchor.wall)>1500)this.anchor=null;
    if(!this.anchor){this.trimBacklog();this.anchor={at:Date.parse(this.queue[0].observation.captured_at),wall:now+this.delay};}
    const due=this.anchor.at+now-this.anchor.wall;
    let result=null;
    while(this.queue.length&&Date.parse(this.queue[0].observation.captured_at)<=due)result=this.queue.shift();
    if(result)this.last=Date.parse(result.observation.captured_at);
    return result;
  }
}
