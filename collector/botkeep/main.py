"""Botkeep ZIP entry point. Default: bounded preflight, never unattended monitoring."""
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request

from dotenv import load_dotenv
import imageio_ffmpeg

PHASE = "initialization"
ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env", override=False)
# The source tree and the flat deploy ZIP use the same implementation.
if (ROOT.parent / "collector.py").exists():
    sys.path.insert(0, str(ROOT.parent))
from collector import Detector, main as collect


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for part in iter(lambda: f.read(1024 * 1024), b""): h.update(part)
    return h.hexdigest()


def download_model(lock, target):
    if target.exists() and digest(target) == lock["sha256"]:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(".part")
    try:
        with urllib.request.urlopen(lock["url"], timeout=30) as response, temporary.open("wb") as f:
            count = 0
            while True:
                part = response.read(1024 * 1024)
                if not part: break
                count += len(part)
                if count > lock["bytes"]: raise ValueError("Model size exceeds locked size")
                f.write(part)
        if temporary.stat().st_size != lock["bytes"] or digest(temporary) != lock["sha256"]:
            raise ValueError("Model integrity check failed")
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def rss_mb(who=resource.RUSAGE_SELF):
    value = resource.getrusage(who).ru_maxrss
    return value / (1024 ** 2 if platform.system() == "Darwin" else 1024)


def tracking_profile(detector_cpu_ms, flow_cpu_ms, fire_cpu_ms, fps, memory_mib):
    """Reserve 0.15 of the 0.5 vCPU allocation for decode/network/other work.

    This is an admission estimate. A real-stream test must still pass before run.
    Ignore cold-start cost in the sustained estimate, but report it separately.
    """
    warm_detector=detector_cpu_ms[2:] if len(detector_cpu_ms)>2 else detector_cpu_ms
    detector_ms=statistics.median(warm_detector)
    flow_ms=statistics.median(flow_cpu_ms) if flow_cpu_ms else 0.
    other_cpu=fps*flow_ms/1000+fire_cpu_ms/5000
    available=.35-other_cpu
    interval=max(.5,detector_ms/1000/available) if available>0 else float('inf')
    # Never dilute new-object detection below once a second just to pass a gate.
    accepted=interval<=1 and memory_mib<350
    configured=min(1.,math.ceil(interval*1000)/1000) if math.isfinite(interval) else 1.
    return {'vehicle_detector_warm_samples':len(warm_detector),'vehicle_detector_cpu_ms_median':detector_ms,'vehicle_flow_cpu_ms_median':flow_ms,
            'vehicle_detection_interval_seconds':round(configured,3),
            'estimated_inference_cpu_per_second':round(other_cpu+detector_ms/1000/configured,4),
            'resource_gate_passed':accepted,
            'failure_reasons':([] if interval<=1 else ['sustained_inference_budget_exceeded'])+([] if memory_mib<350 else ['preflight_memory_budget_exceeded'])}


def preflight(config, model):
    import cv2
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    source = os.environ.get("ROADWATCH_PREFLIGHT_VIDEO", config["cameras"][0]["stream_url"])
    camera_network_test = "ROADWATCH_PREFLIGHT_VIDEO" not in os.environ
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-rw_timeout", "10000000",
               "-threads", "1", "-i", source, "-frames:v", "1", "-vf", "scale='min(640,iw)':-2",
               "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=40)
    if result.returncode or not result.stdout or len(result.stdout) > 2 * 1024 * 1024:
        raise RuntimeError("FFmpeg failed to obtain a camera JPEG")
    detector = Detector([model])
    samples = []
    detections = []
    for _ in range(6):
        start = time.process_time()
        detections = detector.infer(result.stdout)
        samples.append((time.process_time() - start) * 1000)
    from vehicles import VehicleDetector, VehicleTracker
    vehicle=VehicleDetector(config['vehicle_model'])
    vehicle_samples=[];vehicle_wall_samples=[];detector_samples=[];flow_samples=[];vehicle_detections=[]
    import numpy as np
    image=cv2.imdecode(np.frombuffer(result.stdout,np.uint8),cv2.IMREAD_COLOR)
    tracker=VehicleTracker(vehicle)
    for i in range(30):
        previous=tracker.last_detect;start=time.process_time();wall=time.monotonic()
        vehicle_detections=tracker.update(image,i*.2)
        elapsed=(time.process_time()-start)*1000
        vehicle_samples.append(elapsed);vehicle_wall_samples.append((time.monotonic()-wall)*1000)
        (detector_samples if tracker.last_detect!=previous else flow_samples).append(elapsed)
    vehicle_cpu_ms=max(vehicle_samples)
    # Conservative sum of process high-water marks, not a cgroup measurement.
    memory = rss_mb() + rss_mb(resource.RUSAGE_CHILDREN)
    cpu_ms = statistics.median(samples[1:])
    profile=tracking_profile(detector_samples,flow_samples,cpu_ms,config.get('fps',5),memory)
    return {**profile,"vehicle_tracking_wall_ms_max":max(vehicle_wall_samples),"checked_at": datetime.now(timezone.utc).isoformat(),
            "system": platform.system(), "machine": platform.machine(),
            "camera_network_test": camera_network_test,
            "model_sha256": model["sha256"], "labels": model["labels"],
            "opencv": cv2.__version__, "inference_cpu_ms": cpu_ms,
            "rss_upper_estimate_mib": memory, "detections_on_probe": len(detections),
            "vehicle_tracking_cpu_ms_max":vehicle_cpu_ms,"vehicle_detections":len(vehicle_detections),
            "vehicle_tracking_tested":True,
            "accuracy_validated": False, "dtp_detector": False,
            "monitoring_started": False}


def tracking_load(config,model):
    """Bounded real-stream throughput test, no private API or synthetic detections."""
    from collector import recording_command
    from vehicles import VehicleDetector,VehicleTracker
    fire=Detector([model]);tracker=VehicleTracker(VehicleDetector(config['vehicle_model']),detect_interval=config.get('vehicle_detection_interval_seconds',.5))
    import cv2,numpy as np
    frames=0;tracked=0;stale_frames=0;max_age=0.;last_hash=None;first=None;last_fire=-1e9;started=time.monotonic();cpu=time.process_time()
    with tempfile.TemporaryDirectory(dir=ROOT/'data') as temporary:
        directory=Path(temporary)
        process=subprocess.Popen(recording_command(config['cameras'][0]['stream_url'],directory,config.get('fps',5),imageio_ffmpeg.get_ffmpeg_exe()),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            while time.monotonic()-started<45 and (first is None or time.monotonic()-first<20):
                time.sleep(.02);path=directory/'frame.jpg'
                if not path.exists():continue
                with path.open('rb') as f:jpeg=f.read();timestamp=os.fstat(f.fileno()).st_mtime
                hashed=hashlib.sha256(jpeg).hexdigest()
                if hashed==last_hash:continue
                last_hash=hashed
                age=max(0,time.time()-timestamp);max_age=max(max_age,age)
                if age>1:stale_frames+=1
                if first is None:first=time.monotonic()
                image=cv2.imdecode(np.frombuffer(jpeg,np.uint8),cv2.IMREAD_COLOR)
                tracks=tracker.update(image,timestamp);tracked+=len(tracks);frames+=1
                if timestamp-last_fire>=5:fire.infer(jpeg);last_fire=timestamp
                if process.poll() is not None:break
        finally:
            process.terminate()
            try:process.wait(timeout=8)
            except subprocess.TimeoutExpired:process.kill();process.wait()
    duration=time.monotonic()-first if first else 0
    rate=frames/duration if duration else 0
    cgroup_peak=None
    try:cgroup_peak=int(Path('/sys/fs/cgroup/memory.peak').read_text())/1024**2
    except (OSError,ValueError):pass
    result={'cgroup_memory_peak_mib':cgroup_peak,'real_stream_tracking_load':True,'duration_seconds':duration,'frames':frames,'processed_fps':rate,'target_fps':config.get('fps',5),'max_frame_age_seconds':max_age,'stale_frames':stale_frames,'vehicle_detection_interval_seconds':config.get('vehicle_detection_interval_seconds',.5),'track_observations':tracked,'inference_cpu_seconds':time.process_time()-cpu,'rss_upper_estimate_mib':rss_mb()+rss_mb(resource.RUSAGE_CHILDREN),'private_api_writes':False,'throughput_gate_passed':rate>=.8*config.get('fps',5) and stale_frames<=.05*max(1,frames) and rss_mb()+rss_mb(resource.RUSAGE_CHILDREN)<384 and (cgroup_peak is None or cgroup_peak<448)}
    print(json.dumps(result),flush=True)
    if not result['throughput_gate_passed']:raise RuntimeError('Real tracking throughput gate did not pass')


def main():
    global PHASE
    os.chdir(ROOT)
    mode = os.environ.get("ROADWATCH_MODE", "preflight")
    if mode not in {"preflight", "run"}: raise ValueError("ROADWATCH_MODE must be preflight or run")
    config = json.loads((ROOT / "config.json").read_text())
    lock = json.loads((ROOT / "model.lock.json").read_text())
    model_path = ROOT / "data/models/fire-smoke.onnx"
    PHASE = "model_download"
    download_model(lock, model_path)
    model = {k: lock[k] for k in ["sha256", "labels", "size", "threshold"]}
    model["path"] = str(model_path)
    vehicle_lock=json.loads((ROOT/'vehicle.lock.json').read_text())
    vehicle_path=ROOT/'data/models/vehicles.onnx'
    download_model(vehicle_lock,vehicle_path)
    config['vehicle_model']={**vehicle_lock,'path':str(vehicle_path)}
    PHASE = "camera_and_model_preflight"
    report = preflight(config, model)
    (ROOT / "data/preflight.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
    if not report["resource_gate_passed"]:
        raise RuntimeError("Resource gate did not pass")
    config['vehicle_detection_interval_seconds']=report['vehicle_detection_interval_seconds']
    PHASE='tracking_throughput_preflight'
    tracking_load(config,model)
    if mode == "preflight": return
    PHASE = "runtime_configuration"
    if not report["camera_network_test"]:
        raise RuntimeError("Runtime preflight did not pass; monitoring not started")
    if not os.environ.get("INGEST_TOKEN") or not os.environ.get("SITES_SERVICE_TOKEN"):
        raise RuntimeError("Private API runtime credentials are missing")
    # No secrets are written to this derived, non-secret runtime configuration.
    config["models"] = [model]
    config["ffmpeg"] = imageio_ffmpeg.get_ffmpeg_exe()
    config["buffer_root"] = str(ROOT / "data/ring")
    generated = ROOT / "data/runtime.json"
    generated.write_text(json.dumps(config))
    PHASE = "monitoring"
    asyncio.run(collect(generated))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Network exceptions can embed redirected signed download URLs. Keep
        # their contents out of hosted logs; the exception type still aids triage.
        reasons={"Resource gate did not pass":"sustained_resource_budget_exceeded","Real tracking throughput gate did not pass":"tracking_throughput_or_freshness_gate_failed","FFmpeg failed to obtain a camera JPEG":"camera_decode_failed"}
        reason=reasons.get(str(error),'see_previous_stage_report') if isinstance(error,RuntimeError) else 'see_previous_stage_report'
        print(json.dumps({"reason":reason,"startup_failed": type(error).__name__, "phase": PHASE, "monitoring_started": False}), flush=True)
        sys.exit(1)
