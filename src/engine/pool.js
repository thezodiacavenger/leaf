// Tiny worker pool for HEIC decoding. Size = cores - 1 (min 1, max 6) to keep the desktop responsive.
const { Worker } = require('node:worker_threads');
const os = require('node:os');
const path = require('node:path');

class DecodePool {
  constructor(size = Math.max(1, Math.min(6, os.cpus().length - 1))) {
    this.size = size; this.workers = []; this.idle = []; this.queue = []; this.pending = new Map(); this.seq = 0;
  }
  _spawn() {
    const w = new Worker(path.join(__dirname, 'heic-worker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep));
    w.on('message', (msg) => {
      const job = this.pending.get(msg.id); this.pending.delete(msg.id);
      msg.error ? job.reject(new Error(msg.error)) : job.resolve(msg);
      this.idle.push(w); this._pump();
    });
    w.on('error', (err) => {
      for (const [id, job] of this.pending) if (job.worker === w) { job.reject(err); this.pending.delete(id); }
      this.workers = this.workers.filter((x) => x !== w); this._pump();
    });
    this.workers.push(w); return w;
  }
  _pump() {
    while (this.queue.length) {
      const w = this.idle.pop() || (this.workers.length < this.size ? this._spawn() : null);
      if (!w) return;
      const job = this.queue.shift(); job.worker = w; this.pending.set(job.id, job);
      const ab = job.buffer.buffer.slice(job.buffer.byteOffset, job.buffer.byteOffset + job.buffer.byteLength);
      w.postMessage({ id: job.id, buffer: ab }, [ab]);
    }
  }
  decode(buffer) {
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.seq, buffer, resolve, reject }); this._pump(); });
  }
  destroy() { this.workers.forEach((w) => w.terminate()); this.workers = []; this.idle = []; }
}
module.exports = { DecodePool };
