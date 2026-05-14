'use strict';

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
      entry.blob = await convertToWebP(entry.file, 0.80);
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
  if (done.length) await downloadAll(done);

  convertBtn.disabled = false;
  convertBtn.textContent = 'Convert & Download';
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

// ─── Individual downloads ─────────────────────────────────────────────────────

async function downloadAll(done) {
  convertBtn.textContent = '⏳ Downloading…';
  for (let i = 0; i < done.length; i++) {
    triggerDownload(done[i].blob, withoutExt(done[i].file.name) + '.webp');
    if (i < done.length - 1) await new Promise(r => setTimeout(r, 300));
  }
}

// ─── Clear ────────────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  files.length = 0;
  fileListEl.innerHTML = '';
  fileListSection.hidden = true;
  convertBtn.disabled = false;
  convertBtn.textContent = 'Convert & Download';
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
