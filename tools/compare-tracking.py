"""Compare real tracking on one recorded clip; never contacts the private API.

Baseline source must be an explicitly selected, trusted commit in this repo.
This measures output coverage and cost, not precision/recall without labels.
"""
import argparse,hashlib,importlib.util,json,platform,re,subprocess,sys,tempfile,time
from pathlib import Path
import cv2
import imageio_ffmpeg
import numpy as np
ROOT=Path(__file__).resolve().parent.parent
sys.path.insert(0,str(ROOT))
from collector import vehicles
p=argparse.ArgumentParser()
p.add_argument('--video',required=True);p.add_argument('--model',required=True)
p.add_argument('--baseline-ref',required=True);p.add_argument('--output',required=True)
a=p.parse_args()
if not re.fullmatch(r'[a-f0-9]{7,40}',a.baseline_ref):raise ValueError('Select a trusted commit SHA')
lock=json.loads((ROOT/'collector/botkeep/vehicle.lock.json').read_text())
results=[]
with tempfile.TemporaryDirectory(prefix='roadwatch-comparison-') as tmp:
 root=Path(tmp);source=root/'baseline.py'
 source.write_bytes(subprocess.check_output(['git','show',a.baseline_ref+':collector/vehicles.py'],cwd=ROOT))
 spec=importlib.util.spec_from_file_location('collector.comparison_baseline',source)
 baseline=importlib.util.module_from_spec(spec);spec.loader.exec_module(baseline)
 for folder,opts in [('default',[]),('q3',['-q:v','3'])]:
  (root/folder).mkdir()
  subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y','-i',a.video,'-t','25','-vf','fps=4',*opts,str(root/folder/'%03d.jpg')],check=True,timeout=60)
 for name,module,folder,threshold in [('previous',baseline,'default',.35),('jpeg_only',baseline,'q3',.35),('tuned',vehicles,'q3',.18)]:
  tracker=module.VehicleTracker(module.VehicleDetector({**lock,'path':a.model,'threshold':threshold}),detect_interval=.65)
  rows=[];sizes=[];cpu=[]
  for i,path in enumerate(sorted((root/folder).glob('*.jpg'))):
   image=cv2.imread(str(path));start=time.process_time();tracks=tracker.update(image,i*.25)
   cpu.append(time.process_time()-start);sizes.append(path.stat().st_size);rows.append(tracks)
  if len(rows)<5:raise ValueError('Insufficient recorded frames')
  results.append({'profile':name,'frames':len(rows),'frames_with_tracks':sum(bool(r) for r in rows),'track_observations':sum(map(len,rows)),'detector_observations':sum(t['tracking_method']=='detector' for r in rows for t in r),'optical_flow_observations':sum(t['tracking_method']=='optical_flow' for r in rows for t in r),'distinct_ids':len({t['track_id'] for r in rows for t in r}),'jpeg_bytes_median':float(np.median(sizes)),'cpu_ms_per_frame':float(np.mean(cpu[4:])*1000),'quality_validated':False})
report={'scope':'Recorded sample; no production writes or labelled accuracy benchmark','sample_sha256':hashlib.sha256(Path(a.video).read_bytes()).hexdigest(),'model_sha256':lock['sha256'],'fps':4,'detector_interval_seconds':.65,'baseline_commit':a.baseline_ref,'environment':{'system':platform.system(),'machine':platform.machine()},'profiles':results,'false_positive_rate_measured':False,'recall_measured':False}
Path(a.output).write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
