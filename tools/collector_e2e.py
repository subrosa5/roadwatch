"""Synthetic transport test only. Never run against the deployed API."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import subprocess
from unittest.mock import patch
import imageio_ffmpeg

ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from collector import collector

base=os.environ['E2E_LOOPBACK_API']
if not base.startswith('http://127.0.0.1:'):raise ValueError('Loopback test only')

class SyntheticDetector:
    def __init__(self,config): pass
    def infer(self,jpeg): return [{'label':'fire','score':.95,'box':[.54,.27,.18,.34]}]

class SyntheticVehicleDetector:
    def __init__(self,config):pass
    def detect(self,image):return [{'label':'vehicle','score':.9,'box':[.2,.4,.2,.2]}]

original=collector.recording_command
fixture=None
def command(url,directory,fps,ffmpeg,timed_frames=False):
    args=original(str(fixture),directory,fps,ffmpeg,timed_frames=timed_frames)
    args[args.index('-i'):args.index('-i')]=['-stream_loop','-1']
    if '-re' not in args:args.insert(args.index('-i'),'-re')
    return args

with tempfile.TemporaryDirectory(prefix='roadwatch-synthetic-e2e-') as d:
    fixture=Path(d)/'transport-fixture.mp4'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-i',str(ROOT/'web/clips/fire.mp4'),'-c:v','libx264','-preset','ultrafast','-force_key_frames','expr:gte(t,n_forced*2)','-an',str(fixture)],check=True,timeout=20)
    config=json.loads((ROOT/'collector/botkeep/config.json').read_text())
    config.update(api_url=base,buffer_root=str(Path(d)/'ring'),pre_seconds=2,post_seconds=2,
                  vehicle_model={'synthetic_fixture':True},vehicle_model_version='SYNTHETIC TRACKER TRANSPORT - NOT MODEL OUTPUT',model_version='SYNTHETIC TRANSPORT FIXTURE - NOT MODEL OUTPUT',ffmpeg=imageio_ffmpeg.get_ffmpeg_exe())
    path=Path(d)/'config.json';path.write_text(json.dumps(config))
    with patch.object(collector,'Detector',SyntheticDetector),patch.object(collector,'recording_command',command),patch.object(collector,'VehicleDetector',SyntheticVehicleDetector):
        asyncio.run(collector.main(path))
