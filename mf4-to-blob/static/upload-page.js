/**
 * The MF4 import page: pick files, claim them, upload them.
 *
 * Uploads take the path `/config` reports - browser -> Azure via a SAS URL, or
 * a streamed POST through the app. Each row carries its own Test Manager claim,
 * prefilled from that recording's own header (claim-editor.js).
 *
 * Rows are built ONCE and updated in place: render() runs on every progress
 * event, and rebuilding the list would eat a half-typed claim.
 */
import {
    applyToAll,
    buildClaimBlock,
    declaredQuery,
    initClaims,
    loadHeader,
    stampQuery,
} from '/static/claim-editor.js';

// @azure/storage-blob 12.31.0, pinned, served as ESM via jsDelivr's `+esm`
// transform (the package ships no UMD bundle any more). Imported *dynamically*,
// and only when /config reports upload_mode "sas": on an S3/S3Compatible
// workspace the SAS path is never taken, so the CDN is never contacted and a
// blocked CDN cannot break the page.
const AZURE_SDK_URL = "https://cdn.jsdelivr.net/npm/@azure/storage-blob@12.31.0/+esm";

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const sendBtn = document.getElementById('sendBtn');
const fileList = document.getElementById('fileList');
const summary = document.getElementById('summary');

let files = [];
let concurrency = 3;
let inFlight = 0;
let queue = [];
let uploading = false;
// "direct" (server-side streaming upload) works on every blob backend;
// "sas" is Azure-only. The server decides from the injected connection
// JSON - we just obey /config, and default to direct if the call fails
// because that is the path with no provider requirement.
let uploadMode = 'direct';

const configReady = fetch('/config')
    .then(r => (r.ok ? r.json() : null))
    .then(cfg => {
        if (!cfg) return;
        if (cfg.concurrency_hint) concurrency = cfg.concurrency_hint;
        if (cfg.upload_mode === 'sas' || cfg.upload_mode === 'direct') {
            uploadMode = cfg.upload_mode;
        }
    })
    .catch(() => {});

function fmtBytes(n) {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
}

function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
        ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        }));
}

function addFiles(picked) {
    const valid = Array.from(picked).filter(f => f.name.toLowerCase().endsWith('.mf4'));
    const skipped = picked.length - valid.length;
    for (const f of valid) {
        const entry = {
            id: uid(),
            file: f,
            status: 'pending',
            bytesSent: 0,
            percent: 0,
            error: null,
            uploadId: null,
            blobPath: null,
            parts: null,
        };
        initClaims(entry);
        files.push(entry);
        // The reads are independent - all in flight at once - and each resolves
        // on a later turn, by which time render() below has built its row.
        loadHeader(entry);
    }
    render();
    if (skipped > 0) {
        summary.textContent = `Skipped ${skipped} non-.mf4 file(s).`;
    }
}

function removeEntry(id) {
    const e = files.find(x => x.id === id);
    if (!e) return;
    if (e.status === 'uploading' || e.status === 'queued' || e.status === 'finalizing') return;
    files = files.filter(x => x.id !== id);
    render();
}

// render() runs on every progress event, several times a second per upload, so
// it builds a row once and afterwards only updates it: rebuilding the list
// would destroy a half-typed claim and its focus. Everything that moves while
// a file is in flight is in updateRow(); everything the operator can edit is
// repainted by the edit itself (claim-editor.js).
function render() {
    const live = new Set(files.map(e => e.id));
    for (const row of Array.from(fileList.children)) {
        if (!live.has(row.dataset.id)) row.remove();
    }
    for (const e of files) {
        if (!e.parts) fileList.appendChild(buildRow(e));
        updateRow(e);
    }

    const total = files.length;
    const done = files.filter(x => x.status === 'done').length;
    const errored = files.filter(x => x.status === 'error').length;
    if (total === 0) {
        summary.textContent = '';
    } else if (uploading || done + errored > 0) {
        summary.textContent = `${done} of ${total} complete` + (errored ? ` — ${errored} failed` : '');
    } else {
        summary.textContent = `${total} file(s) ready (${fmtBytes(files.reduce((a, x) => a + x.file.size, 0))})`;
    }

    sendBtn.disabled = uploading || files.filter(x => x.status === 'pending').length === 0;
    sendBtn.textContent = uploading ? 'Uploading...' : 'Upload selected files';
}

function buildRow(e) {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.dataset.id = e.id;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = e.file.name;
    const status = document.createElement('div');
    status.className = 'status';
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.title = 'Remove';
    remove.textContent = 'x';
    remove.onclick = () => removeEntry(e.id);
    meta.append(name, status, remove);

    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    bar.appendChild(fill);

    const err = document.createElement('div');
    err.className = 'err-msg';

    row.append(meta, buildClaimBlock(e, () => applyToAll(files, e)), bar, err);
    e.parts = { row, status, remove, fill, err };
    return row;
}

// The mutable bits, and nothing an operator can be in the middle of editing.
function updateRow(e) {
    const p = e.parts;
    p.row.className = 'file-row ' + (e.status === 'done' ? 'done' : e.status === 'error' ? 'error' : '');
    p.status.textContent = statusLabel(e);
    p.fill.style.width = (e.status === 'done' ? 100 : e.percent) + '%';
    p.remove.hidden = uploading && e.status !== 'pending';
    p.err.textContent = e.status === 'error' && e.error ? e.error : '';
}

function statusLabel(e) {
    switch (e.status) {
        case 'pending': return fmtBytes(e.file.size);
        case 'queued': return 'queued';
        case 'uploading': return `${e.percent}% — ${fmtBytes(e.bytesSent)} / ${fmtBytes(e.file.size)}`;
        case 'finalizing': return 'finalizing...';
        case 'done': return `done — ${fmtBytes(e.file.size)}`;
        case 'error': return 'failed';
        default: return '';
    }
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => {
    if (fileInput.files.length) addFiles(fileInput.files);
    fileInput.value = '';
});

sendBtn.addEventListener('click', () => {
    if (uploading) return;
    uploading = true;
    queue = files.filter(e => e.status === 'pending').slice();
    for (const e of queue) e.status = 'queued';
    render();
    pump();
});

function pump() {
    while (inFlight < concurrency && queue.length > 0) {
        const e = queue.shift();
        inFlight++;
        startUpload(e).finally(() => {
            inFlight--;
            if (queue.length === 0 && inFlight === 0) {
                uploading = false;
            }
            render();
            pump();
        });
    }
}

async function startUpload(e) {
    e.status = 'uploading';
    e.percent = 0;
    e.bytesSent = 0;
    render();

    await configReady;
    // The one branch that decides everything: Azure workspaces upload
    // browser -> Azure via SAS; every other backend streams through the
    // app with POST /upload/direct.
    if (uploadMode === 'sas') {
        return startSasUpload(e);
    }
    return startDirectUpload(e);
}

function startDirectUpload(e) {
    // XHR, not fetch: fetch has no upload-progress event and the
    // progress bar is the point of this page. The body is the File
    // itself - no multipart envelope - so the server can pipe it
    // straight into blob storage.
    return new Promise(resolve => {
        const xhr = new XMLHttpRequest();
        const url = '/upload/direct?filename=' + encodeURIComponent(e.file.name) +
            '&size=' + e.file.size + declaredQuery(e) + stampQuery(e);
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');

        xhr.upload.onprogress = ev => {
            e.bytesSent = ev.loaded;
            e.percent = e.file.size
                ? Math.min(99, Math.round(ev.loaded / e.file.size * 100))
                : 0;
            render();
        };
        xhr.upload.onload = () => {
            // Bytes are away; the server is still flushing the last
            // block and producing the metadata message.
            e.status = 'finalizing';
            render();
        };
        xhr.onload = () => {
            let body = null;
            try { body = JSON.parse(xhr.responseText); } catch (parseErr) { body = null; }
            if (xhr.status >= 200 && xhr.status < 300 && body && body.status === 'done') {
                e.uploadId = body.upload_id;
                e.blobPath = body.blob_path;
                e.status = 'done';
                e.percent = 100;
                e.bytesSent = e.file.size;
            } else {
                e.status = 'error';
                e.error = `direct: HTTP ${xhr.status}` +
                    (body && body.message ? ` ${body.message}` : '');
            }
            resolve();
        };
        xhr.onerror = () => {
            e.status = 'error';
            e.error = 'direct: network error';
            resolve();
        };
        xhr.onabort = () => {
            e.status = 'error';
            e.error = 'direct: aborted';
            resolve();
        };
        xhr.send(e.file);
    });
}

async function startSasUpload(e) {
    // Step 1: ask server for a SAS URL.
    let sasResp;
    try {
        // `replace` swaps only the FIRST "&" for a "?", which turns the
        // leading-& form into a query string and leaves the empty
        // case an untouched bare path.
        const query = (declaredQuery(e) + stampQuery(e)).replace('&', '?');
        const r = await fetch('/upload/sas' + query, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: e.file.name, size: e.file.size }),
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
            e.status = 'error';
            e.error = `sas: HTTP ${r.status}` + (body && body.message ? ` ${body.message}` : '');
            return;
        }
        sasResp = body;
    } catch (err) {
        e.status = 'error';
        e.error = `sas: ${err.message || err}`;
        return;
    }

    e.uploadId = sasResp.uploadId;
    e.blobPath = sasResp.blobPath;

    // Step 2: PUT directly to Azure via @azure/storage-blob.
    try {
        const { BlockBlobClient } = await import(AZURE_SDK_URL);
        const client = new BlockBlobClient(sasResp.sasUrl);
        await client.uploadData(e.file, {
            blockSize: 4 * 1024 * 1024,
            concurrency: 4,
            onProgress: ev => {
                e.bytesSent = ev.loadedBytes;
                e.percent = e.file.size
                    ? Math.min(99, Math.round(ev.loadedBytes / e.file.size * 100))
                    : 0;
                render();
            },
        });
    } catch (err) {
        e.status = 'error';
        e.error = `azure: ${err.message || err}`;
        return;
    }

    // Step 3: tell the server we're done so it can produce metadata.
    e.status = 'finalizing';
    render();
    try {
        const r = await fetch('/upload/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uploadId: e.uploadId,
                blobPath: e.blobPath,
                size: e.file.size,
            }),
        });
        const body = await r.json().catch(() => null);
        if (!(r.ok && body && body.status === 'done')) {
            e.status = 'error';
            e.error = `complete: HTTP ${r.status}` + (body && body.message ? ` ${body.message}` : '');
            return;
        }
        e.status = 'done';
        e.percent = 100;
        e.bytesSent = e.file.size;
    } catch (err) {
        e.status = 'error';
        e.error = `complete: ${err.message || err}`;
    }
}
