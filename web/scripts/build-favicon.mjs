// Rasterize src/app/icon.svg into a multi-size favicon.ico + apple-icon.png.
// Run from web/:  node scripts/build-favicon.mjs
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = join(root, 'src/app/icon.svg');
const appDir = join(root, 'src/app');

const svg = await readFile(svgPath);

// PNG frames for the .ico container (ICO can embed PNG payloads directly).
const icoSizes = [16, 32, 48];
const pngs = await Promise.all(
  icoSizes.map((s) =>
    sharp(svg, { density: 384 }).resize(s, s, { fit: 'contain' }).png().toBuffer()
  )
);

// --- Build ICO container ---------------------------------------------------
function buildIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const body = [];
  images.forEach((img, i) => {
    const b = dir.subarray(i * 16);
    b.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width
    b.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
    b.writeUInt8(0, 2); // palette
    b.writeUInt8(0, 3); // reserved
    b.writeUInt16LE(1, 4); // color planes
    b.writeUInt16LE(32, 6); // bpp
    b.writeUInt32LE(img.data.length, 8); // size of image data
    b.writeUInt32LE(offset, 12); // offset
    offset += img.data.length;
    body.push(img.data);
  });
  return Buffer.concat([header, dir, ...body]);
}

const ico = buildIco(pngs.map((data, i) => ({ size: icoSizes[i], data })));
await writeFile(join(appDir, 'favicon.ico'), ico);

// --- apple-icon (180) + plain PNGs for preview ----------------------------
await sharp(svg, { density: 384 }).resize(180, 180).png().toFile(join(appDir, 'apple-icon.png'));

// preview montage so we can eyeball small-size legibility
await Promise.all(
  [16, 32, 48, 64].map((s) =>
    sharp(svg, { density: 384 }).resize(s, s).png().toFile(join(root, `scripts/_fav_${s}.png`))
  )
);

// Chrome extension icons (Suno Bridge) — same artwork, sizes MV3 wants. Re-pack with suno-bridge/pack.sh after.
const extDir = join(root, '../suno-bridge/icons');
await Promise.all(
  [16, 32, 48, 128].map((s) =>
    sharp(svg, { density: 384 }).resize(s, s, { fit: 'contain' }).png().toFile(join(extDir, `icon-${s}.png`))
  )
);

console.log('favicon.ico (16/32/48), apple-icon.png (180) written to src/app/');
console.log('extension icons (16/32/48/128) written to suno-bridge/icons/');
