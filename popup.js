'use strict';

// ─── Dependency-free ZIP builder ──────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(entries) {
  // entries: [{ name: string, data: Uint8Array }]
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + filename)
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);  // signature
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // compression (stored = no compression)
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    locals.push(lh, data);

    // Central directory entry (46 bytes + filename)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);      // offset of local header
    cd.set(nameBytes, 46);
    centrals.push(cd);

    offset += 30 + nameBytes.length + size;
  }

  const cdStart = offset;
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);

  // End of central directory record
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);

  const all = [...locals, ...centrals, eocd];
  const total = all.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of all) { out.set(part, pos); pos += part.length; }
  return new Blob([out], { type: 'application/zip' });
}

// ─── State ────────────────────────────────────────────────────────────────────

// entry shape: { id, file, status: 'pending'|'converting'|'done'|'error', blob, origSize, webpSize, errorMsg }
const files = [];
let nextId = 0;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const dropZone        = document.getElementById('dropZone');
const fileInput       = document.getElementById('fileInput');
const selectBtn       = document.getElementById('selectBtn');
const fileListSection = document.getElementById('fileListSection');
const fileCountEl     = document.getElementById('fileCount');
const fileListEl      = document.getElementById('fileList');
const convertBtn      = document.getElementById('convertBtn');
const clearBtn        = document.getElementById('clearBtn');

// ─── File selection ───────────────────────────────────────────────────────────

selectBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

// ─── Drag & drop ─────────────────────────────────────────────────────────────

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

// ─── Add files ────────────────────────────────────────────────────────────────

function addFiles(fileList) {
  const IMAGE_RE = /^image\/(png|jpeg|gif|bmp|tiff|svg\+xml|webp|avif|x-ms-bmp)$/i;
  let added = 0;
  for (const file of fileList) {
    if (!IMAGE_RE.test(file.type) && !file.name.match(/\.(png|jpe?g|gif|bmp|tiff?|svg|webp|avif)$/i)) continue;
    files.push({ id: nextId++, file, status: 'pending', blob: null, origSize: file.size, webpSize: null, errorMsg: null });
    added++;
  }
  if (added) render();
}

// ─── Convert all ─────────────────────────────────────────────────────────────

convertBtn.addEventListener('click', async () => {
  const pending = files.filter(f => f.status === 'pending' || f.status === 'error');
  if (!pending.length) return;

  convertBtn.disabled = true;
  convertBtn.textContent = `Converting… (0/${pending.length})`;

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    convertBtn.textContent = `Converting… (${i + 1}/${pending.length})`;
    entry.status = 'converting';
    renderItem(entry);

    try {
      entry.blob = await convertToWebP(entry.file, 1.0);
      entry.webpSize = entry.blob.size;
      entry.status = 'done';
    } catch (err) {
      entry.status = 'error';
      entry.errorMsg = err.message || 'Conversion failed';
    }
    renderItem(entry);
  }

  updateHeader();

  const done = files.filter(f => f.status === 'done' && f.blob);
  if (done.length) await packageAndDownload(done);

  convertBtn.disabled = false;
  convertBtn.textContent = 'Convert & Download ZIP';
});

// ─── Core conversion (canvas → WebP) ─────────────────────────────────────────

function convertToWebP(file, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;

      const ctx = canvas.getContext('2d');
      // Preserve transparency for PNG/SVG; white-fill for JPEG to avoid compositing artefacts
      if (/^image\/(jpeg|jpg)$/i.test(file.type)) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0);

      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error('WebP encoding returned null — browser may not support it'));
      }, 'image/webp', quality);
    };

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
    img.src = url;
  });
}

// ─── Package & auto-download ZIP ─────────────────────────────────────────────

async function packageAndDownload(done) {
  convertBtn.textContent = '⏳ Packaging ZIP…';

  const entries = await Promise.all(done.map(async entry => ({
    name: withoutExt(entry.file.name) + '.webp',
    data: new Uint8Array(await entry.blob.arrayBuffer()),
  })));

  const zip = buildZip(entries);
  triggerDownload(zip, 'webp-images.zip');
}

// ─── Clear ────────────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  files.length = 0;
  fileListEl.innerHTML = '';
  fileListSection.hidden = true;
  convertBtn.disabled = false;
  convertBtn.textContent = 'Convert & Download ZIP';
});

// ─── Download helper ──────────────────────────────────────────────────────────

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  fileListSection.hidden = files.length === 0;
  updateHeader();
  fileListEl.innerHTML = '';
  for (const entry of files) {
    const li = document.createElement('li');
    li.id = `f${entry.id}`;
    li.className = 'file-item';
    fileListEl.appendChild(li);
    renderItem(entry);
  }
}

function renderItem(entry) {
  const li = document.getElementById(`f${entry.id}`);
  if (!li) return;

  li.className = `file-item ${entry.status}`;

  const icon = { pending: '○', converting: '⟳', done: '✓', error: '✗' }[entry.status];

  let sizeHTML = esc(fmt(entry.origSize));
  if (entry.status === 'done' && entry.webpSize != null) {
    const pct = ((entry.origSize - entry.webpSize) / entry.origSize * 100).toFixed(0);
    const smaller = entry.webpSize < entry.origSize;
    sizeHTML = `${esc(fmt(entry.origSize))} → ${esc(fmt(entry.webpSize))} <span class="${smaller ? 'savings-pos' : 'savings-neg'}">${smaller ? '↓' : '↑'}${Math.abs(pct)}%</span>`;
  }
  if (entry.status === 'error') {
    sizeHTML = `<span class="error-text">${esc(entry.errorMsg)}</span>`;
  }

  li.innerHTML = `
    <span class="file-status ${entry.status}">${icon}</span>
    <div class="file-info">
      <span class="file-name" title="${esc(entry.file.name)}">${esc(trunc(entry.file.name, 30))}</span>
      <span class="file-size">${sizeHTML}</span>
    </div>
  `;
}

function updateHeader() {
  const done = files.filter(f => f.status === 'done').length;
  fileCountEl.textContent = `${files.length} file${files.length !== 1 ? 's' : ''}${done ? ` · ${done} converted` : ''}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function trunc(str, max) {
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

function withoutExt(filename) {
  return filename.replace(/\.[^.]+$/, '');
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
