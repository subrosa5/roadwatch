"""Bounded publication: local inference does not spend an API record per frame."""
from datetime import datetime, timezone
import json
import math
from pathlib import Path


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def incident_labels(observation):
    return {d["label"] for d in observation["detections"]
            if d["label"] in {"fire", "smoke", "collision"}
            and d["score"] >= (0.85 if d["label"] == "smoke" else 0.8)}


class Publisher:
    def __init__(self, api, ledger, heartbeat_seconds=900, daily_records=400, daily_clips=5):
        self.api = api
        self.path = Path(ledger)
        self.heartbeat = heartbeat_seconds
        self.record_limit = daily_records
        self.clip_limit = daily_clips
        self.previous = None
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {}
        if self.state:
            try:
                datetime.strptime(self.state["day"], "%Y-%m-%d")
                valid = (type(self.state["records"]) is int and self.state["records"] >= 0
                         and type(self.state["clips"]) is int and self.state["clips"] >= 0
                         and math.isfinite(self.state["last_heartbeat"])
                         and self.state["last_heartbeat"] >= 0
                         and isinstance(self.state["cooldown"], dict)
                         and all(k in {"fire", "smoke", "collision"} and math.isfinite(v) and v >= 0
                                 for k, v in self.state["cooldown"].items()))
            except (KeyError, TypeError, ValueError):
                valid = False
            if not valid: raise ValueError("Invalid publication ledger")

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(self.state))
        temp.replace(self.path)

    def send(self, observation, jpeg):
        if self.state["records"] >= self.record_limit:
            raise RuntimeError("Publication budget exhausted; monitoring stopped")
        # Reserve before network I/O: an ambiguous response cannot bypass the cap.
        self.state["records"] += 1
        self.save()
        result = self.api.post("/api/observations", json=observation)
        self.api.post(f'/api/cameras/{observation["camera_id"]}/frame', data=jpeg,
                      headers={"Content-Type": "image/jpeg", "X-Frame-ID": observation["frame_id"]})
        return result.get("events", [])

    def handle(self, observation, jpeg):
        current_time = stamp(observation["captured_at"])
        day = datetime.fromtimestamp(current_time, timezone.utc).date().isoformat()
        if self.state.get("day") != day:
            self.state = {"day": day, "records": 0, "clips": 0, "last_heartbeat": 0, "cooldown": {}}
            self.save()
        previous, self.previous = self.previous, (observation, jpeg)
        confirmed = set()
        if previous:
            old = previous[0]
            if (old["camera_id"] == observation["camera_id"]
                    and old["frame_id"] != observation["frame_id"]
                    and 0 < current_time - stamp(old["captured_at"]) <= 6):
                confirmed = incident_labels(old) & incident_labels(observation)
        confirmed = {label for label in confirmed
                     if current_time - self.state["cooldown"].get(label, 0) >= 120}
        if confirmed and self.state["clips"] < self.clip_limit:
            if self.state["records"] + 2 > self.record_limit:
                raise RuntimeError("Publication budget cannot admit confirmation pair")
            for label in confirmed:
                self.state["cooldown"][label] = current_time
            self.save()
            events = []
            for data, frame in [previous, (observation, jpeg)]:
                filtered = {**data, "detections": [d for d in data["detections"]
                            if d["label"] == "vehicle" or d["label"] in confirmed]}
                events.extend(self.send(filtered, frame))
            self.state["last_heartbeat"] = current_time
            unique = list({event["id"]: event for event in events}.values())
            clips = unique[:max(0, self.clip_limit - self.state["clips"])]
            self.state["clips"] += len(clips)
            self.save()
            return clips
        # Do not publish a tentative incident as a stripped heartbeat: a later
        # confirmation must still be able to submit this frame with its detections.
        if incident_labels(observation):
            return []
        if current_time - self.state["last_heartbeat"] >= self.heartbeat:
            # A single heartbeat may contain tentative boxes, but cannot pair with
            # a recent incident observation to create an unintended extra alert.
            heartbeat = {**observation, "detections": [d for d in observation["detections"]
                                                       if d["label"] == "vehicle"]}
            self.send(heartbeat, jpeg)
            self.state["last_heartbeat"] = current_time
            self.save()
        return []
