// Owner-operated handoff: private input -> own Site auth check -> macOS clipboard.
// Secret values never enter arguments, source files, stdout or stderr.
import {spawn} from 'node:child_process';
const input=await new Promise((resolve,reject)=>{
 let value='';if(process.stdin.isTTY)process.stdin.setRawMode(true);
 process.stdout.write('Ready for private connection JSON on hidden stdin.\n');
 process.stdin.on('data',chunk=>{
  value+=chunk.toString();
  if(value.length>20000){reject(Error('Input too large'));process.stdin.pause();return;}
  if(!value.includes('\n'))return;
  process.stdin.pause();if(process.stdin.isTTY)process.stdin.setRawMode(false);
  try{resolve(JSON.parse(value.trim()));}catch{reject(Error('Invalid private JSON'));}
 });
});
try {
 const expected='https://roadwatch-moscow-console.dealreal259.chatgpt.site';
 if(input.site_url!==expected)throw Error('Unexpected Site origin');
 for(const key of ['ingest','bypass'])if(typeof input[key]!=='string'||input[key].length<32||input[key].length>8192||/[\r\n\0]/.test(input[key]))throw Error('Invalid service credential');
 const response=await fetch(expected+'/api/stats',{headers:{'OAI-Sites-Authorization':'Bearer '+input.bypass,Authorization:'Bearer '+input.ingest},redirect:'manual',signal:AbortSignal.timeout(45000)});
 if(!response.ok)throw Error('Private API authorization failed (HTTP '+response.status+')');
 const stats=await response.json();if(!Number.isInteger(stats.collectors_online))throw Error('Unexpected API response');
 const content='INGEST_TOKEN='+input.ingest+'\nSITES_SERVICE_TOKEN='+input.bypass+'\nROADWATCH_MODE=run\n';
 await new Promise((resolve,reject)=>{
  const child=spawn('pbcopy',[],{stdio:['pipe','ignore','ignore']});
  child.on('error',()=>reject(Error('System clipboard unavailable')));
  child.on('exit',code=>code===0?resolve():reject(Error('System clipboard write failed')));
  child.stdin.on('error',()=>reject(Error('Clipboard input failed')));child.stdin.end(content);
 });
 console.log(JSON.stringify({private_api_authorized:true,collectors_online:stats.collectors_online,clipboard_ready:true,keys:['INGEST_TOKEN','SITES_SERVICE_TOKEN','ROADWATCH_MODE']}));
}catch(error){console.error(error.message);process.exitCode=1;}
