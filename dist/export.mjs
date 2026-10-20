import * as MediaEngine from './vendor/mediabunny.mjs';
import { convertVideo, muxExportAudio } from './media.mjs';

export const EXPORT_FPS = 30;

export function exportBitrate(width, height) {
  return Math.round(Math.min(24000000, Math.max(4000000, width * height * 4)));
}

function checkExport(signal) {
  if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
}

// Media timestamps come from the source frames, never the speed of the UI or detector.
export async function exportMp4({ canvas, file, duration, includeAudio, renderFrame, signal, onProgress = () => {} }) {
  checkExport(signal);
  if (!globalThis.VideoEncoder || !globalThis.VideoFrame) {
    throw new Error('Smooth MP4 export needs a recent Chrome or Edge browser.');
  }
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('This video has no readable duration.');
  const { Input, ALL_FORMATS, BlobSource, Output, BufferTarget, Mp4OutputFormat, Conversion, CanvasSource, Quality } = MediaEngine;
  const quality = new Quality({ bitrate: exportBitrate(canvas.width, canvas.height) });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let input, conversion, preparedFile = file, needsAudioMux = false, complete = false;
  const abort = () => { (conversion ? conversion.cancel() : output.cancel()).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let lastYield = performance.now();
  async function yieldToUi() {
    checkExport(signal);
    if (performance.now() - lastYield > 40) {
      await new Promise(resolve => setTimeout(resolve, 0));
      lastYield = performance.now();
      checkExport(signal);
    }
  }
  try {
    if (file) {
      input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      let videoTrack;
      try {
        videoTrack = await input.getPrimaryVideoTrack();
        if (!videoTrack || !await videoTrack.canDecode()) throw new Error('The source codec needs conversion.');
      } catch (error) {
        checkExport(signal);
        input.dispose();
        preparedFile = await convertVideo(file, {signal, onProgress:message => onProgress(0, 0, message)});
        input = new Input({ source: new BlobSource(preparedFile), formats: ALL_FORMATS });
        videoTrack = await input.getPrimaryVideoTrack();
      }
      const audioTrack = includeAudio ? await input.getPrimaryAudioTrack() : null;
      if (!videoTrack) throw new Error('This file has no video track.');
      const audioChannels = audioTrack ? await audioTrack.getNumberOfChannels() : 0;
      const copyAudio = audioTrack?.codec === 'aac' && audioChannels <= 2
        && await audioTrack.getSampleRate() <= 48000
        && /^mp4a\.40\.0?2$/i.test((await audioTrack.getDecoderConfig())?.codec || '');
      const decoded = document.createElement('canvas');
      decoded.width = canvas.width; decoded.height = canvas.height;
      const decodedCtx = decoded.getContext('2d');
      conversion = await Conversion.init({
        input, output, tracks: 'primary', showWarnings: false, tags: {},
        video: {
          codec: 'avc', quality, frameRate: EXPORT_FPS, keyFrameInterval: 1,
          width: canvas.width, height: canvas.height, fit: 'contain', allowTransformationMetadata: false,
          process: async sample => {
            checkExport(signal);
            sample.draw(decodedCtx, 0, 0, decoded.width, decoded.height);
            await renderFrame(decoded, sample.timestamp);
            await yieldToUi();
            return canvas;
          }
        },
        // Existing AAC can be copied losslessly; other audio is normalized to AAC stereo.
        audio: !audioTrack ? { discard: true } : copyAudio ? { codec: 'aac' } : {
          codec: 'aac', quality: new Quality({ bitrate: 160000 }), sampleRate: 48000,
          numberOfChannels: Math.min(2, audioChannels)
        }
      });
      checkExport(signal);
      if (!conversion.isValid || !conversion.utilizedTracks.includes(videoTrack)) {
        throw new Error('This browser cannot encode this video as H.264 MP4. Try a recent Chrome or Edge, or 720p.');
      }
      // Some browsers can decode audio but have no AAC encoder. Keep all video frames,
      // then mux the original sound with the existing local WebAssembly converter.
      needsAudioMux = Boolean(audioTrack && !conversion.utilizedTracks.includes(audioTrack));
      conversion.onProgress = (progress, time) => onProgress(Math.min(.98, progress * .98), time, 'Rendering your video…');
      await conversion.execute();
    } else {
      const source = new CanvasSource(canvas, { codec: 'avc', quality, keyFrameInterval: 1 });
      output.addVideoTrack(source, { frameRate: EXPORT_FPS });
      await output.start();
      const count = Math.ceil(duration * EXPORT_FPS);
      for (let i = 0; i < count; i++) {
        checkExport(signal);
        const time = i / EXPORT_FPS;
        await renderFrame(null, time);
        checkExport(signal);
        await source.add(time, 1 / EXPORT_FPS);
        onProgress((i + 1) / count * .98, time, 'Rendering your video…');
        await yieldToUi();
      }
      source.close();
      await output.finalize();
    }
    checkExport(signal);
    let result = new Blob([output.target.buffer], { type: 'video/mp4' });
    if (needsAudioMux) {
      onProgress(.98, duration, 'Preparing your audio…');
      result = await muxExportAudio(result, preparedFile, {
        signal, duration, onProgress: message => onProgress(.98, duration, message)
      });
    }
    checkExport(signal);
    complete = true;
    onProgress(1, duration, 'Your video is ready.');
    return result;
  } catch (error) {
    checkExport(signal);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete && conversion?.state !== 'canceled' && output.state !== 'canceled') {
      await (conversion ? conversion.cancel() : output.cancel()).catch(() => {});
    }
    input?.dispose();
  }
}
