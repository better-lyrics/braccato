import { readFile, writeFile } from 'node:fs/promises';
const input=JSON.parse(await readFile('/dev/stdin','utf8'));
const targets=await(await fetch('http://127.0.0.1:'+(input.port??9222)+'/json/list')).json();
if(input.action==='targets'){console.log(JSON.stringify(targets.map(({id,type,url,title})=>({id,type,url,title})),null,2));process.exit(0);}
const target=targets.find(t=>input.id?t.id===input.id:input.extension?t.url===`chrome-extension://${input.extension}/background/service_worker.js`:t.type==='page'&&t.url.startsWith('https://music.youtube.com/'));
if(!target)throw Error('Target unavailable');
const ws=new WebSocket(target.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let next=0;const pending=new Map();
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
try {
let result;
if(input.action==='navigate')result=await cdp('Page.navigate',{url:input.url});
else if(input.action==='eval'){
  const r=await cdp('Runtime.evaluate',{expression:input.expression,awaitPromise:true,returnByValue:true,userGesture:!!input.userGesture});
  if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));result=r.result.value;
}else if(input.action==='screenshot'){
  const r=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(input.path,Buffer.from(r.data,'base64'));result={path:input.path};
}else if(input.action==='record'){
  await cdp('DOM.enable');await cdp('CSS.enable');const {root}=await cdp('DOM.getDocument',{depth:0});
  const samples=[];
  for(const sample of input.samples){
    const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector:sample.selector});
    const {fonts}=await cdp('CSS.getPlatformFontsForNode',{nodeId});
    if(!fonts.some(f=>f.familyName.includes(sample.font)))throw Error('Unexpected rendered font: '+JSON.stringify({sample,fonts}));
    const {result:r}=await cdp('Runtime.evaluate',{expression:`(()=>{const e=document.querySelector(${JSON.stringify(sample.selector)});const r=e.getBoundingClientRect();return {ownLanguage:e.lang||null,contentLanguage:e.closest('[lang]')?.lang,visible:r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth,rect:{x:r.x,y:r.y,width:r.width,height:r.height}}})()`,returnByValue:true});
    if(r.value.contentLanguage!==sample.language)throw Error('Unexpected language: '+JSON.stringify(r.value));
    if(!r.value.visible)throw Error('Sample is outside the screenshot');
    samples.push({selector:sample.selector,...r.value,fonts});
  }
  const {result:r}=await cdp('Runtime.evaluate',{expression:`({url:location.href,title:document.title,documentLanguage:document.documentElement.lang,viewport:[innerWidth,innerHeight],devicePixelRatio,mediaTime:(window.opener?.document.querySelector('video')??document.querySelector('video'))?.currentTime,paused:(window.opener?.document.querySelector('video')??document.querySelector('video'))?.paused,openerUrl:window.opener?.location.href,isDocumentPip:window.opener?.documentPictureInPicture?.window===window,lyricLines:document.querySelectorAll('.blyrics--line').length,timedRomanizationWords:document.querySelectorAll('.blyrics--romanized .blyrics--word').length})`,returnByValue:true});
  const browser=await cdp('Browser.getVersion');
  const {data}=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  await writeFile(input.path,Buffer.from(data,'base64'));
  result={...r.value,browser:browser.product,commit:input.commit,core:input.core,samples,screenshot:input.path.split('/').at(-1)};
  await writeFile(input.path.replace(/\.png$/,'.json'),JSON.stringify(result,null,2)+'\n');
}else if(input.action==='fonts'){
  await cdp('DOM.enable');await cdp('CSS.enable');const {root}=await cdp('DOM.getDocument',{depth:0});
  result=[];for(const selector of input.selectors){const {nodeId}=await cdp('DOM.querySelector',{nodeId:root.nodeId,selector});result.push({selector,...await cdp('CSS.getPlatformFontsForNode',{nodeId})});}
}else if(input.action==='command') result=await cdp(input.method,input.params??{});
console.log(JSON.stringify(result,null,2));
}finally{ws.close();}
