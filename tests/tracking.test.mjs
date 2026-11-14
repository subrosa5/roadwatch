import test from 'node:test';
import assert from 'node:assert/strict';
import {TrackingBuffer} from '../web/tracking.js';
const frame=(id,ms)=>({observation:{frame_id:id,captured_at:new Date(ms).toISOString()},jpeg:id});
test('tracking playout follows capture timestamps and preserves each image/annotation pair',()=>{
 const q=new TrackingBuffer();const a=frame('a',10000),b=frame('b',10250),c=frame('c',10500);
 q.add([c,a,b,b]);assert.equal(q.take(100),a);assert.equal(q.take(349),null);assert.equal(q.take(350),b);
 q.add([a,b,c]);assert.equal(q.take(600),c);assert.equal(q.take(1000),null);
 q.add([a]);assert.equal(q.take(1100),null);
});
test('tracking playout bounds memory, skips late frames and recovers after a stream gap',()=>{
 const q=new TrackingBuffer();q.add(Array.from({length:40},(_,i)=>frame(String(i),10000+i*250)));
 assert.equal(q.queue.length,24);assert.equal(q.take(0).jpeg,'16');assert.equal(q.take(1000).jpeg,'20');
 q.reset();q.add([frame('first',1000)]);q.take(0);q.add([frame('after-gap',10000)]);
 assert.equal(q.take(100).jpeg,'after-gap');assert.equal(q.take(101),null);
});
