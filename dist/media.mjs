export function validateVideoFrame(video) {
  if (!video.videoWidth || !video.videoHeight) {
    const error = new Error('This browser can read the audio but cannot decode the video codec.');
    error.code = 'VIDEO_CODEC'; throw error;
  }
  if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error('This video has no readable duration.');
  if (video.readyState < 2) throw new Error('The video frame is not decoded yet.');
}

// Only the loopback app sends a file to a local helper. Hosted and standalone copies use WebAssembly.
// Neither path sends video content to an external service.
export async function convertVideo(file, { signal, onProgress = () => {} } = {}) {
  const forceBrowser = new URLSearchParams(location.search).get('converter') === 'browser';
  if (!forceBrowser && ['127.0.0.1','localhost','[::1]'].includes(location.hostname)) {
    let capability;
    try {
      const response = await fetch('./api/capabilities', { signal });
      if (response.ok && response.headers.get('content-type')?.includes('application/json')) capability = await response.json();
    } catch (error) { if (signal?.aborted) throw error; }
    if (capability?.convert) {
      onProgress('Converting your video locally…', null);
      const response = await fetch('./api/convert', { method:'POST', body:file, signal, headers:{'Content-Type':'application/octet-stream'} });
      if (!response.ok) { const error = await response.json().catch(()=>({})); throw new Error(error.error || 'Local conversion failed.'); }
      return response.blob();
    }
  }
  if (file.size > 500 * 1024 * 1024) throw new Error('This file is too large for browser conversion. Use the local app or convert it to H.264 MP4 first.');
  return runMediaWorker({file}, {signal, onProgress});
}

export function muxExportAudio(file, audio, {duration, ...options} = {}) {
  return runMediaWorker({file, audio, duration, mode:'mux-audio'}, options);
}

function runMediaWorker(job, { signal, onProgress = () => {} } = {}) {
  onProgress('Loading the browser video converter (31 MB)…', null);
  return new Promise((resolve,reject) => {
    const embeddedSource = document.getElementById('conversionWorkerSource')?.textContent;
    const workerUrl = embeddedSource
      ? URL.createObjectURL(new Blob([embeddedSource], {type:'text/javascript'}))
      : new URL('./conversion-worker.js',import.meta.url);
    let worker;
    try { worker = new Worker(workerUrl); }
    catch (error) { if (embeddedSource) URL.revokeObjectURL(workerUrl); reject(error); return; }
    const timer = setTimeout(()=>finish(new Error('Conversion timed out. Try the local app for faster conversion.')),300000);
    const abort = () => finish(new DOMException('Video loading cancelled.','AbortError'));
    function finish(error, bytes) {
      clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.terminate();
      if (embeddedSource) URL.revokeObjectURL(workerUrl);
      error ? reject(error) : resolve(new Blob([bytes],{type:'video/mp4'}));
    }
    worker.onmessage = ({data}) => {
      if(data.type==='progress') onProgress(data.message,data.progress);
      if(data.type==='done') finish(null,data.bytes);
      if(data.type==='error') finish(new Error(data.message));
    };
    worker.onerror = () => finish(new Error('The browser video converter could not start. Check your connection or use the local app.'));
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    worker.postMessage(job);
  });
}
