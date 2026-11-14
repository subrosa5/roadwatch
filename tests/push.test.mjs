import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, createPublicKey, verify } from 'node:crypto';
import ece from 'http_ece';
import { signingKey, subscription, pushRequest } from '../cloud/push.mjs';

test('Web Push ciphertext decrypts with independent RFC8291 library; VAPID verifies',async()=>{
  const client=createECDH('prime256v1');client.generateKeys();
  const auth=randomBytes(16);
  const sub={endpoint:'https://fcm.googleapis.com/fcm/send/test-fixture',keys:{p256dh:client.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}};
  const message={title:'Тест огня',url:'/?event=fixture'};
  const result=await pushRequest(sub,message,'a'.repeat(64),'https://roadwatch.test',1800000000000);
  const decoded=ece.decrypt(Buffer.from(result.options.body),{version:'aes128gcm',privateKey:client,authSecret:auth.toString('base64url')});
  assert.deepEqual(JSON.parse(decoded.toString()),message);
  const value=result.options.headers.Authorization;
  const jwt=/t=([^,]+)/.exec(value)[1],publicKey=Buffer.from(/k=(.*)$/.exec(value)[1],'base64url');
  const [header,payload,sig]=jwt.split('.');
  const key=createPublicKey({key:{kty:'EC',crv:'P-256',x:publicKey.subarray(1,33).toString('base64url'),y:publicKey.subarray(33).toString('base64url')},format:'jwk'});
  assert.ok(verify('sha256',Buffer.from(header+'.'+payload),{key,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')));
  const claims=JSON.parse(Buffer.from(payload,'base64url'));
  assert.equal(claims.aud,'https://fcm.googleapis.com');
  assert.equal(claims.exp,1800000000+43200);
  assert.equal(result.options.redirect,'manual');
});
test('Push destination validation rejects SSRF and malformed curve points',()=>{
  for(const endpoint of ['http://fcm.googleapis.com/fcm/send/x','https://127.0.0.1/x','https://fcm.googleapis.com.attacker.test/x','https://user@fcm.googleapis.com/x','https://fcm.googleapis.com:8443/x']) assert.throws(()=>subscription({endpoint,keys:{}}));
  assert.throws(()=>subscription({endpoint:'https://fcm.googleapis.com/fcm/send/x',keys:{p256dh:Buffer.alloc(65,4).toString('base64url'),auth:Buffer.alloc(16).toString('base64url')}}));
});
test('VAPID signing key is domain separated, stable, and rotates with runtime secret',async()=>{
  const a=await signingKey('a'.repeat(64)),same=await signingKey('a'.repeat(64)),b=await signingKey('b'.repeat(64));
  assert.equal(a.publicKey,same.publicKey);assert.notEqual(a.publicKey,b.publicKey);
});
