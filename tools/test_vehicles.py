"""Tracking semantics with controlled detections; not a model accuracy benchmark."""
from pathlib import Path
import sys,unittest
import numpy as np
import cv2
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from collector.vehicles import VehicleTracker,VehicleDetector

class Tests(unittest.TestCase):
    def test_same_object_retains_id_across_detection_and_flow_and_resets_after_gap(self):
        class Detector:
            x=.2
            def detect(self,image):return [{'label':'vehicle','score':.9,'box':[self.x,.2,.2,.2]}]
        d=Detector();tracker=VehicleTracker(d,detect_interval=.5)
        rng=np.random.default_rng(42);patch=rng.integers(0,255,(40,40,3),dtype=np.uint8)
        def frame(x):
            f=np.zeros((200,200,3),np.uint8);f[40:80,x:x+40]=patch;return f
        first=tracker.update(frame(40),0)[0];second=tracker.update(frame(42),.2)[0]
        self.assertEqual(first['track_id'],second['track_id']);self.assertEqual(second['tracking_method'],'optical_flow')
        self.assertAlmostEqual(second['box'][0],.21,places=2)
        d.x=.23;third=tracker.update(frame(46),.6)[0];self.assertEqual(first['track_id'],third['track_id'])
        last=tracker.update(frame(46),3)[0];self.assertNotEqual(first['track_id'],last['track_id'])
    def test_textureless_lost_object_is_not_extrapolated(self):
        class Detector:
            def detect(self,image):return [{'label':'vehicle','score':.9,'box':[.2,.2,.2,.2]}]
        t=VehicleTracker(Detector());f=np.zeros((200,200,3),np.uint8)
        self.assertEqual(len(t.update(f,0)),1);self.assertEqual(t.update(f,.2),[])
    def test_hash_is_required_before_loading_weights(self):
        with self.assertRaises(ValueError):VehicleDetector({'path':__file__,'sha256':'0'*64})
if __name__=='__main__':unittest.main(verbosity=2)
