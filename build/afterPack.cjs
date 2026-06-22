const fs = require('node:fs');
const path = require('node:path');

// Trims the packaged Electron runtime to shrink the installer. All of this is safe for the target
// audience (League players on normal Windows GPUs); the trade-offs are noted inline.
module.exports = async function afterPack(context) {
  const out = context.appOutDir;
  const removed = [];

  const rm = (rel) => {
    const p = path.join(out, rel);
    try {
      const bytes = fs.statSync(p).size;
      fs.rmSync(p, { force: true, recursive: true });
      removed.push([rel, bytes]);
    } catch {
      // not present on this Electron version — ignore
    }
  };

  // 1) Keep only the en-US locale (~40 MB of other languages). The app's UI is English-only.
  const localesDir = path.join(out, 'locales');
  if (fs.existsSync(localesDir)) {
    for (const file of fs.readdirSync(localesDir)) {
      if (file !== 'en-US.pak') rm(path.join('locales', file));
    }
  }

  // 2) Drop the SwiftShader software-GPU fallback. Only matters on machines with no working GPU
  //    driver — not a concern for League players. (Hardware GPU rendering still works.)
  rm('vk_swiftshader.dll');
  rm('vk_swiftshader_icd.json');
  rm('vulkan-1.dll');

  // 3) Drop the bulky Chromium license-aggregation HTML (not needed at runtime).
  rm('LICENSES.chromium.html');

  const total = removed.reduce((sum, [, bytes]) => sum + bytes, 0);
  console.log(`  • afterPack: removed ${removed.length} files, ${(total / 1048576).toFixed(1)} MB from the runtime`);
};
