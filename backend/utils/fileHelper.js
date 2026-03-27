const fs = require('fs');
const os = require('os');
const path = require('path');

// Write a buffer to a temp file so Playwright can upload it
// Returns the temp file path
async function writeFileTemp(buffer, originalname) {
  const ext = path.extname(originalname) || '.bin';
  const tmpPath = path.join(os.tmpdir(), `gst_upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  await fs.promises.writeFile(tmpPath, buffer);
  return tmpPath;
}

// Delete temp files after use
function cleanupTemp(filePaths) {
  for (const p of filePaths) {
    fs.unlink(p, (err) => {
      if (err) console.warn('Could not delete temp file:', p);
    });
  }
}

module.exports = { writeFileTemp, cleanupTemp };
