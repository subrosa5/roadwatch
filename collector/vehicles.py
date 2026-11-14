"""CPU vehicle detection and short-term tracking; no incident/identity inference."""
import hashlib
import math
import cv2
import numpy as np
try:
    from .vendor.nanodet import NanoDet
except ImportError:
    from vendor.nanodet import NanoDet


def iou(a,b):
    x,y=max(a[0],b[0]),max(a[1],b[1]);r,s=min(a[0]+a[2],b[0]+b[2]),min(a[1]+a[3],b[1]+b[3])
    inter=max(0,r-x)*max(0,s-y)
    return inter/max(1e-9,a[2]*a[3]+b[2]*b[3]-inter)

class VehicleDetector:
    def __init__(self,config):
        from pathlib import Path
        if hashlib.sha256(Path(config['path']).read_bytes()).hexdigest()!=config['sha256']:raise ValueError('Vehicle model hash mismatch')
        self.new_track_threshold=float(config.get('new_track_threshold',config.get('threshold',.35)))
        self.net=NanoDet(config['path'],prob_threshold=config.get('threshold',.35))
        cv2.setNumThreads(1)
    def detect(self,image):
        h,w=image.shape[:2];scale=min(416/w,416/h);nw,nh=round(w*scale),round(h*scale);x,y=(416-nw)//2,(416-nh)//2
        canvas=np.zeros((416,416,3),np.uint8);canvas[y:y+nh,x:x+nw]=cv2.resize(image,(nw,nh))
        result=[]
        for row in self.net.infer(canvas):
            if int(row[5]) not in {2,3,5,7}:continue # COCO car, motorcycle, bus, truck
            x1,y1=max(0,(row[0]-x)/scale/w),max(0,(row[1]-y)/scale/h)
            x2,y2=min(1,(row[2]-x)/scale/w),min(1,(row[3]-y)/scale/h)
            if x2>x1 and y2>y1:result.append({'label':'vehicle','score':float(row[4]),'box':[float(x1),float(y1),float(x2-x1),float(y2-y1)]})
        # All vehicle classes share one label and must not duplicate each other.
        keep=[]
        for d in sorted(result,key=lambda d:d['score'],reverse=True):
            if all(iou(d['box'],other['box'])<.45 for other in keep):keep.append(d)
        return keep[:50]

class VehicleTracker:
    """Detection anchoring + measured optical flow; never extrapolates lost objects."""
    def __init__(self,detector,detect_interval=.5,max_gap=1.5):
        self.detector=detector;self.interval=detect_interval;self.max_gap=max_gap;self.reset()
    def reset(self):
        self.tracks=[];self.lost=[];self.previous=None;self.last=None;self.last_detect=-math.inf;self.next_id=1
        self.session=__import__('secrets').token_hex(4)
    def update(self,image,timestamp):
        if not math.isfinite(timestamp):raise ValueError('Invalid frame timestamp')
        if self.last is not None and (timestamp<=self.last or timestamp-self.last>self.max_gap):self.reset()
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY);h,w=gray.shape
        if self.previous is not None and self.previous.shape!=gray.shape:self.reset()
        if self.previous is not None:
            alive=[];lost=[];groups=[];corners=[];offset=0
            for t in self.tracks:
                x,y,bw,bh=t['box']
                x1,y1=max(0,int(x*w)),max(0,int(y*h));x2,y2=min(w,int((x+bw)*w)),min(h,int((y+bh)*h))
                if x2-x1<3 or y2-y1<3:
                    lost.append(t);continue
                # Detect features only inside this object, not the whole image.
                points=cv2.goodFeaturesToTrack(self.previous[y1:y2,x1:x2],maxCorners=20,qualityLevel=.01,minDistance=2)
                if points is None or len(points)<3:
                    lost.append(t);continue
                points+=np.array([x1,y1],dtype=np.float32)
                groups.append((t,offset,len(points)));corners.append(points);offset+=len(points)
            if corners:
                points=np.concatenate(corners,axis=0)
                # One shared forward/backward pyramid for all objects.
                moved,status,_=cv2.calcOpticalFlowPyrLK(self.previous,gray,points,None,winSize=(15,15),maxLevel=2)
                back=good=None
                if moved is not None and status is not None:
                    finite=np.isfinite(moved).all(axis=(1,2))
                    moved=np.where(np.isfinite(moved),moved,points)
                    back,good,_=cv2.calcOpticalFlowPyrLK(gray,self.previous,moved,None,winSize=(15,15),maxLevel=2)
                valid=np.zeros(len(points),dtype=bool)
                if back is not None and good is not None:
                    valid=finite&(status.reshape(-1)>0)&(good.reshape(-1)>0)&(np.linalg.norm((back-points).reshape(-1,2),axis=1)<1.5)
                for t,start,count in groups:
                    selected=valid[start:start+count]
                    if selected.sum()<3:
                        lost.append(t);continue
                    delta=(moved[start:start+count]-points[start:start+count]).reshape(-1,2)[selected]
                    dx,dy=np.median(delta,axis=0)/[w,h]
                    x,y,bw,bh=t['box']
                    nx,ny=float(np.clip(x+dx,0,1-bw)),float(np.clip(y+dy,0,1-bh))
                    if timestamp-t['detected_at']<=self.max_gap:alive.append({**t,'box':[nx,ny,bw,bh],'tracking_method':'optical_flow'})
            self.lost=[t for t in self.lost+lost if timestamp-t['detected_at']<=self.max_gap]
            self.tracks=alive
        if timestamp-self.last_detect>=self.interval:
            detections=self.detector.detect(image)
            threshold=getattr(self.detector,'new_track_threshold',.35)
            # High-score detections associate first. Low-score detections can
            # recover an existing ID, but cannot create a new object on their own.
            pool=self.tracks+self.lost;assigned={};used=set()
            for high in (True,False):
                pairs=[]
                for i,t in enumerate(pool):
                    if i in used:continue
                    for j,d in enumerate(detections):
                        if j in assigned or (d['score']>=threshold)!=high:continue
                        overlap=iou(t['box'],d['box'])
                        if overlap>.15:pairs.append((overlap,i,j))
                for _,i,j in sorted(pairs,reverse=True):
                    if i not in used and j not in assigned:
                        assigned[j]=pool[i]['track_id'];used.add(i)
            fresh=[]
            for j,d in enumerate(detections):
                ident=assigned.get(j)
                if ident is None:
                    if d['score']<threshold:continue
                    ident=self.session+'-'+str(self.next_id);self.next_id+=1
                fresh.append({**d,'track_id':ident,'detected_at':timestamp,'tracking_method':'detector'})
            fresh.extend(t for i,t in enumerate(self.tracks) if i not in used and timestamp-t['detected_at']<=self.max_gap)
            # Lost, unmeasured positions are kept for matching only, never drawn.
            self.lost=[t for i,t in enumerate(pool) if i>=len(self.tracks) and i not in used and timestamp-t['detected_at']<=self.max_gap]
            self.tracks=fresh[:50];self.last_detect=timestamp
        self.previous=gray;self.last=timestamp
        return [{k:v for k,v in t.items() if k!='detected_at'} for t in self.tracks]
