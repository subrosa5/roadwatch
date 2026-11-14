"""Process a recorded public camera sample with real weights; never writes events."""
from pathlib import Path
import argparse,json,sys,time,tempfile,subprocess
import cv2
import imageio_ffmpeg
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from collector.vehicles import VehicleDetector,VehicleTracker
p=argparse.ArgumentParser();p.add_argument('--video',required=True);p.add_argument('--model',required=True);p.add_argument('--output',required=True);a=p.parse_args()
lock=json.loads(Path('collector/botkeep/vehicle.lock.json').read_text());tracker=VehicleTracker(VehicleDetector({**lock,'path':a.model}))
v=cv2.VideoCapture(a.video);fps=v.get(cv2.CAP_PROP_FPS);w,h=int(v.get(3)),int(v.get(4));i=0;last=-1;report=[];started=time.process_time()
if not v.isOpened() or not fps:raise ValueError('Video unavailable')
with tempfile.TemporaryDirectory() as d:
 raw=Path(d)/'frames.mp4';writer=cv2.VideoWriter(str(raw),cv2.VideoWriter_fourcc(*'mp4v'),5,(w,h))
 while True:
  ok,image=v.read()
  if not ok:break
  t=i/fps;i+=1
  if t-last<.199:continue
  last=t;tracks=tracker.update(image,t)
  report.append({'time':t,'tracks':tracks})
  for track in tracks:
   x,y,bw,bh=track['box'];x,y,r,b=int(x*w),int(y*h),int((x+bw)*w),int((y+bh)*h)
   cv2.rectangle(image,(x,y),(r,b),(70,255,100),1)
   cv2.putText(image,'vehicle #'+track['track_id'].split('-')[-1],(x,max(12,y-4)),cv2.FONT_HERSHEY_SIMPLEX,.33,(70,255,100),1)
  cv2.rectangle(image,(0,h-18),(w,h),(12,18,12),-1)
  cv2.putText(image,'RECORDED IOWA DOT / REAL NANODET + FLOW / NOT LIVE',(4,h-6),cv2.FONT_HERSHEY_SIMPLEX,.30,(180,230,190),1)
  writer.write(image)
 writer.release();v.release()
 subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y','-i',str(raw),'-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart',a.output],check=True)
result={'recorded_sample':True,'live':False,'synthetic_detections':False,'model_sha256':lock['sha256'],'sample_frames':len(report),'frames_with_tracks':sum(bool(r['tracks']) for r in report),'detector_tracks':sum(t['tracking_method']=='detector' for r in report for t in r['tracks']),'flow_tracks':sum(t['tracking_method']=='optical_flow' for r in report for t in r['tracks']),'distinct_track_ids':len({t['track_id'] for r in report for t in r['tracks']}),'cpu_seconds':time.process_time()-started,'quality_validated':False}
Path(a.output+'.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
