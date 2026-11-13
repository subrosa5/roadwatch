"""Collector mechanics checks on original synthetic fixtures, not model accuracy."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import cv2
import imageio_ffmpeg
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from collector.collector import Api as CollectorApi, Detector, recording_command, evidence

class CollectorTests(unittest.TestCase):
    def test_sites_credentials_stay_on_expected_https_origin_and_no_redirects(self):
        with self.assertRaises(ValueError):
            CollectorApi('https://example.org','a'*64,'service-secret')
        with self.assertRaises(ValueError):
            CollectorApi('https://user:password@example.org','a'*64)
        api=CollectorApi('https://example.chatgpt.site','a'*64,'service-secret')
        self.assertEqual(api.session.headers['OAI-Sites-Authorization'],'Bearer service-secret')
        class Redirect:
            status_code=302
        with patch.object(api.session,'post',return_value=Redirect()) as post:
            with self.assertRaisesRegex(RuntimeError,'redirect'):
                api.post('/api/observations',json={})
            self.assertFalse(post.call_args.kwargs['allow_redirects'])

    def test_weights_hash_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'model.onnx';file.write_bytes(b'not a trained model')
            with self.assertRaisesRegex(ValueError,'SHA-256'):
                Detector([{'path':str(file),'sha256':'0'*64,'labels':['fire']}])

    def test_yolov8_letterbox_reverse_and_per_class_nms(self):
        class FakeNet:
            def setPreferableBackend(self,*args): pass
            def setPreferableTarget(self,*args): pass
            def setInput(self,*args): pass
            def forward(self):
                return np.array([[[320,321],[320,321],[200,200],[100,100],[.1,.1],[.95,.90]]],dtype=np.float32)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'shape-fixture.onnx';path.write_bytes(b'shape fixture, no model')
            config={'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'labels':['smoke','fire'],'size':640}
            with patch('cv2.dnn.readNetFromONNX',return_value=FakeNet()): detector=Detector([config])
            ok,jpeg=cv2.imencode('.jpg',np.zeros((360,640,3),np.uint8));self.assertTrue(ok)
            output=detector.infer(jpeg.tobytes())
            self.assertEqual(len(output),1);self.assertEqual(output[0]['label'],'fire')
            self.assertAlmostEqual(output[0]['box'][0],220/640,places=4)
            self.assertAlmostEqual(output[0]['box'][1],130/360,places=4)
            json.dumps(output)

    def test_ffmpeg_ring_jpeg_and_evidence_mp4(self):
        ffmpeg=imageio_ffmpeg.get_ffmpeg_exe()
        fixture=ROOT/'web/clips/fire.mp4'
        class Api:
            uploaded=None
            def post(self,path,**kwargs): self.uploaded=kwargs['data'];return {'ok':True}
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            command=recording_command(str(fixture),root,1,ffmpeg)
            # The recording command is exercised with our own local video only.
            result=subprocess.run(command,capture_output=True,timeout=30)
            self.assertEqual(result.returncode,0,result.stderr.decode()[:1000])
            self.assertTrue((root/'frame.jpg').exists())
            segments=sorted(root.glob('segment-*.ts'));self.assertGreater(len(segments),0)
            for i,segment in enumerate(segments):os.utime(segment,(time.time()-6+i*.001,time.time()-6+i*.001))
            api=Api();asyncio.run(evidence({'id':'synthetic-event'},root,api,ffmpeg,10,0))
            self.assertIsNotNone(api.uploaded);self.assertEqual(api.uploaded[4:8],b'ftyp')
            clip=root/'verified.mp4';clip.write_bytes(api.uploaded)
            cap=cv2.VideoCapture(str(clip));self.assertTrue(cap.isOpened());self.assertGreater(cap.get(cv2.CAP_PROP_FRAME_COUNT),0);cap.release()

if __name__=='__main__':unittest.main(verbosity=2)
