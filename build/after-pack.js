// Drops Chromium's WebGPU shader compiler (dxcompiler/dxil, ~26 MB). Leaf never uses WebGPU;
// Chromium falls back to d3dcompiler_47.dll for everything it does use.
const fs = require('fs');
const path = require('path');
exports.default = async ({ appOutDir, electronPlatformName }) => {
  if (electronPlatformName !== 'win32') return;
  for (const f of ['dxcompiler.dll', 'dxil.dll']) fs.rmSync(path.join(appOutDir, f), { force: true });
};
