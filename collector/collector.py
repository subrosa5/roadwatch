"""Cloud-hosted collector. Requires approved sources, FFmpeg and verified YOLOv8 ONNX weights.

Never runs implicitly from the frontend. No default camera URLs or model downloads.
"""
import argparse
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

LABELS = {"vehicle", "collision", "smoke", "fire"}


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
    def __init__(self, base, token):
        parsed = urlparse(base)
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"}):
            raise ValueError("API must use HTTPS (except local development)")
        if not token or len(token) < 32:
            raise ValueError("INGEST_TOKEN required")
        self.base = base.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = "Bearer " + token

    def post(self, path, **kwargs):
        response = self.session.post(self.base + path, timeout=20, **kwargs)
        if response.status_code in {401, 403, 429, 507}:
            raise RuntimeError(f"Collector stopped: API status {response.status_code}")
        response.raise_for_status()
        return response.json()


def recording_command(url, directory, fps, ffmpeg="ffmpeg"):
    return [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-rw_timeout", "10000000", "-i", url,
            "-map", "0:v:0", "-an", "-c:v", "copy", "-f", "segment", "-segment_time", "2",
            "-segment_list", str(directory / "segments.csv"), "-segment_list_size", "30", "-segment_wrap", "30",
            "-segment_format", "mpegts", str(directory / "segment-%03d.ts"),
            "-map", "0:v:0", "-an", "-vf", f"fps={fps},scale=640:-2", "-f", "image2", "-update", "1", "-atomic_writing", "1", str(directory / "frame.jpg")]


async def evidence(event, directory, api, ffmpeg, pre, post):
    """Preserve segments immediately, then gather post-roll; never invent pre-roll."""
    event_time = time.time()
    copies = {}
    with tempfile.TemporaryDirectory(prefix="event-", dir=directory) as temp:
        target = Path(temp)
        deadline = event_time + post + 3
        while time.time() < deadline:
            for source in directory.glob("segment-*.ts"):
                try:
                    info = source.stat()
                    if info.st_mtime < event_time - pre - 3 or info.st_mtime > event_time + post + 3:
                        continue
                    # A segment is copied only after FFmpeg has moved on to the next one.
                    if time.time() - info.st_mtime < 2.5:
                        continue
                    key = (source.name, info.st_mtime_ns)
                    if key not in copies:
                        dest = target / f"{info.st_mtime_ns}.ts"
                        shutil.copyfile(source, dest)
                        copies[key] = dest
                except FileNotFoundError:
                    continue
            await asyncio.sleep(1)
        if not copies:
            print(json.dumps({"event_id": event["id"], "recording": "unavailable_no_segments"}))
            return
        manifest = target / "concat.txt"
        manifest.write_text("".join(f"file '{p.name}'\n" for p in sorted(copies.values())))
        output = target / "evidence.mp4"
        process = await asyncio.create_subprocess_exec(ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "concat", "-safe", "1", "-i", str(manifest), "-an", "-vf", "scale=960:-2,fps=10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-t", str(pre + post + 8), "-movflags", "+faststart", str(output), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        try:
            await asyncio.wait_for(process.wait(), timeout=90)
        except asyncio.TimeoutError:
            process.kill(); await process.wait()
            return
        if process.returncode == 0 and output.exists() and output.stat().st_size <= 25 * 1024 * 1024:
            await asyncio.to_thread(api.post, f'/api/events/{event["id"]}/evidence', data=output.read_bytes(), headers={"Content-Type": "video/mp4"})


async def run_camera(camera, detector, api, settings, inference_lock, cpu_budget):
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
    fps = float(settings.get("fps", 1))
    if not .2 <= fps <= 5:
        raise ValueError("Supported FPS: 0.2–5; confirmation needs adjacent distinct frames within six seconds")
    ffmpeg = settings.get("ffmpeg", "ffmpeg")
    process = await asyncio.create_subprocess_exec(*recording_command(camera["stream_url"], directory, fps, ffmpeg), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
    last_hash = None
    clips = set()
    try:
        while process.returncode is None:
            await asyncio.sleep(1 / fps)
            for task in list(clips):
                if task.done():
                    clips.remove(task)
                    if task.exception():
                        raise task.exception()
            path = directory / "frame.jpg"
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
                detections = detector.infer(jpeg)
                cpu_budget["seconds"] += time.process_time() - start
                ledger = Path(settings["buffer_root"]) / "cpu-budget.json"
                temporary = ledger.with_suffix('.tmp')
                temporary.write_text(json.dumps(cpu_budget))
                temporary.replace(ledger)
            captured_at = __import__('datetime').datetime.fromtimestamp(frame_mtime, __import__('datetime').timezone.utc).isoformat()
            data = {"camera_id": camera["id"], "frame_id": frame_hash, "captured_at": captured_at, "detections": detections, "model": settings["model_version"], "clock": "collector_arrival"}
            result = await asyncio.to_thread(api.post, "/api/observations", json=data)
            await asyncio.to_thread(api.post, f'/api/cameras/{camera["id"]}/frame', data=jpeg, headers={"Content-Type": "image/jpeg", "X-Frame-ID": frame_hash})
            for event in result["events"]:
                task = asyncio.create_task(evidence(event, directory, api, ffmpeg, settings.get("pre_seconds", 10), settings.get("post_seconds", 10)))
                clips.add(task)
            print(json.dumps({"camera": camera["id"], "frame_id": frame_hash, "detections": len(detections), "new_events": len(result["events"])}))
        raise RuntimeError("Stream recorder exited; source unavailable")
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 8)
            except asyncio.TimeoutError:
                process.kill(); await process.wait()
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
    api = Api(config["api_url"], os.environ.get("INGEST_TOKEN", ""))
    root = Path(config["buffer_root"])
    root.mkdir(parents=True,exist_ok=True)
    ledger = root / "cpu-budget.json"
    budget = json.loads(ledger.read_text()) if ledger.exists() else {"day": "", "seconds": 0.}
    if not isinstance(budget.get("day"),str) or not isinstance(budget.get("seconds"),(float,int)) or not np.isfinite(budget["seconds"]) or budget["seconds"]<0:
        raise ValueError("Invalid CPU ledger; stopped instead of resetting budget")
    lock = asyncio.Lock()
    tasks = [asyncio.create_task(run_camera(c, detector, api, config, lock, budget)) for c in enabled]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    asyncio.run(main(args.config))
