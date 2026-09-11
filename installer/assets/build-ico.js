// Builds a multi-resolution .ico from PNG files, storing each as a
// PNG-format ICO directory entry (supported by modern Windows for any
// listed size, not just 256 -- fine for our Windows Server 2019+ target).
const fs = require('fs');
const path = require('path');

const rawDir = path.join(__dirname, '_raw');
const sizes = [16, 32, 48, 256];
const entries = sizes.map((s) => ({
  size: s,
  data: fs.readFileSync(path.join(rawDir, `icon${s}.png`)),
}));

const HEADER_SIZE = 6;
const DIR_ENTRY_SIZE = 16;
let offset = HEADER_SIZE + entries.length * DIR_ENTRY_SIZE;

const header = Buffer.alloc(HEADER_SIZE);
header.writeUInt16LE(0, 0);            // reserved
header.writeUInt16LE(1, 2);            // type: 1 = icon
header.writeUInt16LE(entries.length, 4);

const dirEntries = [];
for (const e of entries) {
  const d = Buffer.alloc(DIR_ENTRY_SIZE);
  d.writeUInt8(e.size === 256 ? 0 : e.size, 0);  // width (0 means 256)
  d.writeUInt8(e.size === 256 ? 0 : e.size, 1);  // height
  d.writeUInt8(0, 2);                             // color count
  d.writeUInt8(0, 3);                             // reserved
  d.writeUInt16LE(1, 4);                          // planes
  d.writeUInt16LE(32, 6);                         // bit count
  d.writeUInt32LE(e.data.length, 8);              // size of image data
  d.writeUInt32LE(offset, 12);                    // offset
  offset += e.data.length;
  dirEntries.push(d);
}

const out = Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.data)]);
const outPath = path.join(__dirname, 'icon.ico');
fs.writeFileSync(outPath, out);
console.log('Wrote', outPath, '(' + out.length + ' bytes,', sizes.join('/'), 'px)');
