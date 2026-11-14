import { p256 } from '@noble/curves/nist.js';

const utf8 = value => new TextEncoder().encode(value);
export const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function unb64(value) {
  if(typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid base64url');
  return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), c=>c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n,p)=>n+p.length,0));
  let offset=0; for(const part of parts){out.set(part,offset);offset+=part.length;} return out;
};
async function hkdf(ikm, salt, info, length) {
  const key=await crypto.subtle.importKey('raw',ikm,'HKDF',false,['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({name:'HKDF',hash:'SHA-256',salt,info},key,length*8));
}
export function subscription(value) {
  const endpoint = new URL(value?.endpoint);
  const allowed = new Set(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com']);
  if(endpoint.protocol!=='https:' || !allowed.has(endpoint.hostname) || endpoint.port || endpoint.username || endpoint.password || endpoint.hash || endpoint.href.length>2048 || endpoint.pathname==='/') throw Error('Unsupported push endpoint');
  const point=unb64(value?.keys?.p256dh), auth=unb64(value?.keys?.auth);
  if(point.length!==65 || point[0]!==4 || auth.length!==16) throw Error('Invalid push keys');
  p256.Point.fromBytes(point).assertValidity();
  return {endpoint:endpoint.href,keys:{p256dh:b64(point),auth:b64(auth)}};
}

const keyCache = new Map();
export async function signingKey(secret) {
  if(!secret || secret.length<32) throw Error('Signing secret missing');
  // Domain-separated deterministic signing material from the existing native
  // runtime secret. No additional secret is exposed to clients or saved in Git.
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256',utf8('Roadwatch WebPush VAPID v1\0'+secret)));
  const cacheId=b64(hash);
  if(keyCache.has(cacheId)) return keyCache.get(cacheId);
  const order=0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const scalar=BigInt('0x'+Array.from(hash,b=>b.toString(16).padStart(2,'0')).join(''))%(order-1n)+1n;
  const privateBytes=Uint8Array.from(scalar.toString(16).padStart(64,'0').match(/../g),v=>parseInt(v,16));
  const point=p256.getPublicKey(privateBytes,false);
  const key=await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:b64(point.slice(1,33)),y:b64(point.slice(33)),d:b64(privateBytes)}, {name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  if(keyCache.size>4)keyCache.clear();
  const result={publicKey:b64(point),key}; keyCache.set(cacheId,result); return result;
}

export async function pushRequest(sub, payload, secret, subject, timestamp=Date.now()) {
  sub=subscription(sub);
  const vapid=await signingKey(secret), origin=new URL(sub.endpoint).origin;
  const encoded=[b64(utf8(JSON.stringify({typ:'JWT',alg:'ES256'}))),b64(utf8(JSON.stringify({aud:origin,exp:Math.floor(timestamp/1000)+12*3600,sub:subject})))].join('.');
  const sig=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},vapid.key,utf8(encoded));
  const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const serverPublic=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
  const clientPublic=unb64(sub.keys.p256dh);
  const client=await crypto.subtle.importKey('raw',clientPublic,{name:'ECDH',namedCurve:'P-256'},false,[]);
  const shared=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:client},pair.privateKey,256));
  const ikm=await hkdf(shared,unb64(sub.keys.auth),concat(utf8('WebPush: info\0'),clientPublic,serverPublic),32);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const cek=await hkdf(ikm,salt,utf8('Content-Encoding: aes128gcm\0'),16);
  const nonce=await hkdf(ikm,salt,utf8('Content-Encoding: nonce\0'),12);
  const content=utf8(JSON.stringify(payload));
  if(content.length>2048)throw Error('Push payload too large');
  const aes=await crypto.subtle.importKey('raw',cek,'AES-GCM',false,['encrypt']);
  const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce},aes,concat(content,new Uint8Array([2]))));
  const header=new Uint8Array(21);header.set(salt);new DataView(header.buffer).setUint32(16,4096);header[20]=65;
  return {url:sub.endpoint,options:{method:'POST',redirect:'manual',headers:{Authorization:`vapid t=${encoded}.${b64(new Uint8Array(sig))},k=${vapid.publicKey}`,'Content-Encoding':'aes128gcm','Content-Type':'application/octet-stream',TTL:'300',Urgency:'normal'},body:concat(header,serverPublic,ciphertext),signal:AbortSignal.timeout(7000)}};
}
