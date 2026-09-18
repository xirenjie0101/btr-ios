"use strict";
// Minimal top-level MP4 box scanner used by the mock server to derive the
// DASH SegmentBase ranges (Initialization + indexRange) of a test file.
const fs = require("fs");

function topLevelBoxes(file) {
  const fd = fs.openSync(file, "r");
  const size = fs.fstatSync(fd).size;
  const head = Buffer.alloc(16);
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= size) {
    fs.readSync(fd, head, 0, 16, offset);
    let boxSize = head.readUInt32BE(0);
    const type = head.toString("latin1", 4, 8);
    if (boxSize === 1) boxSize = Number(head.readBigUInt64BE(8));
    else if (boxSize === 0) boxSize = size - offset;
    if (boxSize < 8) break;
    boxes.push({ type, start: offset, end: offset + boxSize - 1, size: boxSize });
    offset += boxSize;
  }
  fs.closeSync(fd);
  return { boxes, size };
}

function segmentBase(file) {
  const { boxes, size } = topLevelBoxes(file);
  const sidx = boxes.find((box) => box.type === "sidx");
  if (!sidx) throw new Error(`no sidx in ${file}`);
  return {
    initialization: `0-${sidx.start - 1}`,
    indexRange: `${sidx.start}-${sidx.end}`,
    size,
    boxes
  };
}

module.exports = { segmentBase, topLevelBoxes };

if (require.main === module) {
  for (const file of process.argv.slice(2)) {
    const info = segmentBase(file);
    console.log(file, "size", info.size, "init", info.initialization, "index", info.indexRange);
    console.log("  boxes:", info.boxes.slice(0, 8).map((b) => `${b.type}@${b.start}+${b.size}`).join(" "), "… total", info.boxes.length);
  }
}
