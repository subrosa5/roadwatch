"""Experimental temporal scene classifier. No spatial boxes; no CCTV accuracy claim.

The public weights were trained for a dashcam, not a fixed Iowa camera. This
module deliberately has no path that creates production incident events.
"""
from collections import deque
import hashlib
import math
from pathlib import Path
import cv2
import numpy as np


class TemporalCollisionDetector:
    def __init__(self, backbone, head, metadata):
        for item in [backbone, head]:
            if hashlib.sha256(Path(item['path']).read_bytes()).hexdigest() != item['sha256']:
                raise ValueError('Collision model hash mismatch')
        self.backbone = cv2.dnn.readNetFromONNX(backbone['path'])
        self.head = cv2.dnn.readNetFromONNX(head['path'])
        for net in [self.backbone, self.head]:
            net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        self.meta = metadata
        self.frames = deque(maxlen=metadata['window_frames'])
        self.times = deque(maxlen=metadata['window_frames'])
        self.last = None
        self.index = 0
        self.consecutive = 0

    def sample(self, bgr, timestamp):
        if not math.isfinite(timestamp): raise ValueError('Invalid video timestamp')
        gap = timestamp-self.last if self.last is not None else None
        if gap is not None and (gap <= 0 or gap > 1.5/self.meta['target_fps']):
            self.frames.clear(); self.times.clear(); self.consecutive = 0; self.index = 0
        self.last = timestamp
        image = cv2.cvtColor(cv2.resize(bgr, (112,112)), cv2.COLOR_BGR2RGB).astype(np.float32)/255
        image = (image-np.asarray(self.meta['mean'],np.float32))/np.asarray(self.meta['std'],np.float32)
        self.backbone.setInput(np.transpose(image,(2,0,1))[None].copy())
        feat = np.asarray(self.backbone.forward()).reshape(-1)
        if len(feat) != self.meta['feat_dim']: raise ValueError('Unexpected collision backbone output')
        self.frames.append(feat); self.times.append(timestamp); self.index += 1
        if len(self.frames) < self.meta['window_frames'] or self.index % self.meta['stride']: return None
        self.head.setInput(np.asarray(self.frames,np.float32)[None])
        logit = float(np.asarray(self.head.forward()).reshape(-1)[0])
        if not math.isfinite(logit): raise ValueError('Nonfinite collision score')
        score = 1/(1+math.exp(-max(-80,min(80,logit))))
        self.consecutive = self.consecutive+1 if score >= self.meta['detect_threshold'] else 0
        return {'score':score,'candidate':self.consecutive>=self.meta['consec'],
                'experimental':True,'window_start':self.times[0],'window_end':timestamp,
                'localization':None,'production_events_enabled':False}
