import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EXPORT_FPS, exportBitrate, exportMp4 } from './dist/export.mjs';

test('export uses 30 FPS and bounds bitrate for phone decoding at every supported resolution', () => {
  assert.equal(EXPORT_FPS, 30);
  assert.equal(exportBitrate(1280,720), 4000000);
  assert.equal(exportBitrate(1920,1080), 8294400);
  assert.equal(exportBitrate(3840,2160), 24000000);
  assert.equal(exportBitrate(2160,3840), 24000000);
});

test('a canceled export stops before initializing codecs or publishing a partial file', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(exportMp4({signal:controller.signal}), error => error.name === 'AbortError');
});

test('missing browser encoders fail clearly rather than falling back to an uneven recording', async () => {
  await assert.rejects(exportMp4({}), /recent Chrome or Edge/);
});

// Optional real MP4 integration check; no browser automation. Native FFmpeg substitutes
// the platform codecs while exercising the shipped decoder pipeline, muxer and exporter.
test('CFR MP4, slow rendering, original audio, silent output, AAC fallback, and cancellation', {
  skip: !process.env.BLOB_TRACKER_TEST_CANVAS || !process.env.BLOB_TRACKER_TEST_FFMPEG,
  timeout: 60000
}, async () => {
  const {stdout} = await promisify(execFile)(process.execPath, ['tests/export-native.mjs'], {timeout:55000});
  assert.match(stdout, /All export integration checks passed/);
});
