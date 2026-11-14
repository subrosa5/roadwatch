"""Disk-backed, bounded evidence queue; retries reuse the event's immutable clip."""
import hashlib
import json
from pathlib import Path
import re
import time


class ClipOutbox:
    def __init__(self, api, root, max_bytes=30*1024*1024):
        self.api, self.root, self.max_bytes = api, Path(root), max_bytes
        self.root.mkdir(parents=True, exist_ok=True)

    def enqueue(self, event_id, source):
        if not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", event_id): raise ValueError("Invalid evidence event ID")
        source = Path(source)
        size = source.stat().st_size
        if size > 25*1024*1024: raise RuntimeError("Evidence exceeds upload limit")
        destination = self.root / (event_id + '.mp4')
        if destination.exists():
            if hashlib.sha256(destination.read_bytes()).digest() != hashlib.sha256(source.read_bytes()).digest():
                raise RuntimeError("Different evidence already queued for event")
            return
        if sum(p.stat().st_size for p in self.root.glob('*.mp4')) + size > self.max_bytes:
            raise RuntimeError("Evidence outbox capacity exhausted")
        temporary = destination.with_suffix('.tmp')
        with source.open('rb') as reader, temporary.open('wb') as writer:
            for block in iter(lambda: reader.read(1024*1024), b''): writer.write(block)
        temporary.chmod(0o600)
        temporary.replace(destination)

    def flush_one(self):
        for path in sorted(self.root.glob('*.mp4'), key=lambda p:p.stat().st_mtime):
            # Never deliver a stale incident as a fresh alert; the journal keeps
            # its original event time even if its evidence cannot be recovered.
            if time.time()-path.stat().st_mtime > 86400:
                path.unlink(); continue
            self.api.post('/api/events/'+path.stem+'/evidence', data=path.read_bytes(), headers={'Content-Type':'video/mp4'})
            path.unlink()
            return True
        return False

    def count(self): return len(list(self.root.glob('*.mp4')))
