// Decodes HEIC/HEIF in a worker thread so the main process stays responsive.
// Output is BGRA (the byte order Electron's nativeImage.createFromBitmap expects).
const { parentPort } = require('node:worker_threads');
const decode = require('heic-decode');

parentPort.on('message', async ({ id, buffer }) => {
  try {
    const { width, height, data } = await decode({ buffer: Buffer.from(buffer) });
    const px = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (let i = 0; i < px.length; i += 4) { const r = px[i]; px[i] = px[i + 2]; px[i + 2] = r; }
    const out = px.buffer.slice(px.byteOffset, px.byteOffset + px.byteLength);
    parentPort.postMessage({ id, width, height, data: out }, [out]);
  } catch (err) {
    parentPort.postMessage({ id, error: String(err && err.message || err) });
  }
});
