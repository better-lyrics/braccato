import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
const target=await (await fetch('http://127.0.0.1:9336/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pending=new Map();ws.addEventListener('message',e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(msg.error):p.resolve(msg.result);}});
function cdp(method,params={}){return new Promise((resolve,reject)=>{const msgId=++id;pending.set(msgId,{resolve,reject});ws.send(JSON.stringify({id:msgId,method,params}));});}
async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;}
await cdp('Page.enable');await cdp('DOM.enable');await cdp('CSS.enable');
await cdp('Emulation.setDeviceMetricsOverride',{width:1200,height:900,deviceScaleFactor:1,mobile:false});
await cdp('Performance.enable');
await cdp('Page.navigate',{url:'http://127.0.0.1:8876/perf.html'});
while(!(await evaluate('window.proofReady===true')))await new Promise(r=>setTimeout(r,100));
const nodeCount=await evaluate('benchmark.nodeCount');
const samples=[];
const variants=['current','expanded','disabled'];
for(const kind of ['words','insert','language']){
  for(let repeat=0;repeat<9;repeat++){
    for(let n=0;n<3;n++){
      const variant=variants[(n+repeat)%3];
      const count=kind==='language'?40:400;
      await evaluate(`benchmark.setVariant(${JSON.stringify(variant)});benchmark.run(${JSON.stringify(kind)},30);`);
      const before=Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
      await evaluate(`benchmark.run(${JSON.stringify(kind)},${count})`);
      const after=Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
      samples.push({kind,variant,count,styleMs:(after.RecalcStyleDuration-before.RecalcStyleDuration)*1000,styleCount:after.RecalcStyleCount-before.RecalcStyleCount,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000});
    }
  }
}
function median(values){values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)];}
const summary=[];
for(const kind of ['words','insert','language'])for(const variant of variants){const group=samples.filter(x=>x.kind===kind&&x.variant===variant);summary.push({kind,variant,operations:group[0].count,medianStyleMs:median(group.map(x=>x.styleMs)),medianLayoutMs:median(group.map(x=>x.layoutMs)),medianScriptMs:median(group.map(x=>x.scriptMs)),stylePerOperationMs:median(group.map(x=>x.styleMs/x.count))});}
const report={browser:await cdp('Browser.getVersion'),nodeCount,repeats:9,summary,samples};
await writeFile('/tmp/blyrics-876-evidence/selector-performance.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({nodeCount,summary},null,2));ws.close();
