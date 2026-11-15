"""Copy closed MPEG-TS segments; metadata uses the same FFmpeg media clock."""
import base64
import csv
from datetime import datetime, timezone
import re
import time
from pathlib import Path


def video_packets(state):
    session=state.get('video_session')
    if not session:
        return []
    root=Path(session['directory'])
    try:
        rows=list(csv.reader((root/'segments.csv').read_text().splitlines()))
    except (OSError, csv.Error):
        return []
    packets=[]
    for row in rows[-4:]:
        if len(row)!=3 or not re.fullmatch(r'segment-\d{3}\.ts',Path(row[0]).name):
            continue
        try:
            start,end=map(float,row[1:]);path=root/Path(row[0]).name
            with path.open('rb') as source:
                data=source.read(600001)
                modified=__import__('os').fstat(source.fileno()).st_mtime
            if time.time()-modified>15 or not 0<end-start<=10 or not 376<=len(data)<=600000 or len(data)%188:
                continue
        except (OSError, ValueError):
            continue
        known=session.setdefault('sequences',{})
        if start not in known:
            known[start]=session.get('next_sequence',0)
            session['next_sequence']=known[start]+1
        sequence=known[start]
        if len(known)>32:
            session['sequences']={k:v for k,v in sorted(known.items())[-32:]}
        packets.append({
            'session_id':session['id'],'timeline_origin':session['origin'],
            'sequence':sequence,'start':start,'end':end,
            'captured_at':datetime.fromtimestamp(modified,timezone.utc).isoformat(),
            'data':base64.b64encode(data).decode(),
            'observations':[o for o in state.get('video_observations',[]) if start-1<=o['media_time']<=end+1 and time.time()-datetime.fromisoformat(o['captured_at']).timestamp()<55],
        })
    return packets
