"""Cloud-hosted collector. Requires approved sources, FFmpeg and verified YOLOv8 ONNX weights.

Never runs implicitly from the frontend. No default camera URLs or model downloads.
"""
import argparse
import csv
import asyncio
from collections import deque
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlparse

import cv2
import numpy as np
import requests

try:
    from .publisher import Publisher, PublicationBudgetError
    from .outbox import ClipOutbox
    from .vehicles import VehicleDetector, VehicleTracker
    from .watch import video_packets
except ImportError:
    from publisher import Publisher, PublicationBudgetError
    from outbox import ClipOutbox
    from vehicles import VehicleDetector, VehicleTracker
    from watch import video_packets

LABELS = {"vehicle", "collision", "smoke", "fire"}

class FatalApiError(RuntimeError): pass
class RetryableApiError(RuntimeError): pass
class PublicationQuotaError(RuntimeError): pass


class Detector:
    def __init__(self, configs):
        if not configs:
            raise ValueError("At least one verified model is required")
        self.models = []
        cv2.setNumThreads(1)
        for config in configs:
            path = Path(config["path"])
            expected = config.get("sha256", "")
            if len(expected) != 64 or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                raise ValueError("Model SHA-256 missing or mismatched")
            names = config["labels"]
            if not names or not set(names).issubset(LABELS):
                raise ValueError("Model labels must match the observation contract")
            net = cv2.dnn.readNetFromONNX(str(path))
            net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
            net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
            self.models.append((net, config))

    def infer(self, jpeg):
        image = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError("Invalid input JPEG")
        detections = []
        for net, config in self.models:
            size = int(config.get("size", 640))
            h, w = image.shape[:2]
            scale = min(size / w, size / h)
            nw, nh = round(w * scale), round(h * scale)
            left, top = (size - nw) // 2, (size - nh) // 2
            canvas = np.full((size, size, 3), 114, np.uint8)
            canvas[top:top + nh, left:left + nw] = cv2.resize(image, (nw, nh))
            net.setInput(cv2.dnn.blobFromImage(canvas, 1 / 255, (size, size), swapRB=True))
            output = np.asarray(net.forward()).squeeze(0)
            channels = 4 + len(config["labels"])
            if output.ndim != 2:
                raise ValueError("Expected YOLOv8 output [1,4+C,N] or [1,N,4+C]")
            if output.shape[0] == channels:
                output = output.T
            if output.shape[1] != channels:
                raise ValueError("Unsupported output layout; no silent reinterpretation")
            for class_id, label in enumerate(config["labels"]):
                threshold = float(config.get("threshold", .5))
                rows = output[output[:, 4 + class_id] >= threshold]
                boxes, scores = [], []
                for row in rows:
                    cx, cy, bw, bh = row[:4]
                    x1 = max(0., min(float(w), (cx - bw / 2 - left) / scale))
                    y1 = max(0., min(float(h), (cy - bh / 2 - top) / scale))
                    x2 = max(0., min(float(w), (cx + bw / 2 - left) / scale))
                    y2 = max(0., min(float(h), (cy + bh / 2 - top) / scale))
                    if x2 > x1 and y2 > y1:
                        boxes.append([float(x1 / w), float(y1 / h), float((x2 - x1) / w), float((y2 - y1) / h)])
                        scores.append(float(row[4 + class_id]))
                indexes = cv2.dnn.NMSBoxes(boxes, scores, threshold, .45)
                for index in np.asarray(indexes).flatten():
                    detections.append({"label": label, "score": min(1., scores[index]), "box": boxes[index]})
        return sorted(detections, key=lambda d: d["score"], reverse=True)[:100]


class Api:
    def __init__(self, base, token, sites_token=None):
        parsed = urlparse(base)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("API URL must not contain credentials, query or fragment")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}):
            raise ValueError("API must use HTTPS (except local development)")
        if not token or len(token) < 32:
            raise ValueError("INGEST_TOKEN required")
        self.base = base.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = "Bearer " + token
        if sites_token:
            if parsed.scheme != "https" or not parsed.hostname.endswith(".chatgpt.site"):
                raise ValueError("Sites service token requires a Sites HTTPS origin")
            self.session.headers["OAI-Sites-Authorization"] = "Bearer " + sites_token

    def request(self, method, path, **kwargs):
        if not path.startswith('/api/') or '://' in path: raise ValueError('Invalid API path')
        for attempt in range(3):
            try:
                sender = self.session.post if method == 'POST' else self.session.get
                response = sender(self.base + path, timeout=(5,15), allow_redirects=False, **kwargs)
            except requests.RequestException:
                if attempt == 2: raise RetryableApiError('API network unavailable') from None
                time.sleep(2**attempt); continue
            status = response.status_code
            if 300 <= status < 400: raise FatalApiError('API redirect is not allowed')
            if status in {401,403}: raise FatalApiError('API authorization or camera configuration rejected')
            if status in {429,507}: raise PublicationQuotaError('API quota reached')
            if status == 400:
                try: stale=response.json().get('error') in {'Stale or future frame','Tracking frame too old','Preview too old','Stale video segment'}
                except ValueError: stale=False
                if stale: raise RetryableApiError('Observation expired during network outage')
            if status in {408,409,425} or status >= 500:
                if attempt == 2: raise RetryableApiError('API temporarily unavailable')
                time.sleep(2**attempt); continue
            if status >= 400: raise FatalApiError('API request rejected')
            try: return response.json()
            except ValueError: raise RetryableApiError('API returned invalid JSON') from None

    def post(self, path, **kwargs): return self.request('POST', path, **kwargs)
    def get(self, path): return self.request('GET', path)


def recording_command(url, directory, fps, ffmpeg="ffmpeg", timed_frames=False):
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-rw_timeout", "10000000", "-threads", "1", "-re", "-i", url,
            "-map", "0:v:0", "-an", "-c:v", "copy", "-f", "segment", "-segment_time", "2",
            "-segment_list", str(directory / "segments.csv"), "-segment_list_size", "30", "-segment_wrap", "30",
            "-segment_format", "mpegts", str(directory / "segment-%03d.ts"),
            "-map", "0:v:0", "-an", "-vf", f"fps={fps},scale='min(640,iw)':-2", "-q:v", "3", "-f", "image2", *( ["-frame_pts","1"] if timed_frames else ["-update","1"] ), "-atomic_writing", "1", str(directory / ("frame-%010d.jpg" if timed_frames else "frame.jpg"))]


async def evidence(event, directory, api, ffmpeg, pre, post, outbox=None):
    """Preserve segments immediately, then gather post-roll; never invent pre-roll."""
    try: event_time=__import__("datetime").datetime.fromisoformat(event["captured_at"].replace("Z","+00:00")).timestamp()
    except (KeyError,ValueError): event_time=time.time()
    copies = {}
    with tempfile.TemporaryDirectory(prefix="event-", dir=directory) as temp:
        target = Path(temp)
        deadline = max(event_time + post + 5,time.time()+1)
        while True:
            manifest_path=directory/'segments.csv'
            closed=None
            if manifest_path.exists():
                try:
                    closed={Path(row[0]).name for row in csv.reader(manifest_path.read_text().splitlines()) if len(row)>=3}
                    manifest_time=manifest_path.stat().st_mtime_ns
                except (OSError,csv.Error): closed=set()
            for source in directory.glob("segment-*.ts"):
                if closed is not None and source.name not in closed: continue
                try:
                    info = source.stat()
                    if info.st_mtime < event_time - pre - 3 or info.st_mtime > event_time + post + 5:
                        continue
                    # The CSV lists sealed segments. Its timestamp also prevents
                    # copying an old list entry whose ring slot is being reused.
                    if closed is not None:
                        if info.st_mtime_ns > manifest_time: continue
                    elif time.time()-info.st_mtime<2.5: continue
                    key = (source.name, info.st_mtime_ns)
                    if key not in copies:
                        dest = target / f"{info.st_mtime_ns}.ts"
                        shutil.copyfile(source, dest)
                        copies[key] = dest
                except FileNotFoundError:
                    continue
            if time.time() >= deadline or (directory/"recorder-stopped").exists(): break
            await asyncio.sleep(1)
        if not copies:
            print(json.dumps({"event_id": event["id"], "recording": "unavailable_no_segments"}))
            return
        manifest = target / "concat.txt"
        manifest.write_text("".join(f"file '{p.name}'\n" for p in sorted(copies.values())))
        output = target / "evidence.mp4"
        process = await asyncio.create_subprocess_exec(ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", str(manifest), "-an", "-c:v", "copy", "-t", str(pre + post + 8), "-movflags", "+faststart", str(output), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(process.wait(), timeout=90)
        except asyncio.TimeoutError:
            process.kill(); await process.wait()
            return
        if process.returncode == 0 and output.exists() and output.stat().st_size <= 25 * 1024 * 1024:
            if outbox:
                await asyncio.to_thread(outbox.enqueue,event['id'],output)
            else:
                await asyncio.to_thread(api.post, f'/api/events/{event["id"]}/evidence', data=output.read_bytes(), headers={"Content-Type": "video/mp4"})


def analyze_frame(tracker,detector,jpeg,frame_time,do_incident):
    image=cv2.imdecode(np.frombuffer(jpeg,np.uint8),cv2.IMREAD_COLOR) if tracker else None
    tracks=tracker.update(image,frame_time) if tracker else []
    return tracks,detector.infer(jpeg) if do_incident else []


async def run_camera(camera, detector, api, settings, inference_lock, cpu_budget, state, publisher, outbox):
    if not camera.get("enabled") or not camera.get("approved"):
        return
    if not re.fullmatch(r"[a-z0-9-]{1,80}", camera["id"]):
        raise ValueError("Invalid camera ID")
    parsed = urlparse(camera["stream_url"])
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise ValueError("Only explicitly approved HTTPS streams without embedded credentials")
    directory = Path(settings["buffer_root"]) / camera["id"]
    directory.mkdir(parents=True, exist_ok=True)
    # A fresh session never reuses the previous process's stale frames/segments.
    for file in directory.glob("segment-*.ts"):
        file.unlink()
    (directory / "frame.jpg").unlink(missing_ok=True)
    (directory / "recorder-stopped").unlink(missing_ok=True)
    (directory / "segments.csv").unlink(missing_ok=True)
    for file in directory.glob('frame-*.jpg'):file.unlink()
    fps = float(settings.get("fps", 1))
    if not .2 <= fps <= 5:
        raise ValueError("Supported FPS: 0.2–5; confirmation needs adjacent distinct frames within six seconds")
    ffmpeg = settings.get("ffmpeg", "ffmpeg")
    process = await asyncio.create_subprocess_exec(*recording_command(camera["stream_url"], directory, fps, ffmpeg,timed_frames=True), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    state['video_session']={'id':__import__('uuid').uuid4().hex,'origin':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'directory':str(directory)}
    state['video_observations']=deque(maxlen=120)
    last_hash = None
    last_source_write = time.monotonic()
    source_mtime = None
    last_incident=-float('inf')
    tracker=VehicleTracker(VehicleDetector(settings['vehicle_model']),detect_interval=settings.get('vehicle_detection_interval_seconds',.5)) if settings.get('vehicle_model') else None
    state['tracking_buffer']=deque(maxlen=16)
    state['tracking_latest']=None
    clips = set()
    try:
        while process.returncode is None:
            await asyncio.sleep(min(.5, 1 / fps / 4))
            for task in list(clips):
                if task.done():
                    clips.remove(task)
                    if task.exception():
                        state["last_error"]="quota"
                        print(json.dumps({"recording":"failed","reason":type(task.exception()).__name__}))
            images=sorted(directory.glob('frame-*.jpg'))
            path = images[-1] if images else directory/'frame.jpg'
            for old in images[:-12]:old.unlink(missing_ok=True)
            if path.exists():
                current_mtime = path.stat().st_mtime_ns
                if current_mtime != source_mtime:
                    source_mtime = current_mtime
                    last_source_write = time.monotonic()
            if time.monotonic() - last_source_write > 45:
                print(json.dumps({'camera':camera['id'],'stage':'stream_stalled','action':'reconnect','timeout_seconds':45}),flush=True)
                raise RetryableApiError('Recorder stopped producing camera frames')
            if not path.exists() or time.time() - path.stat().st_mtime > 10:
                continue
            try:
                with path.open('rb') as source:
                    jpeg = source.read()
                    frame_mtime = os.fstat(source.fileno()).st_mtime
            except FileNotFoundError:
                continue
            frame_hash = hashlib.sha256(jpeg).hexdigest()
            if frame_hash == last_hash:
                continue
            last_hash = frame_hash
            async with inference_lock:
                day = __import__('datetime').datetime.now(__import__('datetime').timezone.utc).date().isoformat()
                if cpu_budget["day"] != day:
                    cpu_budget.update(day=day,seconds=0.)
                if cpu_budget["seconds"] >= settings.get("daily_inference_cpu_seconds", 240):
                    raise RuntimeError("Collector stopped: configured inference CPU budget exhausted")
                start = time.process_time()
                do_incident=frame_mtime-last_incident>=settings.get('incident_interval_seconds',0)
                # OpenCV must not block delivery/leases/heartbeats on the event loop.
                tracks,detections=await asyncio.to_thread(analyze_frame,tracker,detector,jpeg,frame_mtime,do_incident)
                if do_incident:last_incident=frame_mtime
                cpu_budget["seconds"] += time.process_time() - start
                ledger = Path(settings["buffer_root"]) / "cpu-budget.json"
                temporary = ledger.with_suffix('.tmp')
                temporary.write_text(json.dumps(cpu_budget))
                temporary.replace(ledger)
                state['frames_analyzed'] += 1
                state['last_frame_at'] = __import__('datetime').datetime.fromtimestamp(frame_mtime, __import__('datetime').timezone.utc).isoformat()
                state['state'] = 'quota_exhausted' if state.get('quota_day') == day else 'running'
                state['last_error'] = None
            captured_at = __import__('datetime').datetime.fromtimestamp(frame_mtime, __import__('datetime').timezone.utc).isoformat()
            data = {"camera_id": camera["id"], "frame_id": frame_hash, "captured_at": captured_at, "detections": detections, "model": settings["model_version"], "clock": "collector_arrival"}
            if tracker:
                state['tracking_latest']=({**data,'detections':tracks,'model':settings.get('vehicle_model_version','opencv-nanodet-2022nov+LK-v1')},jpeg)
                state['tracking_buffer'].append(state['tracking_latest'])
                media_time=int(path.stem.split('-')[-1])/fps
                state['video_observations'].append({**state['tracking_latest'][0],'media_time':media_time})
            if not do_incident:continue
            state['latest'] = (data,jpeg)
            try:
                admitted = await asyncio.to_thread(publisher.handle, data, jpeg)
            except (PublicationQuotaError,PublicationBudgetError):
                state.update(state="quota_exhausted",last_error="quota",quota_day=day); admitted=[]
            except RetryableApiError:
                state['last_error']='network'; admitted=[]
            for event in admitted:
                task = asyncio.create_task(evidence(event, directory, api, ffmpeg, settings.get("pre_seconds", 10), settings.get("post_seconds", 10),outbox))
                clips.add(task)
            print(json.dumps({"camera": camera["id"], "frame_id": frame_hash, "detections": len(detections), "new_events": len(admitted)}))
        raise RetryableApiError("Stream recorder exited; source unavailable")
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 8)
            except asyncio.TimeoutError:
                process.kill(); await process.wait()
        (directory/"recorder-stopped").touch()
        if clips:
            await asyncio.gather(*clips, return_exceptions=True)


async def main(config_path):
    config = json.loads(Path(config_path).read_text())
    if config.get("approved_for_cloud_run") is not True:
        raise ValueError("Cloud deployment/source approval is required in collector configuration")
    enabled = [c for c in config["cameras"] if c.get("enabled")]
    if not enabled:
        raise ValueError("No approved sources enabled")
    detector = Detector(config["models"])
    api = Api(config["api_url"], os.environ.get("INGEST_TOKEN", ""), os.environ.get("SITES_SERVICE_TOKEN"))
    root = Path(config["buffer_root"])
    root.mkdir(parents=True,exist_ok=True)
    ledger = root / "cpu-budget.json"
    budget = json.loads(ledger.read_text()) if ledger.exists() else {"day": "", "seconds": 0.}
    if not isinstance(budget.get("day"),str) or not isinstance(budget.get("seconds"),(float,int)) or not np.isfinite(budget["seconds"]) or budget["seconds"]<0:
        raise ValueError("Invalid CPU ledger; stopped instead of resetting budget")
    lock = asyncio.Lock()
    tasks = []
    outbox=ClipOutbox(api,root/'outbox')
    started=time.monotonic()
    states={c['id']:{'state':'starting','frames_analyzed':0,'last_frame_at':None,'last_error':None,'latest':None,'view_active':False} for c in enabled}
    async def supervise(camera):
        state=states[camera['id']]
        publisher=Publisher(api,root/camera['id']/'publication.json',config.get('heartbeat_seconds',900),config.get('daily_publication_limit',400),config.get('daily_clip_limit',5))
        delay=2
        while True:
            try:
                state['state']='starting'
                await run_camera(camera,detector,api,config,lock,budget,state,publisher,outbox)
            except RetryableApiError:
                if state['frames_analyzed']>0 and state['last_frame_at'] and time.time()-__import__('datetime').datetime.fromisoformat(state['last_frame_at']).timestamp()<20: delay=2
                state.update(state='backoff',last_error='stream')
                print(json.dumps({'camera':camera['id'],'state':'backoff','retry_seconds':delay}))
                await asyncio.sleep(delay)
                delay=min(60,delay*2)
    async def telemetry(camera):
        state=states[camera['id']]
        next_cleanup=0;last_sent=0;last_state=None
        while True:
            if time.monotonic()-last_sent<60 and state["state"]==last_state:
                await asyncio.sleep(1);continue
            payload={k:state[k] for k in ['state','frames_analyzed','last_frame_at','last_error']}
            payload.update(cpu_seconds=budget['seconds'],uptime_seconds=time.monotonic()-started,fps=config.get('fps',.2),model=config['model_version'],capabilities=['fire','smoke']+(['vehicle_tracking'] if config.get('vehicle_model') else []))
            try:
                await asyncio.to_thread(api.post,'/api/cameras/'+camera['id']+'/heartbeat',json=payload)
                if time.monotonic()>=next_cleanup:
                    await asyncio.to_thread(api.post,'/api/ops/maintenance',json={})
                    next_cleanup=time.monotonic()+3600
            except (RetryableApiError,PublicationQuotaError): state['last_error']='network'
            last_sent=time.monotonic();last_state=payload['state']
            await asyncio.sleep(1)
    async def previews(camera):
        state=states[camera['id']]
        sent=None;quota_day=None
        while True:
            today=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).date().isoformat()
            try:
                demand=await asyncio.to_thread(api.get,'/api/cameras/'+camera['id']+'/demand')
                state['view_active']=demand.get('active',False)
                state['view_kind']=demand.get('kind','analysis')
                state['view_kinds']=demand.get('kinds',[state['view_kind']])
                state['tracking_format']=demand.get('tracking_format')
                state['watch_format']=demand.get('watch_format')
                if state['view_active'] and 'analysis' in state.get('view_kinds',[state.get('view_kind')]) and state['latest'] and quota_day!=today:
                    data,jpeg=state['latest']
                    if data['frame_id']!=sent:
                        import base64
                        await asyncio.to_thread(api.post,'/api/cameras/'+camera['id']+'/preview',json={'observation':data,'jpeg':base64.b64encode(jpeg).decode()})
                        sent=data['frame_id']
            except PublicationQuotaError: quota_day=today
            except RetryableApiError: pass
            await asyncio.sleep(5)
    async def tracking_previews(camera):
        state=states[camera['id']];sent_at='';quota_day=None
        while True:
            today=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).date().isoformat()
            if state.get('watch_format')!='hls-v1' and state.get('view_active') and 'tracking' in state.get('view_kinds',[state.get('view_kind')]) and state.get('tracking_latest') and quota_day!=today:
                # Never repeatedly upload a frozen packet. A new viewer may
                # arrive long after the recorder's last successful frame.
                cutoff=time.time()-3
                pending=[item for item in state.get('tracking_buffer',[]) if item[0]['captured_at']>sent_at and __import__('datetime').datetime.fromisoformat(item[0]['captured_at']).timestamp()>=cutoff][-8:]
                if pending:
                    try:
                        import base64
                        frames=[{'observation':data,'jpeg':base64.b64encode(jpeg).decode()} for data,jpeg in pending]
                        if state.get('tracking_format')=='batch-v1':
                            while len(frames)>1 and len(json.dumps({'frames':frames}))>800000:frames.pop(0)
                            payload={'frames':frames}
                        else:payload=frames[-1]
                        result=await asyncio.to_thread(api.post,'/api/cameras/'+camera['id']+'/tracking',json=payload)
                        if result.get('stored'):sent_at=frames[-1]['observation']['captured_at']
                    except PublicationQuotaError:quota_day=today
                    except RetryableApiError:state['last_error']='network'
            await asyncio.sleep(.2)
    async def video_previews(camera):
        state=states[camera['id']];sent=None;quota_day=None
        while True:
            today=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).date().isoformat()
            if state.get('watch_format')=='hls-v1' and state.get('view_active') and 'tracking' in state.get('view_kinds',[]) and quota_day!=today:
                for packet in video_packets(state):
                    identity=(packet['session_id'],packet['sequence'])
                    if sent and identity[0]==sent[0] and identity[1]<=sent[1]:continue
                    try:
                        result=await asyncio.to_thread(api.post,'/api/cameras/'+camera['id']+'/watch',json=packet)
                        if result.get('stored'):sent=identity
                    except PublicationQuotaError:quota_day=today;break
                    except RetryableApiError:state['last_error']='video_network';break
            await asyncio.sleep(1)
    async def uploads():
        while True:
            try: await asyncio.to_thread(outbox.flush_one)
            except (RetryableApiError,PublicationQuotaError):
                await asyncio.sleep(30)
            await asyncio.sleep(10)
    for camera in enabled:
        tasks.extend([asyncio.create_task(supervise(camera)),asyncio.create_task(telemetry(camera)),asyncio.create_task(previews(camera)),asyncio.create_task(tracking_previews(camera)),asyncio.create_task(video_previews(camera))])
    tasks.append(asyncio.create_task(uploads()))
    try:
        await asyncio.gather(*tasks)
    finally:
        for state in states.values(): state['state']='stopped'
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for camera in enabled:
            state=states[camera['id']]
            try:
                await asyncio.wait_for(asyncio.to_thread(api.post,'/api/cameras/'+camera['id']+'/heartbeat',json={'state':'stopped','frames_analyzed':state['frames_analyzed'],'last_frame_at':state['last_frame_at'],'last_error':state['last_error'],'cpu_seconds':budget['seconds'],'uptime_seconds':time.monotonic()-started,'fps':config.get('fps',.2),'model':config['model_version'],'capabilities':['fire','smoke']}),timeout=5)
            except Exception: pass



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.config))
