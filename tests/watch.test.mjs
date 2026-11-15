import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaBoxes} from '../web/watch.js';
test('video boxes follow media time and only interpolate measurements of the same track',()=>{
 const origin=Date.now(),box=(id,x)=>({track_id:id,label:'vehicle',score:.8,box:[x,.2,.1,.1]});
 const m={timeline_origin:new Date(origin).toISOString(),stale:false,segments:[{observations:[{media_time:1,detections:[box('A',.1),box('gone',.3)]},{media_time:1.5,detections:[box('A',.3),box('new',.7)]}]}]};
 const boxes=mediaBoxes(m,origin+1250);assert.equal(boxes.length,1);assert.equal(boxes[0].track_id,'A');assert.ok(Math.abs(boxes[0].box[0]-.2)<1e-9);
 assert.deepEqual(mediaBoxes(m,null),[]);assert.deepEqual(mediaBoxes(m,origin+4000),[]);assert.deepEqual(mediaBoxes({...m,stale:true},origin+1250),[]);
});
