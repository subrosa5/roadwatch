"""Evaluate the experimental classifier on a local video; never sends API events."""
import argparse
import json
from pathlib import Path
import sys
import time
import resource
import platform
import cv2

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from collector.collision import TemporalCollisionDetector

parser=argparse.ArgumentParser()
parser.add_argument('--video',required=True)
parser.add_argument('--models',required=True)
args=parser.parse_args()
lock=json.loads((ROOT/'collector/botkeep/collision.lock.json').read_text())
items=[{**x,'path':str(Path(args.models)/x['name'])} for x in lock['files']]
detector=TemporalCollisionDetector(items[0],items[1],lock['metadata'])
video=cv2.VideoCapture(args.video)
fps=video.get(cv2.CAP_PROP_FPS)
if not video.isOpened() or fps<=0: raise ValueError('Video unavailable or unknown FPS')
cv2.setNumThreads(1)
start=time.process_time();results=[];count=0
while True:
    ok,frame=video.read()
    if not ok:break
    timestamp=count/fps
    result=detector.sample(frame,timestamp)
    if result:results.append(result)
    count+=1
video.release()
print(json.dumps({'frames':count,'source_fps':fps,'windows':len(results),'scores':[r['score'] for r in results],
                  'candidate_windows':sum(r['candidate'] for r in results),
                  'cpu_seconds':time.process_time()-start,
                  'rss_mib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss/(1024**2 if platform.system()=='Darwin' else 1024),
                  'domain_validated':False,'production_events_enabled':False}))
