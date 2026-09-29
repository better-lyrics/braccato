// Run in image-highlights.html. These use real layout and WAAPI, which the node fakes do not.
export async function runImageHighlightChecks(view) {
  const {renderer, lyrics, theme} = view;
  const checks=[];
  const check=(condition,message)=>{if(!condition)throw new Error(message);checks.push(message)};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  view.setTheme(theme);
  renderer.setLyrics(lyrics);
  view.tick(.6,false);
  let part=renderer.lines[0].parts[0];
  check(!!part.imageLayers,'Theme opt-in creates separate image paint and glow');
  check(getComputedStyle(part.imageLayers.glow).maskImage==='none','Blur is outside the karaoke mask');
  const glow=part.imageLayers.glow.getAnimations()[0];
  const duration=Number(glow.effect.getTiming().duration);
  glow.currentTime=0;
  const start=Number(getComputedStyle(part.imageLayers.glow).opacity);
  const radiusStart=getComputedStyle(part.imageLayers.glow).filter;
  glow.currentTime=duration/2;
  const middle=Number(getComputedStyle(part.imageLayers.glow).opacity);
  glow.currentTime=duration;
  const end=Number(getComputedStyle(part.imageLayers.glow).opacity);
  check(start>middle&&middle>end&&end===0,'Glow opacity interpolates and settles to zero');
  check(radiusStart!==getComputedStyle(part.imageLayers.glow).filter,'Glow radius interpolates');
  check(part.highlightLetterElements.every((letter,i)=>{
    const twin=part.imageLayers.glowLetters[i];
    const a=letter.getBoundingClientRect(),b=twin.getBoundingClientRect();
    return Math.abs(a.x-b.x)<.1&&Math.abs(a.y-b.y)<.1&&
      getComputedStyle(letter).maskPosition===getComputedStyle(twin).maskPosition&&
      getComputedStyle(letter).transform===getComputedStyle(twin).transform;
  }),'Letter masks, motion and geometry agree between paint and glow');
  check(part.animations.every(a=>a.playState==='paused'),'Pausing freezes the glow together with the word');
  view.tick(7.5,false); view.tick(.3,false);
  part=renderer.lines[0].parts[0];
  check(Number(part.imageLayers.glow.getAnimations()[0].currentTime)<1000,'Seeking backward across lines reconstructs the glow at the media time');
  view.setTheme(theme+'\n/* blyrics-letter-wave = false; */');view.tick(.6,false);
  part=renderer.lines[0].parts[0];
  const fill=part.highlightElement.querySelector(':scope > .blyrics-image-fill');
  check(!part.highlightLetterElements&&getComputedStyle(fill).maskImage===getComputedStyle(part.imageLayers.glow.firstElementChild).maskImage,'Whole-word mode shares its sweep with the glow');
  view.tick(7.5,false);await frame();
  const svg=renderer.container.querySelector('.blyrics--instrumental-icon');
  const noteFill=svg.querySelector('.blyrics--instrumental-fill');
  check(noteFill.tagName==='g'&&!!noteFill.querySelector('image'),'The note image and fallback share the animated fill group');
  check(noteFill.getAnimations().length>0&&svg.querySelector('.blyrics--wave-clip').getAnimations().length>0,'The note uses the existing fade and wave timelines');
  const image=svg.querySelector('image');
  image.dispatchEvent(new Event('error'));
  check(!svg.hasAttribute('data-image-ready'),'Image failure restores the note color fallback');
  check(view.setTheme(''),'Removing image opt-in requests a rebuild');
  check(!renderer.container.querySelector('.blyrics-image-glow'),'Default themes allocate no image glow layers');
  check(renderer.container.querySelector('.blyrics--instrumental-fill').tagName==='path','Default note markup is preserved');
  view.setTheme(theme);view.tick(.6,false);
  return checks;
}

export async function runBidiImageHighlightChecks(view) {
  const {renderer:r, theme, lyrics:originalLyrics}=view;
  const mount=r.container.parentElement;
  const oldWidth=mount.style.width;
  const checks=[];
  const check=(ok,message)=>{if(!ok)throw new Error(message);checks.push(message)};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const fixtures=[
    ['Arabic joining', ['مرحبا','بالعالم','هذه','كلمات','طويلة','للتجربة']],
    ['Mixed bidi', ['שלום','hello','עולם','123','מילים','נוספות']],
    ['Wrapped word', ['SUPERCALIFRAGILISTICEXPIALIDOCIOUS','ending']],
  ];
  const rects=e=>Array.from(e.getClientRects(),rect=>[rect.x,rect.y,rect.width,rect.height]);
  const same=(a,b)=>a.length===b.length&&a.every((rect,i)=>rect.every((n,j)=>Math.abs(n-b[i][j])<.15));
  try {
    for(const lettered of [false,true])for(const width of [220,440])for(const [name,words] of fixtures){
      mount.style.width=width+'px';
      r.setTheme(theme+'\n/* blyrics-letter-wave = '+lettered+'; */');
      r.setLyrics([{words:words.join(' '),startTimeMs:0,durationMs:10000,
        parts:words.map((word,i)=>({words:word+(i<words.length-1?' ':''),startTimeMs:i*1000,durationMs:1000}))}]);
      await frame();
      r.tick(.4,{isPlaying:false});
      const parts=r.lines[0].parts;
      for(const p of parts){
        const host=p.imageLayers?.highlight;
        check(!!host, `${name}/${width}/${lettered}: inline glow host exists`);
        check(same(rects(p.highlightElement),rects(host)), `${name}/${width}/${lettered}: glow fragments align`);
        check(getComputedStyle(p.imageLayers.glow).display!=='none', `${name}/${width}/${lettered}: glow is enabled`);
        const sharp=p.highlightElement.querySelector(':scope > .blyrics-image-fill');
        const glow=p.imageLayers.glow.firstElementChild;
        check(getComputedStyle(sharp).maskImage===getComputedStyle(glow).maskImage, `${name}/${width}/${lettered}: sweep masks agree`);
        if(!p.highlightLetterElements)check(getComputedStyle(sharp).maskImage.includes(
          p.highlightElement.classList.contains('blyrics-rtl')?'270deg':'90deg'), `${name}: each word keeps its own sweep direction`);
        check(getComputedStyle(p.highlightElement).opacity===getComputedStyle(host).opacity, `${name}/${width}/${lettered}: visibility agrees`);
        check(p.animations.every(a=>a.playState==='paused'), `${name}/${width}/${lettered}: pause includes glow`);
        if(name==='Arabic joining')check(!p.letterElements, 'Arabic uses whole-word shaping');
        if(p.highlightLetterElements)for(let i=0;i<p.highlightLetterElements.length;i++) {
          const sharp=p.highlightLetterElements[i],glow=p.imageLayers.glowLetters[i];
          check(same(rects(sharp),rects(glow))&&getComputedStyle(sharp).maskPosition===getComputedStyle(glow).maskPosition,
            `${name}/${width}: letter geometry and mask agree`);
        }
      }
      const p=parts[0];
      check(Number(getComputedStyle(p.imageLayers.glow).opacity)>0&&getComputedStyle(p.imageLayers.glow).filter!=='none',
        `${name}/${width}/${lettered}: active glow has blur and opacity`);
      r.tick(3,{isPlaying:false});r.tick(.2,{isPlaying:false});
      check(getComputedStyle(p.highlightElement).opacity===getComputedStyle(p.imageLayers.highlight).opacity,
        `${name}/${width}/${lettered}: backward seek agrees`);
      r.tick(.3,{isPlaying:true,playbackRate:1.5});
      check(p.animations.every(a=>a.playbackRate===1.5), `${name}/${width}/${lettered}: playback rate includes glow`);
    }
    for(const lineSynced of [false,true]) {
      const words=['مرحبا','hello','بالعالم'];
      r.setTheme(theme+'\n.blyrics-container { --blyrics-image-glow-opacity-from: .6; --blyrics-image-glow-opacity-to: .6; --blyrics-highlight-glow-radius-to: 8px; }');
      r.setLyrics([{words:words.join(' '),startTimeMs:0,durationMs:4000,
        ...(lineSynced?{}:{parts:words.map((word,i)=>({words:word+' ',startTimeMs:i*1000,durationMs:1000,isBackground:i===2}))})},
        {words:'next',startTimeMs:5000,durationMs:2000}]);
      r.tick(1.6,{isPlaying:false});
      const parts=r.lines[0].parts.filter(p=>p.imageLayers?.highlight);
      check(parts.length===3, `Line-synced=${lineSynced}: main/background words get glow hosts`);
      check(parts.every(p=>getComputedStyle(p.highlightElement).opacity===getComputedStyle(p.imageLayers.highlight).opacity),
        `Line-synced=${lineSynced}: visibility agrees`);
      const letters=parts.flatMap(p=>[...(p.highlightLetterElements??[]),...p.imageLayers.glowLetters]);
      const masks=letters.map(e=>getComputedStyle(e).maskPosition);
      check(lineSynced||letters.length===0||masks.some(value=>parseFloat(value)!==0), `Line-synced=${lineSynced}: exit starts with revealed letters`);
      r.tick(5.3,{isPlaying:true});
      check(letters.every((e,i)=>getComputedStyle(e).maskPosition===masks[i]),
        `Line-synced=${lineSynced}: exiting sharp and glow letters retain their visible masks`);
      check(parts[0].animations.some(a=>a.effect.target===parts[0].imageLayers.highlight),
        `Line-synced=${lineSynced}: exit fades include glow host`);
      check(Number(getComputedStyle(parts[0].imageLayers.glow).opacity)>.5,
        `Line-synced=${lineSynced}: persistent glow survives cancellation until its parent fades`);
      r.tick(.2,{isPlaying:false});
      check(parts.every(p=>getComputedStyle(p.highlightElement).opacity===getComputedStyle(p.imageLayers.highlight).opacity),
        `Line-synced=${lineSynced}: backward seek restores glow`);
    }
    for(const hdr of [false,true]) for(const word of ['שלוםABCD','ABCDשלום','שלום1234']) {
      r.setTheme(hdr?theme:'');
      r.setLyrics([{words:word,startTimeMs:0,durationMs:3000,parts:[{words:word,startTimeMs:0,durationMs:3000}]}]);
      r.tick(1,{isPlaying:false});
      const p=r.lines[0].parts[0];
      check(!p.letterElements&&!p.highlightLetterElements, `${word}/${hdr}: mixed-direction word preserves native text shaping`);
      check((p.highlightElement.querySelector(':scope > .blyrics-image-fill')??p.highlightElement).textContent===word, `${word}/${hdr}: mixed-direction text is intact`);
    }
    r.setTheme('');r.setLyrics(originalLyrics);
    check(!r.container.querySelector('.blyrics-image-glow-run,.blyrics-image-glow'), 'Theme opt-out removes every optional glow run');
  } finally {
    mount.style.width=oldWidth;r.setTheme(theme);r.setLyrics(originalLyrics);view.tick(.6,false);
  }
  return checks;
}

// Check physical letter order AND visible mask progression. Matching sharp/glow
// masks alone cannot catch both copies revealing a visually reversed word.
export async function runLetterSweepDirectionChecks(view) {
  const {renderer:r,theme,lyrics}=view;
  const checks=[];
  const check=(ok,message)=>{if(!ok)throw new Error(message);checks.push(message)};
  const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const coverage=letter=>{
    const s=getComputedStyle(letter);
    const span=Number(s.getPropertyValue('--letters'))+2;
    const position=parseFloat(s.maskPosition)/100;
    const fade=parseFloat(s.getPropertyValue('--mask-fade'))/100;
    // Mask position percentages apply to (element width - mask width).
    const point=(.5-(1-span)*position)/span;
    const alpha=s.maskImage.includes('270deg')?(point-(.5-fade))/fade:(.5+fade-point)/fade;
    return Math.max(0,Math.min(1,alpha));
  };
  try {
    for(const hdr of [false,true])for(const [words,rtl] of [
      [['שלום','ABCD','עולם'],false],
      [['hello','שלום','world'],true],
      [['שלום','1234','עולם'],false],
    ]) {
      r.setTheme(hdr?theme:'');
      const fixture=[{words:words.join(' '),startTimeMs:0,durationMs:12000,
        parts:words.map((word,i)=>({words:word+(i<2?' ':''),startTimeMs:i*3000,durationMs:3000}))}];
      r.setLyrics(fixture);
      r.tick(3,{isPlaying:false});await frame();
      const p=r.lines[0].parts[1];
      const sets=[p.letterElements,p.highlightLetterElements,...(hdr?[p.imageLayers.glowLetters]:[])];
      for(const letters of sets){
        const x=letters.map(e=>e.getBoundingClientRect().x);
        check(x.every((n,i)=>i===0||(rtl?n<x[i-1]:n>x[i-1])), `${words[1]}/${hdr}: physical letter order follows the word`);
      }
      const samples=[];
      for(const phase of [-.3,.2,.4,.6,.8,1.2]){
        // Reconstruct at each media time; repeated paused ticks intentionally do
        // not advance an already-paused animation on the same active line.
        r.setLyrics(fixture);
        r.tick(3+phase*3,{isPlaying:false});await frame();
        const p=r.lines[0].parts[1];
        const sharp=p.highlightLetterElements.map(coverage);
        check(sharp.every((alpha,i)=>i===0||sharp[i-1]+.01>=alpha), `${words[1]}/${hdr}: reveal follows reading order`);
        if(samples.length)check(sharp.every((alpha,i)=>alpha+.01>=samples.at(-1)[i]), `${words[1]}/${hdr}: letters never reveal backwards`);
        if(hdr)check(p.imageLayers.glowLetters.every((e,i)=>Math.abs(coverage(e)-sharp[i])<.01), `${words[1]}: glow matches sharp reveal`);
        samples.push(sharp);
      }
      check(samples[0].every(a=>a<.01)&&samples.at(-1).every(a=>a>.99), `${words[1]}/${hdr}: hidden-to-visible sweep completes`);
    }
  }finally{r.setTheme(theme);r.setLyrics(lyrics);view.tick(.6,false)}
  return checks;
}
