/** 从正式 Logo 母版导出扩展所需尺寸，保留透明度，无第三方依赖。 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const directory = path.join(__dirname, '..', 'assets');

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function chunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, checksum]);
}
function encode(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(scanlines, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function paeth(left, above, corner) {
  const p = left + above - corner;
  const a = Math.abs(p - left); const b = Math.abs(p - above); const c = Math.abs(p - corner);
  return a <= b && a <= c ? left : b <= c ? above : corner;
}
function decode(file) {
  if (!file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Logo 母版必须为 PNG');
  let width, height, color, palette, alpha; const compressed = [];
  for (let offset = 8; offset < file.length;) {
    const size = file.readUInt32BE(offset); const type = file.toString('ascii', offset + 4, offset + 8);
    const data = file.subarray(offset + 8, offset + 8 + size);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); color = data[9];
      if (data[8] !== 8 || data[10] || data[11] || data[12]) throw new Error('母版需要 8 位、非交错 PNG');
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alpha = data;
    offset += size + 12;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  if (!channels || width !== height || width < 128) throw new Error('母版需要至少 128px 的正方形图像');
  const stride = width * channels; const raw = zlib.inflateSync(Buffer.concat(compressed));
  if (raw.length !== (stride + 1) * height) throw new Error('母版像素数据不完整');
  const decoded = Buffer.alloc(stride * height); const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error('不支持的 PNG 行过滤器');
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x; const left = x >= channels ? decoded[i - channels] : 0;
      const above = y ? decoded[i - stride] : 0; const corner = y && x >= channels ? decoded[i - stride - channels] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, corner)][filter];
      decoded[i] = (raw[y * (stride + 1) + x + 1] + predictor) & 255;
    }
  }
  for (let i = 0; i < width * height; i++) {
    const from = i * channels; const to = i * 4;
    if (color === 3) {
      const index = decoded[from];
      if (!palette) throw new Error('母版缺少调色板');
      pixels[to] = palette[index * 3]; pixels[to + 1] = palette[index * 3 + 1]; pixels[to + 2] = palette[index * 3 + 2]; pixels[to + 3] = alpha && index < alpha.length ? alpha[index] : 255;
    } else if (color === 0 || color === 4) {
      pixels[to] = pixels[to + 1] = pixels[to + 2] = decoded[from]; pixels[to + 3] = color === 4 ? decoded[from + 1] : 255;
    } else {
      decoded.copy(pixels, to, from, from + 3); pixels[to + 3] = color === 6 ? decoded[from + 3] : 255;
    }
  }
  return { width, pixels };
}
/** 面积加权缩小，先乘透明度，避免透明边缘出现黑边。 */
function resize(source, size) {
  const out = Buffer.alloc(size * size * 4); const scale = source.width / size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const left = x * scale, top = y * scale, right = (x + 1) * scale, bottom = (y + 1) * scale;
    let red = 0, green = 0, blue = 0, alpha = 0, total = 0;
    for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++) for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
      const weight = (Math.min(right, sx + 1) - Math.max(left, sx)) * (Math.min(bottom, sy + 1) - Math.max(top, sy));
      const i = (sy * source.width + sx) * 4; const a = source.pixels[i + 3] / 255 * weight;
      red += source.pixels[i] * a; green += source.pixels[i + 1] * a; blue += source.pixels[i + 2] * a; alpha += a; total += weight;
    }
    const i = (y * size + x) * 4;
    if (alpha) { out[i] = Math.round(red / alpha); out[i + 1] = Math.round(green / alpha); out[i + 2] = Math.round(blue / alpha); }
    out[i + 3] = Math.round(alpha / total * 255);
  }
  return out;
}
const source = decode(fs.readFileSync(path.join(directory, 'logo.png')));
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(directory, `icon${size}.png`), encode(size, resize(source, size)));
  console.log(`已导出 ${size} × ${size} 图标`);
}
