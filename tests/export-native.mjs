// Non-browser integration check: actual Mediabunny pipeline and MP4 muxer, with
// native FFmpeg codec adapters and a real canvas. This does not test browser WebCodecs.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import * as M from '../dist/vendor/mediabunny.mjs';
import { exportMp4, exportBitrate } from '../dist/export.mjs';
import { BoxEffectsRenderer } from '../dist/box-effects.mjs';
const require=createRequire(import.meta.url);
const { createCanvas, CanvasElement, ImageData, CanvasRenderingContext2D }=require(process.env.BLOB_TRACKER_TEST_CANVAS);
const root=path.resolve('test-artifacts');
const ffmpeg=path.resolve(process.env.BLOB_TRACKER_TEST_FFMPEG);
await mkdir(root,{recursive:true});
const dir=await mkdtemp(path.join(root,'export-integration-'));
function ff(args, input) {
  const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{cwd:dir,input,maxBuffer:100*1024*1024,timeout:15000});
  assert.equal(r.status,0,r.stderr?.toString());return r.stdout;
}
globalThis.HTMLCanvasElement=CanvasElement; globalThis.CanvasRenderingContext2D=createCanvas(1,1).getContext('2d').constructor;
globalThis.OffscreenCanvas=class {constructor(w,h){return createCanvas(w,h);} static [Symbol.hasInstance](x){return x instanceof CanvasElement;}};
globalThis.VideoFrame=class TestFrame {
  static [Symbol.hasInstance](x){return Boolean(x?._testFrame);}
  constructor(data,init) {
    const canvas=createCanvas(init.codedWidth||data.width,init.codedHeight||data.height);
    const ctx=canvas.getContext('2d');
    if(ArrayBuffer.isView(data))ctx.putImageData(new ImageData(new Uint8ClampedArray(data),canvas.width,canvas.height),0,0);
    else ctx.drawImage(data,0,0);
    Object.assign(canvas,{_testFrame:true,displayWidth:canvas.width,displayHeight:canvas.height,codedWidth:canvas.width,codedHeight:canvas.height,
      visibleRect:{x:0,y:0,width:canvas.width,height:canvas.height},timestamp:init.timestamp,duration:init.duration,format:'RGBA',
      colorSpace:{primaries:'bt709',transfer:'iec61966-2-1',matrix:'rgb',fullRange:true,toJSON(){return this;}}});
    canvas.close=()=>{};canvas.clone=()=>new VideoFrame(canvas,{timestamp:canvas.timestamp,duration:canvas.duration});
    canvas.allocationSize=()=>canvas.width*canvas.height*4;
    canvas.copyTo=async dest=>{new Uint8Array(dest.buffer||dest,dest.byteOffset||0).set(ctx.getImageData(0,0,canvas.width,canvas.height).data);return[{offset:0,stride:canvas.width*4}];};
    return canvas;
  }
};
globalThis.VideoEncoder=class {static async isConfigSupported(){return{supported:false};}};
globalThis.location={search:'?converter=browser',hostname:'127.0.0.1'};
globalThis.document={createElement:tag=>{assert.equal(tag,'canvas');return createCanvas(1,1);},getElementById:()=>null};
const raw=ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=15:duration=2','-pix_fmt','rgba','-f','rawvideo','pipe:1']);
const frameBytes=320*180*4;
class NativeDecoder extends M.CustomVideoDecoder {
  static supports(codec){return codec==='avc';}
  init(){} flush(){} close(){}
  decode(packet){const i=Math.min(29,Math.round(packet.timestamp*15));const data=raw.subarray(i*frameBytes,(i+1)*frameBytes);
    this.onSample(new M.VideoSample(new VideoFrame(data,{codedWidth:320,codedHeight:180,timestamp:Math.round(packet.timestamp*1e6),duration:Math.round(packet.duration*1e6)})));}
}
let emittedTimes=[];
class NativeEncoder extends M.CustomVideoEncoder {
  static supports(codec){return codec==='avc';}
  init(){this.frames=[];this.times=[];}
  encode(sample){this.times.push([sample.timestamp,sample.duration]);const canvas=sample.toCanvasImageSource();
    this.frames.push(Buffer.from(canvas.getContext('2d').getImageData(0,0,this.config.width,this.config.height).data));}
  async flush(){
    if(!this.frames.length)return;
    for(let i=1;i<this.times.length;i++)assert.ok(Math.abs(this.times[i][0]-this.times[i-1][0]-1/30)<.00001,'CFR timestamps before encoder');
    emittedTimes=this.times;
    const name='encoded-'+Math.random()+'.mp4';
    ff(['-f','rawvideo','-pixel_format','rgba','-video_size',`${this.config.width}x${this.config.height}`,'-framerate','30','-i','pipe:0','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-bf','0','-g','30',name],Buffer.concat(this.frames));
    const input=new M.Input({source:new M.BlobSource(new Blob([await readFile(path.join(dir,name))])),formats:M.ALL_FORMATS});
    const track=await input.getPrimaryVideoTrack(),config=await track.getDecoderConfig();
    let index=0;
    for await(const p of new M.EncodedPacketSink(track).packets()){
      const [time,duration]=this.times[index++];this.onPacket(new M.EncodedPacket(p.data,p.type,time,duration),{decoderConfig:config});
    }
    assert.equal(index,this.frames.length);input.dispose();this.frames=[];
  }
  close(){}
}
M.registerDecoder(NativeDecoder);M.registerEncoder(NativeEncoder);
const workerCode=await readFile('dist/conversion-worker.js','utf8');
globalThis.Worker=class NativeWorker {
  terminate(){}
  async postMessage(job){
    const wd=await mkdtemp(path.join(root,'export-audio-'));
    const fsmap=new Map();
    const core={ret:0,setLogger(){},setProgress(){},setTimeout(){},FS:{writeFile:(name,bytes)=>fsmap.set(name,bytes),readFile:name=>fsmap.get(name),unlink:name=>fsmap.delete(name)},
      exec(...args){for(const[name,bytes]of fsmap)require('node:fs').writeFileSync(path.join(wd,name),bytes);
        const r=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',...args],{cwd:wd,maxBuffer:3e6,timeout:15000});core.ret=r.status;
        if(r.status)throw new Error(r.stderr.toString());fsmap.set('output.mp4',new Uint8Array(require('node:fs').readFileSync(path.join(wd,'output.mp4'))));}};
    const self={createFFmpegCore:async()=>core,postMessage:data=>this.onmessage?.({data})};
    vm.runInNewContext(workerCode,{self,importScripts(){},btoa:s=>Buffer.from(s).toString('base64'),Uint8Array,JSON,Math});
    try{await self.onmessage({data:job});}catch(e){this.onerror?.(e);}finally{await rm(wd,{recursive:true,force:true});}
  }
};
async function inspect(blob,name,audio){
  const bytes=new Uint8Array(await blob.arrayBuffer());await writeFile(path.join(root,name),bytes);
  const s=Buffer.from(bytes);assert.ok(s.indexOf('moov')<s.indexOf('mdat'),'fast start');
  const i=new M.Input({source:new M.BlobSource(blob),formats:M.ALL_FORMATS});const v=await i.getPrimaryVideoTrack();
  assert.equal(v.codec,'avc');let count=0,last=null;
  for await(const p of new M.EncodedPacketSink(v).packets()){
    if(last!==null)assert.ok(Math.abs(p.timestamp-last-1/30)<.00001,`unexpected gap ${p.timestamp-last}`);last=p.timestamp;count++;
  }
  const a=await i.getPrimaryAudioTrack();assert.equal(Boolean(a),audio);if(a)assert.equal(a.codec,'aac');
  i.dispose();console.log(name,{frames:count,audio:Boolean(a),bytes:bytes.length});return count;
}
const canvas=createCanvas(320,180),ctx=canvas.getContext('2d');let draws=0;
const effectsRenderer=new BoxEffectsRenderer(()=>createCanvas(1,1));
const demo=await exportMp4({canvas,file:null,duration:1,includeAudio:false,async renderFrame(_,t){draws++;ctx.fillStyle='black';ctx.fillRect(0,0,320,180);ctx.fillStyle='#c5f56b';ctx.fillRect(t*200,50,30,30);
  if(draws%3===0)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);}});
assert.equal(await inspect(demo,'smooth-demo.mp4',false),30);assert.equal(draws,30);
ff(['-f','lavfi','-i','testsrc2=size=320x180:rate=15:duration=2','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2','-c:v','libx264','-bf','0','-c:a','aac','-shortest','input.mp4']);
const file=new Blob([await readFile(path.join(dir,'input.mp4'))]);
let rendered=0;
const uploaded=await exportMp4({canvas,file,duration:2,includeAudio:true,renderFrame(source){rendered++;ctx.drawImage(source,0,0);
  const before=[...ctx.getImageData(160,90,1,1).data];
  effectsRenderer.draw(ctx,[{x:.25,y:.25,w:.5,h:.5}],{boxEffects:true,fxThermal:true,fxPixelate:true});
  assert.notDeepEqual([...ctx.getImageData(160,90,1,1).data],before);
  ctx.strokeStyle='#ff3355';ctx.strokeRect(80,45,160,90);}});
assert.equal(await inspect(uploaded,'smooth-upload-audio.mp4',true),60);assert.equal(rendered,60);
const silent=await exportMp4({canvas,file,duration:2,includeAudio:false,renderFrame(source){ctx.drawImage(source,0,0);}});
assert.equal(await inspect(silent,'smooth-upload-silent.mp4',false),60);
ff(['-i','input.mp4','-c:v','copy','-c:a','libopus','input-opus.mkv']);
const fallback=await exportMp4({canvas,file:new Blob([await readFile(path.join(dir,'input-opus.mkv'))]),duration:2,includeAudio:true,renderFrame(source){ctx.drawImage(source,0,0);}});
assert.equal(await inspect(fallback,'smooth-upload-audio-fallback.mp4',true),60);
ff(['-i','input.mp4','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-b:v','500k','-c:a','libopus','input-vp8.webm']);
let prepared=false;
const converted=await exportMp4({canvas,file:new Blob([await readFile(path.join(dir,'input-vp8.webm'))]),duration:2,includeAudio:true,
  onProgress(_,__,message){if(message.includes('converter'))prepared=true;},renderFrame(source){ctx.drawImage(source,0,0);}});
assert.equal(await inspect(converted,'smooth-upload-source-fallback.mp4',true),60);assert.equal(prepared,true);
const controller=new AbortController();let cancelledDraws=0;
await assert.rejects(exportMp4({canvas,file:null,duration:2,includeAudio:false,signal:controller.signal,renderFrame(){if(++cancelledDraws===3)controller.abort();}}),e=>e.name==='AbortError');
assert.equal(cancelledDraws,3);assert.equal(exportBitrate(3840,2160),24000000);
await rm(dir,{recursive:true,force:true});console.log('All export integration checks passed.');



