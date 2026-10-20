import { BlobTracker, connectionEdges, tuneDetection } from './tracker.mjs';
import { validateVideoFrame, convertVideo } from './media.mjs';
import { exportMp4, EXPORT_FPS } from './export.mjs';
import { BoxEffectsRenderer } from './box-effects.mjs';

const $ = id => document.getElementById(id);
const canvas = $('outputCanvas'), ctx = canvas.getContext('2d');
const video = $('sourceVideo');
const sourceCanvas = document.createElement('canvas'), sourceCtx = sourceCanvas.getContext('2d');
const analysis = document.createElement('canvas'), analysisCtx = analysis.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas'), maskCtx = maskCanvas.getContext('2d');
const tracker = new BlobTracker();
const boxEffectsRenderer = new BoxEffectsRenderer();
const defaults = { detectionMode:'bright', threshold:150, minArea:80, maxBlobs:20, smoothing:35, boxes:true, labels:true,
  centers:true, connections:true, trails:false, color:'#c5f56b', separateColors:false, boxColor:'#c5f56b', connectionColor:'#77c9ff', pointColor:'#ffb86b',
  lineWidth:1.5, sourceOpacity:100, grayscale:false, quality:384, exportSize:'1080', includeAudio:true,
  boxEffects:false, fxXray:true, fxZoom:false, fxPixelate:false, fxThermal:false, fxInvert:false };
const overlayColorKeys = ['boxColor','connectionColor','pointColor'];
const ranges = { threshold:'', minArea:' px', maxBlobs:'', smoothing:'%', lineWidth:' px', sourceOpacity:'%' };
let settings = { ...defaults }, demo = true, playing = true, demoTime = 0, demoLast = performance.now();
let sourceUrl = null, sourceName = 'motion-study', loaded = false, maskView = false, originalView = false, dirty = true, lastMediaTime = -1;
let frame = 0, tracks = [], muted = true, fps = 30, framesSinceStats = 0, lastStats = performance.now();
let exporting = false, downloadUrl = null, exportController = null, exportTime = 0;
let pendingLoad = false, sourceBlob = null;
let exportPrevious = null;
let importController = null;

function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function formatTime(t) { if (!Number.isFinite(t)) t = 0; return `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t%60)).padStart(2,'0')}`; }
function duration() { return demo ? 12 : (Number.isFinite(video.duration) ? video.duration : 0); }
function mediaTime() { return exporting ? exportTime : demo ? demoTime : video.currentTime; }
function dimensions() { return demo ? [1280,720] : [video.videoWidth,video.videoHeight]; }
function resizeOutput() {
  const [w,h] = dimensions();
  if(!w || !h)return false;
  const target = settings.exportSize === 'source' ? 2160 : Number(settings.exportSize);
  const scale = Math.min(1,target / Math.min(w,h),3840/Math.max(w,h));
  canvas.width = Math.max(2,Math.round(w*scale/2)*2); canvas.height = Math.max(2,Math.round(h*scale/2)*2);
  sourceCanvas.width = demo ? w : 1; sourceCanvas.height = demo ? h : 1;
  $('resolution').textContent = `${canvas.width} × ${canvas.height}`;
  $('dropZone').style.aspectRatio = `${w}/${h}`;
  dirty = true;
}
function resetTracker() { tracker.reset(); tracks = []; lastMediaTime = -1; dirty = true; frame = 0; }
function syncControls() {
  for (const [key,value] of Object.entries(settings)) {
    if ($(key).type === 'checkbox') $(key).checked = value; else $(key).value = value;
    if (ranges[key] !== undefined) $(`${key}Value`).textContent = `${value}${ranges[key]}`;
  }
  syncSwatches(); syncColorControls(); syncBoxEffectControls(); updateHint();
  $('processingSize').textContent = `${settings.quality} PX ANALYSIS`;
}
function syncSwatches() { document.querySelectorAll('[data-color]').forEach(b=>{const active = b.dataset.color === settings.color.toLowerCase();b.classList.toggle('active',active);b.setAttribute('aria-pressed',active);}); }
function syncColorControls() {
  $('sharedColorControls').hidden=settings.separateColors;
  $('separateColorControls').hidden=!settings.separateColors;
  for(const key of overlayColorKeys){$(`${key}Hex`).value=settings[key].toUpperCase();$(`${key}Hex`).removeAttribute('aria-invalid');}
}
function syncBoxEffectControls() {
  $('boxEffectsPanel').hidden=!settings.boxEffects;
  $('boxEffects').setAttribute('aria-expanded',String(settings.boxEffects));
}
function updateHint() {
  $('modeHint').textContent = {bright:'Best for light subjects on a dark background.',dark:'Best for dark subjects on a light background.',motion:'Best with a fixed camera. Lower threshold detects subtler movement.'}[settings.detectionMode];
}
function clearPreset() { document.querySelectorAll('[data-preset]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false');}); }
function setPreset(name) {
  const styles = {
    classic:{boxes:true,labels:true,centers:true,connections:true,trails:false,color:'#c5f56b',lineWidth:1.5,sourceOpacity:65,grayscale:false},
    technical:{boxes:true,labels:true,centers:true,connections:true,trails:false,color:'#ffffff',lineWidth:1,sourceOpacity:80,grayscale:true},
    trails:{boxes:true,labels:true,centers:true,connections:false,trails:true,color:'#c5f56b',lineWidth:1.5,sourceOpacity:35,grayscale:true}
  };
  Object.assign(settings,styles[name],{separateColors:false});
  clearPreset(); const b=document.querySelector(`[data-preset="${name}"]`);b.classList.add('active');b.setAttribute('aria-pressed','true');
  syncControls(); dirty=true;
}
for (const key of Object.keys(defaults)) $(key).addEventListener('input', () => {
  if (exporting) return;
  const el=$(key); settings[key] = el.type==='checkbox' ? el.checked : (typeof defaults[key]==='number' ? Number(el.value) : el.value);
  if (ranges[key]!==undefined) $(`${key}Value`).textContent = `${settings[key]}${ranges[key]}`;
  if (['detectionMode','quality','threshold','minArea','maxBlobs'].includes(key)) resetTracker();
  if (key==='detectionMode') { settings.threshold = settings.detectionMode==='motion' ? 25 : 150; syncControls(); }
  if (key==='quality') $('processingSize').textContent=`${settings.quality} PX ANALYSIS`;
  if (key==='exportSize') resizeOutput();
  if (key==='color') syncSwatches();
  if (key==='separateColors' || overlayColorKeys.includes(key)) syncColorControls();
  if (key==='boxEffects') syncBoxEffectControls();
  clearPreset(); dirty=true;
});
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',()=>setPreset(b.dataset.preset)));
document.querySelectorAll('[data-color]').forEach(b=>b.addEventListener('click',()=>{settings.color=b.dataset.color;$('color').value=settings.color;syncSwatches();clearPreset();dirty=true;}));
for(const key of overlayColorKeys) {
  const input=$(`${key}Hex`);
  input.addEventListener('input',()=>{
    if(exporting)return;
    const value=input.value.trim();
    if(!/^#[0-9a-f]{6}$/i.test(value)){input.setAttribute('aria-invalid','true');return;}
    input.removeAttribute('aria-invalid');settings[key]=value.toLowerCase();$(key).value=settings[key];clearPreset();dirty=true;
  });
  input.addEventListener('blur',()=>{if(/^#[0-9a-f]{6}$/i.test(input.value.trim()))input.value=settings[key].toUpperCase();});
}
$('resetButton').addEventListener('click',()=>{settings={...defaults};syncControls();setPreset('classic');resizeOutput();resetTracker();notice('Controls reset.');});
$('resetTracking').addEventListener('click',()=>{resetTracker();notice('Tracking reset. The current frame is the new motion background.');});

function drawDemo(time) {
  const w=sourceCanvas.width,h=sourceCanvas.height;
  sourceCtx.fillStyle='#0e1412'; sourceCtx.fillRect(0,0,w,h);
  sourceCtx.strokeStyle='#1a241e'; sourceCtx.lineWidth=1;
  for(let x=0;x<w;x+=64){sourceCtx.beginPath();sourceCtx.moveTo(x,0);sourceCtx.lineTo(x,h);sourceCtx.stroke();}
  for(let y=0;y<h;y+=64){sourceCtx.beginPath();sourceCtx.moveTo(0,y);sourceCtx.lineTo(w,y);sourceCtx.stroke();}
  for(let i=0;i<6;i++) {
    const phase=i*1.13, cx=w*(0.18+(i%3)*0.30+Math.sin(time*0.55+phase)*0.065);
    const cy=h*(0.30+Math.floor(i/3)*0.38+Math.cos(time*0.75+phase)*0.08);
    const rx=w*(0.044+Math.sin(time*0.7+i)*0.012),ry=h*(0.065+Math.cos(time*0.6+i)*0.018);
    sourceCtx.save();sourceCtx.translate(cx,cy);sourceCtx.rotate(Math.sin(time*.35+phase)*.35);
    const g=sourceCtx.createRadialGradient(-rx*.2,-ry*.3,0,0,0,Math.max(rx,ry)*1.6);
    g.addColorStop(0,'#e2e7d6');g.addColorStop(.65,'#afbca0');g.addColorStop(1,'#718865');
    sourceCtx.fillStyle=g;sourceCtx.beginPath();
    for(let a=0;a<=Math.PI*2+.1;a+=.06){const wobble=1+Math.sin(a*3+time*.4+phase)*.12+Math.cos(a*5-time*.3)*.04;const x=Math.cos(a)*rx*wobble,y=Math.sin(a)*ry*wobble;a===0?sourceCtx.moveTo(x,y):sourceCtx.lineTo(x,y);}
    sourceCtx.closePath();sourceCtx.fill();sourceCtx.restore();
  }
}
function drawOverlay() {
  const w=canvas.width,h=canvas.height,scale=Math.max(.7,Math.min(w,h)/720);
  const boxColor=settings.separateColors?settings.boxColor:settings.color;
  const connectionColor=settings.separateColors?settings.connectionColor:settings.color;
  const pointColor=settings.separateColors?settings.pointColor:settings.color;
  ctx.save();ctx.lineWidth=settings.lineWidth*scale;
  if(settings.connections) {
    ctx.strokeStyle=connectionColor;ctx.globalAlpha=.48;ctx.beginPath();
    for(const [a,b] of connectionEdges(tracks)){ctx.moveTo(tracks[a].cx*w,tracks[a].cy*h);ctx.lineTo(tracks[b].cx*w,tracks[b].cy*h);}ctx.stroke();ctx.globalAlpha=1;
  }
  for(const t of tracks) {
    const x=t.x*w,y=t.y*h,bw=t.w*w,bh=t.h*h,cx=t.cx*w,cy=t.cy*h;
    if(settings.trails && t.history.length>1){ctx.strokeStyle=pointColor;for(let i=1;i<t.history.length;i++){ctx.globalAlpha=(i/t.history.length)*.65;ctx.beginPath();ctx.moveTo(t.history[i-1][0]*w,t.history[i-1][1]*h);ctx.lineTo(t.history[i][0]*w,t.history[i][1]*h);ctx.stroke();}ctx.globalAlpha=1;}
    if(settings.boxes){ctx.strokeStyle=boxColor;ctx.globalAlpha=.85;ctx.strokeRect(x,y,bw,bh);ctx.globalAlpha=1;const c=Math.min(8*scale,bw*.2,bh*.2);ctx.lineWidth=(settings.lineWidth+.5)*scale;ctx.beginPath();ctx.moveTo(x,y+c);ctx.lineTo(x,y);ctx.lineTo(x+c,y);ctx.moveTo(x+bw-c,y+bh);ctx.lineTo(x+bw,y+bh);ctx.lineTo(x+bw,y+bh-c);ctx.stroke();ctx.lineWidth=settings.lineWidth*scale;}
    if(settings.centers){ctx.strokeStyle=pointColor;ctx.fillStyle=pointColor;const r=5*scale;ctx.beginPath();ctx.moveTo(cx-r,cy);ctx.lineTo(cx+r,cy);ctx.moveTo(cx,cy-r);ctx.lineTo(cx,cy+r);ctx.stroke();ctx.beginPath();ctx.arc(cx,cy,1.7*scale,0,Math.PI*2);ctx.fill();}
    if(settings.labels) {
      const text=`ID ${String(t.id).padStart(3,'0')}`,fontSize=11*scale;
      ctx.font=`${fontSize}px "Cascadia Code",Consolas,monospace`;
      const tw=ctx.measureText(text).width+8*scale,lx=Math.max(2,Math.min(x,w-tw-2)),ly=Math.max(fontSize+7*scale,y-5*scale);
      ctx.fillStyle='#091006';ctx.globalAlpha=.85;ctx.fillRect(lx,ly-fontSize-4*scale,tw,fontSize+7*scale);ctx.globalAlpha=1;ctx.fillStyle=pointColor;ctx.fillText(text,lx+4*scale,ly);
    }
  }
  ctx.restore();
}
function render(advance, sourceOverride = null) {
  if (!sourceOverride && !demo && (!loaded || video.readyState < 2 || !video.videoWidth || !video.videoHeight)) return false;
  if(demo && !sourceOverride) drawDemo(demoTime);
  const source = sourceOverride || (demo ? sourceCanvas : video);
  const [w,h]=dimensions(),aw=Math.round(settings.quality),ah=Math.max(2,Math.round(aw*h/w));
  // Portrait clips get the same pixel budget as landscape clips.
  const finalW=w<h?Math.max(2,Math.round(settings.quality*w/h)):aw,finalH=w<h?aw:ah;
  if(analysis.width!==finalW||analysis.height!==finalH){analysis.width=finalW;analysis.height=finalH;maskCanvas.width=finalW;maskCanvas.height=finalH;}
  analysisCtx.clearRect(0,0,finalW,finalH);
  analysisCtx.drawImage(source,0,0,finalW,finalH);
  const pixels=analysisCtx.getImageData(0,0,finalW,finalH);
  const blobs=tracker.detect(pixels.data,finalW,finalH,{mode:settings.detectionMode,threshold:settings.threshold,minArea:settings.minArea,maxBlobs:settings.maxBlobs,advance});
  tracks=tracker.update(blobs,settings.smoothing/100,advance);
  ctx.fillStyle='#050806';ctx.fillRect(0,0,canvas.width,canvas.height);
  if(originalView)ctx.drawImage(source,0,0,canvas.width,canvas.height);
  else if(maskView){const maskImage=maskCtx.createImageData(finalW,finalH);for(let i=0;i<tracker.mask.length;i++){const v=tracker.mask[i]?230:7,p=i*4;maskImage.data[p]=v;maskImage.data[p+1]=v;maskImage.data[p+2]=v;maskImage.data[p+3]=255;}maskCtx.putImageData(maskImage,0,0);ctx.imageSmoothingEnabled=false;ctx.drawImage(maskCanvas,0,0,canvas.width,canvas.height);ctx.imageSmoothingEnabled=true;}
  else{ctx.save();ctx.filter=settings.grayscale?'grayscale(1)':'none';ctx.globalAlpha=settings.sourceOpacity/100;ctx.drawImage(source,0,0,canvas.width,canvas.height);ctx.restore();}
  if(!originalView&&!maskView)boxEffectsRenderer.draw(ctx,tracks,settings);
  if(!originalView)drawOverlay();
  if(advance)frame++;
  $('frameNumber').textContent=String(frame).padStart(5,'0');$('canvasBlobCount').textContent=`${String(tracks.length).padStart(2,'0')} OBJECTS`;
  framesSinceStats++;
}
function updatePlaybackUi() {
  const active=demo?playing:!video.paused;
  $('playButton').textContent=active?'Ⅱ':'▶';$('playButton').setAttribute('aria-label',active?'Pause':'Play');
  $('timeDisplay').textContent=`${formatTime(mediaTime())} / ${formatTime(duration())}`;
  $('scrubber').max=duration();$('scrubber').value=mediaTime();
  $('liveStatus').innerHTML=`<span class="status-dot"></span> ${pendingLoad?'OPENING VIDEO':exporting?'RENDERING':active?'LIVE PREVIEW':'PAUSED'}`;
}
function loop(now) {
  const dt=Math.min((now-demoLast)/1000,.1);demoLast=now;
  if(exporting){updatePlaybackUi();requestAnimationFrame(loop);return;}
  if(demo && playing){demoTime+=dt;if(demoTime>=12){demoTime%=12;resetTracker();}}
  const t=mediaTime();
  if((demo || loaded) && (dirty || t!==lastMediaTime)) {
    const advance=t!==lastMediaTime;if(render(advance)!==false){lastMediaTime=t;dirty=false;}
  }
  if(now-lastStats>450){fps=Math.round(framesSinceStats*1000/(now-lastStats));$('fps').textContent=(demo?playing:!video.paused)?Math.min(fps,60):'—';$('blobCount').textContent=tracks.length;lastStats=now;framesSinceStats=0;}
  updatePlaybackUi();
  requestAnimationFrame(loop);
}
async function togglePlay() {
  if(exporting)return;
  if(demo){playing=!playing;demoLast=performance.now();}
  else if(loaded){if(video.paused){if(video.currentTime>=duration()-.05){video.currentTime=0;resetTracker();}try{await video.play();}catch{notice('Playback was blocked. Press Play again.',true);}}else video.pause();}
}
function seek(time) {
  if(exporting)return;
  resetTracker();
  if(demo)demoTime=time;else if(loaded)video.currentTime=time;
  dirty=true;
}
$('playButton').addEventListener('click',togglePlay);$('restartButton').addEventListener('click',()=>seek(0));
$('scrubber').addEventListener('input',()=>seek(Number($('scrubber').value)));
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','BUTTON','A'].includes(document.activeElement.tagName)&&!$('helpDialog').open){e.preventDefault();togglePlay();}});
$('muteButton').addEventListener('click',()=>{muted=!muted;video.muted=muted;$('muteButton').textContent=muted?'Sound off':'Sound on';});
$('fullscreenButton').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('dropZone').requestFullscreen();}catch{notice('Fullscreen is unavailable in this browser.');}});
function setView(mask){originalView=false;maskView=mask;$('sourceView').classList.remove('active');$('sourceView').setAttribute('aria-pressed','false');$('effectView').classList.toggle('active',!mask);$('maskView').classList.toggle('active',mask);$('effectView').setAttribute('aria-pressed',!mask);$('maskView').setAttribute('aria-pressed',mask);dirty=true;}
function showOriginal(){setView(false);originalView=true;$('sourceView').classList.add('active');$('sourceView').setAttribute('aria-pressed','true');$('effectView').classList.remove('active');$('effectView').setAttribute('aria-pressed','false');dirty=true;}
$('sourceView').addEventListener('click',()=>{if(!exporting)showOriginal();});
$('effectView').addEventListener('click',()=>{if(!exporting)setView(false);});$('maskView').addEventListener('click',()=>{if(!exporting)setView(true);});

function setLoadingUi(active){
  document.body.classList.toggle('importing',active);$('importPanel').hidden=!active;
  for(const id of ['uploadButton','exportButton','demoButton','playButton','restartButton','scrubber','snapshotButton','resetButton','autoTune'])$(id).disabled=active||(!demo&&!loaded&&['exportButton','playButton','restartButton','scrubber','snapshotButton','autoTune'].includes(id));
}
function loadMedia(blob,signal){
  if(sourceUrl)URL.revokeObjectURL(sourceUrl);
  sourceBlob=blob;sourceUrl=URL.createObjectURL(blob);video.src=sourceUrl;video.muted=true;video.loop=true;video.playbackRate=1;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>finish(new Error('Opening this video timed out.')),15000);
    const ok=()=>{try{validateVideoFrame(video);finish();}catch(error){finish(error);}};
    const bad=()=>finish(new Error('This browser cannot decode this video.'));
    const aborted=()=>finish(new DOMException('Video loading cancelled.','AbortError'));
    function finish(error){clearTimeout(timer);video.removeEventListener('loadeddata',ok);video.removeEventListener('error',bad);signal?.removeEventListener('abort',aborted);error?reject(error):resolve();}
    video.addEventListener('loadeddata',ok,{once:true});video.addEventListener('error',bad,{once:true});signal?.addEventListener('abort',aborted,{once:true});
    if(signal?.aborted){aborted();return;}video.load();
  });
}
function autoTune(showNotice=true){
  if(!demo&&!loaded)return;
  const source=demo?sourceCanvas:video,[w,h]=dimensions();
  const sw=Math.round(384*w/Math.max(w,h)),sh=Math.round(384*h/Math.max(w,h));
  const sample=document.createElement('canvas');sample.width=sw;sample.height=sh;
  const sampleCtx=sample.getContext('2d',{willReadFrequently:true});sampleCtx.drawImage(source,0,0,sw,sh);
  const result=tuneDetection(sampleCtx.getImageData(0,0,sw,sh).data,sw,sh,settings.minArea,settings.maxBlobs);
  if(result.count){settings.detectionMode=result.mode;settings.threshold=result.threshold;syncControls();resetTracker();if(showNotice)notice(`Detection tuned to this video. ${result.mode==='bright'?'Bright':'Dark'} areas · threshold ${result.threshold}.`);}
  else if(showNotice)notice('No clear blobs in this frame. Try Moving areas, or lower Minimum blob size.',true);
}
$('autoTune').addEventListener('click',()=>autoTune());
$('cancelImport').addEventListener('click',()=>importController?.abort());
async function loadFile(file) {
  if(!file || exporting || pendingLoad)return;
  if(!file.type.startsWith('video/')&&!/\.(mp4|mov|webm|m4v|ogv|avi|mkv)$/i.test(file.name)){notice('Choose a video file, such as MP4 or WebM.',true);return;}
  pendingLoad=true;notice('');importController=new AbortController();const {signal}=importController;
  video.pause();playing=false;demo=false;loaded=false;resetTracker();hideDownload();
  analysisCtx.clearRect(0,0,analysis.width,analysis.height);ctx.clearRect(0,0,canvas.width,canvas.height);
  $('fileName').textContent=file.name;$('demoTag').hidden=true;$('clipTitle').textContent=file.name;$('clipSubtitle').textContent='Checking video playback…';
  $('frameNumber').textContent='00000';$('resolution').textContent='DECODING VIDEO';
  $('blobCount').textContent='0';$('canvasBlobCount').textContent='00 OBJECTS';setLoadingUi(true);
  $('importTitle').textContent='Opening your video…';$('importProgress').removeAttribute('value');
  let converted=false;
  try {
    try{await loadMedia(file,signal);}catch(error){
      if(signal.aborted)throw error;
      video.pause();
      const playable=await convertVideo(file,{signal,onProgress:(message,progress)=>{$('importTitle').textContent=message;if(progress===null)$('importProgress').removeAttribute('value');else $('importProgress').value=progress;}});
      await loadMedia(playable,signal);converted=true;
    }
    demo=false;loaded=true;sourceName=file.name.replace(/\.[^.]+$/,'');
    $('fileName').textContent=file.name;$('demoTag').hidden=true;$('clipTitle').textContent=file.name;
    $('clipSubtitle').textContent=`${video.videoWidth} × ${video.videoHeight} · ${formatTime(video.duration)} · ${(file.size/1024/1024).toFixed(1)} MB${converted?' · converted locally':''}`;
    $('muteButton').disabled=false;resizeOutput();resetTracker();hideDownload();
    settings.sourceOpacity=100;settings.grayscale=false;syncControls();setView(false);autoTune(false);render(true);
    video.muted=muted;
    try{await video.play();notice(converted?'Your MOV was converted locally. The original footage and tracking effect are ready.':'Video ready. Detection is tuned to your footage.');}catch{notice('Video ready. Press Play to start.');}
  } catch(e){video.pause();loaded=false;tracks=[];ctx.clearRect(0,0,canvas.width,canvas.height);$('clipSubtitle').textContent='No decoded video frames — export disabled.';notice(signal.aborted?'Video loading cancelled.':e.message,true);}
  finally{pendingLoad=false;importController=null;setLoadingUi(false);$('fileInput').value='';}
}
$('uploadButton').addEventListener('click',()=>{if(!exporting)$('fileInput').click();});$('fileInput').addEventListener('change',e=>loadFile(e.target.files[0]));
let dragDepth=0;
document.addEventListener('dragover',e=>e.preventDefault());document.addEventListener('drop',e=>e.preventDefault());
$('dropZone').addEventListener('dragenter',e=>{e.preventDefault();if(!exporting){dragDepth++;$('dropZone').classList.add('dragover');}});
$('dropZone').addEventListener('dragleave',()=>{if(--dragDepth<=0){dragDepth=0;$('dropZone').classList.remove('dragover');}});
$('dropZone').addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('dropZone').classList.remove('dragover');loadFile(e.dataTransfer.files[0]);});
function loadDemo(showNotice=true) {
  if(exporting)return;video.pause();if(sourceUrl){URL.revokeObjectURL(sourceUrl);sourceUrl=null;}video.removeAttribute('src');video.load();
  demo=true;loaded=false;sourceBlob=null;playing=true;demoTime=0;demoLast=performance.now();sourceName='motion-study';
  setLoadingUi(false);
  $('fileName').textContent='Built-in motion study';$('demoTag').hidden=false;$('clipTitle').textContent='Start with your own footage';$('clipSubtitle').textContent='Drop a video onto the preview, or use Upload video.';$('muteButton').disabled=true;
  resizeOutput();resetTracker();hideDownload();if(showNotice)notice('Demo loaded. Upload your own video whenever you’re ready.');
}
$('demoButton').addEventListener('click',()=>loadDemo());
video.addEventListener('seeked',()=>{dirty=true;});
video.addEventListener('timeupdate',()=>{if(!exporting&&video.loop&&video.currentTime<lastMediaTime-.2)resetTracker();});

function saveBlob(blob,name) { const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000); }
$('snapshotButton').addEventListener('click',()=>canvas.toBlob(blob=>{if(blob){saveBlob(blob,`${sourceName}-tracefield.png`);notice('Frame saved as PNG.');}},'image/png'));
function hideDownload(){if(downloadUrl){URL.revokeObjectURL(downloadUrl);downloadUrl=null;}$('downloadPanel').hidden=true;}
function setExportUi(active) {
  exporting=active;document.body.classList.toggle('exporting',active);$('exportPanel').hidden=!active;
  for(const id of ['uploadButton','exportButton','demoButton','playButton','restartButton','scrubber','resetButton','snapshotButton','muteButton','effectView','maskView','sourceView','autoTune'])$(id).disabled=active||(id==='muteButton'&&demo);
}
async function startExport() {
  if(exporting||pendingLoad)return;
  if(!demo){try{validateVideoFrame(video);}catch(error){notice(error.message+' Load a supported video before exporting.',true);return;}}
  exportPrevious={time:mediaTime(),playing:demo?playing:!video.paused,mask:maskView,original:originalView};
  exportController=new AbortController();exportTime=0;hideDownload();notice('');
  video.pause();playing=false;setExportUi(true);setView(false);resetTracker();$('exportProgress').value=0;
  try {
    const blob=await exportMp4({
      canvas,file:demo?null:sourceBlob,duration:duration(),includeAudio:settings.includeAudio,signal:exportController.signal,
      renderFrame:(source,time)=>{exportTime=time;if(demo)demoTime=time;if(render(true,source)===false)throw new Error('No decoded video frame is available.');},
      onProgress:(progress,time,message)=>{exportTime=time;$('exportProgress').value=progress*100;$('exportTitle').textContent=`${message} ${Math.floor(progress*100)}%`;}
    });
    downloadUrl=URL.createObjectURL(blob);$('downloadLink').href=downloadUrl;$('downloadLink').download=`${sourceName}-tracefield.mp4`;
    $('downloadDetail').textContent=`MP4 · ${EXPORT_FPS} FPS · ${(blob.size/1024/1024).toFixed(1)} MB · ${canvas.width} × ${canvas.height}`;
    $('downloadPanel').hidden=false;notice('Export complete. Your download is ready.');
  } catch(error) {
    const aborted=exportController.signal.aborted;
    notice(aborted?'Export cancelled.':error.message||'Could not export the video. Try 720p.',!aborted);
  } finally {
    exportController=null;setExportUi(false);restorePlayback();
  }
}
function restorePlayback() {
  if(exportPrevious){setView(exportPrevious.mask);if(exportPrevious.original)showOriginal();if(demo){demoTime=exportPrevious.time;playing=exportPrevious.playing;demoLast=performance.now();}else{video.loop=true;video.currentTime=exportPrevious.time;if(exportPrevious.playing)video.play().catch(()=>{});else video.pause();}}
  exportPrevious=null;resetTracker();dirty=true;
}
$('exportButton').addEventListener('click',startExport);$('cancelExport').addEventListener('click',()=>exportController?.abort());
$('helpButton').addEventListener('click',()=>$('helpDialog').showModal());$('closeHelp').addEventListener('click',()=>$('helpDialog').close());$('helpDone').addEventListener('click',()=>$('helpDialog').close());
$('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog')){const r=$('helpDialog').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('helpDialog').close();}});
window.addEventListener('beforeunload',()=>{if(sourceUrl)URL.revokeObjectURL(sourceUrl);if(downloadUrl)URL.revokeObjectURL(downloadUrl);});
syncControls();resizeOutput();requestAnimationFrame(loop);
