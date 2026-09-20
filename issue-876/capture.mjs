import { strict as assert } from 'node:assert';
import { writeFile } from 'node:fs/promises';
const target=await (await fetch('http://127.0.0.1:9336/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pending=new Map();ws.addEventListener('message',e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(msg.error):p.resolve(msg.result);}});
function cdp(method,params={}){return new Promise((resolve,reject)=>{const msgId=++id;pending.set(msgId,{resolve,reject});ws.send(JSON.stringify({id:msgId,method,params}));});}
async function evaluate(expression){const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value;}
await cdp('Page.enable');await cdp('DOM.enable');await cdp('CSS.enable');
const report=[];
for(const contexts of [false,true]){
  await cdp('Emulation.setDeviceMetricsOverride',{width:contexts?1720:1600,height:contexts?860:1110,deviceScaleFactor:1.5,mobile:false});
  await cdp('Page.navigate',{url:'http://127.0.0.1:8876/'+(contexts?'?contexts=1':'')});
  const start=Date.now();
  while(!(await evaluate(`document.querySelectorAll('iframe').length===${contexts?3:2} && [...document.querySelectorAll('iframe')].every(f=>f.contentWindow.proofReady)`))){assert.ok(Date.now()-start<40000,'Fixture/font load timed out');await new Promise(r=>setTimeout(r,100));}
  const {root}=await cdp('DOM.getDocument',{depth:-1,pierce:true});
  const frameNodes=[];
  function walk(node){if(node.nodeName==='IFRAME')frameNodes.push(node);for(const child of node.children??[])walk(child);}
  walk(root);
  assert.equal(frameNodes.length,contexts?3:2);
  for(let frameIndex=0;frameIndex<frameNodes.length;frameIndex++){
    const samples=await evaluate(`document.querySelectorAll('iframe')[${frameIndex}].contentWindow.proofSamples`);
    for(const sample of samples){
      const {nodeId}=await cdp('DOM.querySelector',{nodeId:frameNodes[frameIndex].contentDocument.nodeId,selector:'#'+sample.id});
      const {fonts}=await cdp('CSS.getPlatformFontsForNode',{nodeId});
      const cjk=fonts.find(f=>/Noto Sans (HK|JP|KR|SC|TC)/.test(f.familyName));
      assert.ok(cjk,JSON.stringify({frameIndex,sample,fonts}));
      const actual=cjk.familyName.replace(/ Thin$/,'');
      const expected=frameIndex===0?'Noto Sans HK':sample.language==='ja'?'Noto Sans JP':sample.language==='ko-KR'?'Noto Sans KR':sample.language==='zh-CN'?'Noto Sans SC':sample.language==='zh-HK'?'Noto Sans HK':'Noto Sans TC';
      assert.equal(actual,expected,JSON.stringify({frameIndex,sample,fonts}));
      const detail=await evaluate(`(()=>{const doc=document.querySelectorAll('iframe')[${frameIndex}].contentDocument;const el=doc.getElementById(${JSON.stringify(sample.id)});const own=el.closest('[lang]');const inherited=own===doc.documentElement;const lang=own?.getAttribute('lang');doc.getElementById(${JSON.stringify('evidence-'+sample.id)}).textContent=${JSON.stringify('Rendered: '+actual+' · ')}+(inherited?'inherits UI '+lang:'lang='+lang);return {language:lang,inherited};})()`);
      report.push({contexts,frameIndex,sample,actual,expected,...detail});
    }
  }
  await evaluate(`(()=>{const frames=[...document.querySelectorAll('iframe')];const height=Math.max(...frames.map(f=>f.contentDocument.documentElement.scrollHeight));for(const f of frames)f.style.height=(height+2)+'px';})()`);
  const height=await evaluate('document.documentElement.scrollHeight+2');
  await cdp('Emulation.setDeviceMetricsOverride',{width:contexts?1720:1600,height,deviceScaleFactor:1.5,mobile:false});
  await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const {data}=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile('/tmp/blyrics-876-evidence/'+(contexts?'source-translation-documents':'regional-glyphs-before-after')+'.png',Buffer.from(data,'base64'));
}
await writeFile('/tmp/blyrics-876-evidence/rendered-fonts.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({screenshots:2,verifiedFontSelections:report.length,samples:report.map(x=>({contexts:x.contexts,frame:x.frameIndex,language:x.sample.language,font:x.actual}))},null,2));
ws.close();
