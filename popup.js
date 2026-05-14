'use strict';

// Quality 0.75 = aggressive lossy WebP (TinyPNG-level compression)
const QUALITY = 0.75;

// ─── State ────────────────────────────────────────────────────────────────────
// entry: { id, file, status, blob, origSize, webpSize, errorMsg, thumb }
const files = [];
let nextId = 0;

// ─── DOM ──────────────────────────────────────────────────────────────────────
const dropZone    = document.getElementById('dropZone');
const fileInput   = document.getElementById('fileInput');
const selectBtn   = document.getElementById('selectBtn');
const workArea    = document.getElementById('workArea');
const statsBar    = document.getElementById('statsBar');
const statFiles   = document.getElementById('statFiles');
const statSaved   = document.getElementById('statSaved');
const statAvg     = document.getElementById('statAvg');
const fileListEl  = document.getElementById('fileList');
const convertBtn  = document.getElementById('convertBtn');
const btnLabel    = document.getElementById('btnLabel');
const clearBtn    = document.getElementById('clearBtn');

// ─── File input ───────────────────────────────────────────────────────────────
selectBtn.addEventListener('click', e => { e.stopPropagation(); fileInput.click(); });
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

// ─── Drag & drop ──────────────────────────────────────────────────────────────
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', e => {
  if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove('drag-over');
});
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  addFiles(e.dataTransfer.files);
});

// ─── Add files ────────────────────────────────────────────────────────────────
const IMAGE_RE = /^image\/(png|jpeg|gif|bmp|tiff|svg\+xml|webp|avif|x-ms-bmp)$/i;
const EXT_RE   = /\.(png|jpe?g|gif|bmp|tiff?|svg|webp|avif)$/i;

async function addFiles(list) {
  let added = false;
  for (const file of list) {
    if (!IMAGE_RE.test(file.type) && !EXT_RE.test(file.name)) continue;
    const entry = {
      id: nextId++, file,
      status: 'pending', blob: null,
      origSize: file.size, webpSize: null,
      errorMsg: null, thumb: null,
    };
    files.push(entry);
    appendCard(entry);
    added = true;

    // Load thumbnail asynchronously — update card when ready
    generateThumb(file).then(thumb => {
      entry.thumb = thumb;
      const el = document.getElementById(`c${entry.id}`);
      if (el && thumb) el.querySelector('.file-thumb').innerHTML = `<img src="${thumb}" alt="">`;
    });
  }
  if (added) workArea.hidden = false;
}

// ─── Thumbnail ────────────────────────────────────────────────────────────────
function generateThumb(file) {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const S = 44, r = Math.min(S / img.naturalWidth, S / img.naturalHeight);
      const c = document.createElement('canvas');
      c.width  = Math.round(img.naturalWidth  * r);
      c.height = Math.round(img.naturalHeight * r);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ─── Compress ─────────────────────────────────────────────────────────────────
convertBtn.addEventListener('click', async () => {
  const pending = files.filter(f => f.status === 'pending' || f.status === 'error');
  if (!pending.length) return;

  convertBtn.disabled = true;

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    btnLabel.textContent = `Compressing… (${i + 1} of ${pending.length})`;
    entry.status = 'converting';
    updateCard(entry);

    try {
      entry.blob    = await compress(entry.file);
      entry.webpSize = entry.blob.size;
      entry.status  = 'done';
    } catch (err) {
      entry.status   = 'error';
      entry.errorMsg = err.message || 'Failed';
    }
    updateCard(entry);
  }

  updateStats();

  const done = files.filter(f => f.status === 'done' && f.blob);
  if (done.length) await downloadAll(done);

  btnLabel.textContent = 'Compress & Download All';
  convertBtn.disabled = false;
});

// ─── Core WebP compression ────────────────────────────────────────────────────
function compress(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // White fill for JPEG (no alpha channel) to prevent dark compositing edges
      if (/^image\/jpeg/i.test(file.type)) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        blob ? resolve(blob) : reject(new Error('WebP encoding failed'));
      }, 'image/webp', QUALITY);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

// ─── Download individual files ─────────────────────────────────────────────────
async function downloadAll(done) {
  btnLabel.textContent = 'Downloading…';
  for (let i = 0; i < done.length; i++) {
    const url = URL.createObjectURL(done[i].blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = stripExt(done[i].file.name) + '.webp';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    if (i < done.length - 1) await pause(350);
  }
}

// ─── Clear ────────────────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  files.length = 0;
  fileListEl.innerHTML = '';
  workArea.hidden = true;
  statsBar.hidden = true;
  convertBtn.disabled = false;
  btnLabel.textContent = 'Compress & Download All';
});

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const done = files.filter(f => f.status === 'done');
  if (!done.length) return;

  const totalOrig = done.reduce((s, f) => s + f.origSize, 0);
  const totalWebP = done.reduce((s, f) => s + f.webpSize, 0);
  const saved     = totalOrig - totalWebP;
  const avgPct    = ((saved / totalOrig) * 100).toFixed(0);

  statFiles.textContent = files.length;
  statSaved.textContent = fmt(saved);
  statAvg.textContent   = `${avgPct}%`;
  statsBar.hidden = false;
}

// ─── Card rendering ───────────────────────────────────────────────────────────
function appendCard(entry) {
  const li = document.createElement('li');
  li.id = `c${entry.id}`;
  li.className = 'file-card';
  fileListEl.appendChild(li);
  renderCard(li, entry);
}

function updateCard(entry) {
  const li = document.getElementById(`c${entry.id}`);
  if (li) renderCard(li, entry);
}

function renderCard(li, entry) {
  li.className = `file-card ${entry.status}`;

  const icon = { pending: '○', converting: '⟳', done: '✓', error: '✗' }[entry.status];

  const thumbHTML = entry.thumb
    ? `<img src="${entry.thumb}" alt="">`
    : '🖼';

  let metaHTML = esc(fmt(entry.origSize));
  let barHTML  = `<div class="bar-track"><div class="bar-fill" style="width:0"></div></div>`;

  if (entry.status === 'converting') {
    barHTML = `<div class="bar-track"><div class="bar-fill converting"></div></div>`;

  } else if (entry.status === 'done' && entry.webpSize != null) {
    const saved   = entry.origSize - entry.webpSize;
    const pct     = (saved / entry.origSize * 100).toFixed(0);
    const smaller = entry.webpSize < entry.origSize;
    const sign    = smaller ? '↓' : '↑';
    const cls     = smaller ? 'savings-pos' : 'savings-neg';
    metaHTML = `${esc(fmt(entry.origSize))} → <strong>${esc(fmt(entry.webpSize))}</strong> <span class="${cls}">${sign}${Math.abs(pct)}%</span>`;
    barHTML  = `<div class="bar-track"><div class="bar-fill saved" style="width:${smaller ? pct : 0}%"></div></div>`;

  } else if (entry.status === 'error') {
    metaHTML = `<span class="error-text">${esc(entry.errorMsg)}</span>`;
    barHTML  = '';
  }

  li.innerHTML = `
    <div class="file-thumb">${thumbHTML}</div>
    <div class="file-body">
      <div class="file-name" title="${esc(entry.file.name)}">${esc(trunc(entry.file.name, 34))}</div>
      <div class="file-meta">${metaHTML}</div>
      ${barHTML}
    </div>
    <span class="status-icon ${entry.status}">${icon}</span>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(b) {
  if (b < 1024)        return `${b} B`;
  if (b < 1_048_576)   return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1_048_576).toFixed(2)} MB`;
}
function trunc(s, n)  { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function stripExt(s)  { return s.replace(/\.[^.]+$/, ''); }
function pause(ms)    { return new Promise(r => setTimeout(r, ms)); }
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
