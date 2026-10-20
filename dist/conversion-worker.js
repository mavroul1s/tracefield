// Single-thread FFmpeg core runs off the UI thread. Only the engine is downloaded.
// The selected File stays inside this worker's local filesystem.
self.onmessage = async ({data:{file, audio, duration, mode}}) => {
  let core;
  try {
    const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
    importScripts(`${base}/ffmpeg-core.js`);
    core = await self.createFFmpegCore({mainScriptUrlOrBlob:`${base}/ffmpeg-core.js#${btoa(JSON.stringify({wasmURL:`${base}/ffmpeg-core.wasm`}))}`});
    let details = '';
    core.setLogger(({message})=>{details=(details+'\n'+message).slice(-2000);});
    core.setProgress(({progress})=>self.postMessage({type:'progress',message:'Converting your video in this browser…',progress:Math.min(99,Math.max(0,progress*100))}));
    self.postMessage({type:'progress',message:'Decoding your original video…',progress:null});
    core.FS.writeFile('input',new Uint8Array(await file.arrayBuffer()));
    core.setTimeout(240000);
    if(mode==='mux-audio') {
      if(!Number.isFinite(duration)||duration<=0)throw new Error('The export has no valid duration.');
      core.FS.writeFile('audio',new Uint8Array(await audio.arrayBuffer()));
      core.exec('-i','input','-i','audio','-map','0:v:0','-map','1:a:0','-c:v','copy',
        '-c:a','aac','-b:a','160k','-ar','48000','-ac','2','-af','aresample=async=1:first_pts=0,apad',
        '-t',String(duration),'-movflags','+faststart','output.mp4');
    } else {
      core.exec('-i','input','-map','0:v:0','-map','0:a:0?','-vf','scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k','-movflags','+faststart','output.mp4');
    }
    if(core.ret!==0) throw new Error(details.includes('matches no streams')?'This file has no video track.':'Could not decode this video. Try the local app or an H.264 MP4.');
    const bytes = core.FS.readFile('output.mp4');
    self.postMessage({type:'done',bytes},[bytes.buffer]);
  } catch(error) { self.postMessage({type:'error',message:error.message || 'Video conversion failed.'}); }
  finally { if(core) {for(const name of ['input','audio','output.mp4']){try{core.FS.unlink(name);}catch{}}} }
};
