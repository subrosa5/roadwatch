import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
from collector.collector import Api, FatalApiError, RetryableApiError, PublicationQuotaError
from collector.outbox import ClipOutbox


class Response:
    def __init__(self,status,data=None): self.status_code,self.data=status,data or {}
    def json(self): return self.data


class RuntimeTests(unittest.TestCase):
    def test_transient_api_retry_and_permanent_rejection(self):
        api=Api('https://example.chatgpt.site','a'*64,'b'*64)
        with patch.object(api.session,'post',side_effect=[Response(503),Response(201,{'ok':True})]) as post,patch('time.sleep'):
            self.assertTrue(api.post('/api/observations',json={})['ok'])
            self.assertEqual(post.call_count,2)
            self.assertFalse(post.call_args.kwargs['allow_redirects'])
        with patch.object(api.session,'post',return_value=Response(403)) as post:
            with self.assertRaises(FatalApiError): api.post('/api/observations',json={})
            self.assertEqual(post.call_count,1)
        with patch.object(api.session,'post',return_value=Response(409)),patch('time.sleep'):
            with self.assertRaises(RetryableApiError): api.post('/api/events/x/evidence',data=b'mp4')
        with patch.object(api.session,'post',return_value=Response(429)):
            with self.assertRaises(PublicationQuotaError): api.post('/api/observations',json={})

    def test_outbox_survives_failed_upload_and_restart(self):
        class Offline:
            def post(self,*args,**kwargs): raise RetryableApiError('offline')
        class Online:
            received=None
            def post(self,path,**kwargs): self.received=(path,kwargs['data']);return {'duplicate':True}
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'source.mp4';source.write_bytes(b'original video bytes')
            q=ClipOutbox(Offline(),root/'queue');q.enqueue('event-id',source)
            with self.assertRaises(RetryableApiError):q.flush_one()
            self.assertEqual(q.count(),1)
            api=Online();q=ClipOutbox(api,root/'queue');self.assertTrue(q.flush_one())
            self.assertEqual(api.received,('/api/events/event-id/evidence',b'original video bytes'))
            self.assertEqual(q.count(),0)

    def test_outbox_bounds_and_idempotency(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);source=root/'source';source.write_bytes(b'abcd')
            q=ClipOutbox(None,root/'queue',max_bytes=5);q.enqueue('first',source);q.enqueue('first',source)
            with self.assertRaises(RuntimeError):q.enqueue('second',source)
            with self.assertRaises(ValueError):q.enqueue('../escape',source)
            source.write_bytes(b'other')
            with self.assertRaises(RuntimeError):q.enqueue('first',source)
            self.assertEqual((root/'queue/first.mp4').read_bytes(),b'abcd')


if __name__=='__main__':unittest.main(verbosity=2)
