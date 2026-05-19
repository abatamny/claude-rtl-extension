/**
 * generate-icons.js
 *
 * Run this once with Node.js to produce the icon PNGs the manifest needs:
 *
 *   node generate-icons.js
 *
 * Requires the `canvas` package:
 *   npm install canvas
 */

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const SIZES = [16, 48, 128];
const OUT_DIR = path.join(__dirname, 'icons');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

SIZES.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background — purple gradient approximated as solid
  const r = size * 0.18;
  ctx.beginPath();
  ctx.roundRect(0, 0, size, size, r);
  ctx.fillStyle = '#7c3aed';
  ctx.fill();

  // Arabic letter ع as the icon glyph
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(size * 0.52)}px serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('ع', size / 2, size * 0.54);

  // Write PNG
  const out = path.join(OUT_DIR, `icon${size}.png`);
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(`✓ icons/icon${size}.png`);
});

console.log('\nIcons generated. Load the extension in Edge.');
