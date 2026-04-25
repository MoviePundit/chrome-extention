const jobs = new Map();
const jobBuffers = new Map();
const HEADER_RULE_ID = 12001;

function newJobId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function log(job, msg) {
  job.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (job.logs.length > 600) job.logs.shift();
}

function setJobProgress(job, phase, total, completed, message) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed) || 0));
  const percent = safeTotal > 0 ? Math.round((safeCompleted / safeTotal) * 100) : 0;
  job.progress = {
    phase,
    total: safeTotal,
    completed: safeCompleted,
    percent,
    message: String(message || '')
  };
}

function isAbortError(err) {
  if (!err) return false;
  const name = String(err.name || '').toLowerCase();
  const msg = String(err.message || '').toLowerCase();
  return name === 'aborterror' || msg.includes('aborted');
}

function toInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function sanitizeFolderName(name) {
  const cleaned = String(name || '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'downloads';
}

function inferSeriesFolder(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean);
    if (parts.length === 0) return 'downloads';

    const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
    const grandParent = parts.length >= 3 ? parts[parts.length - 3] : '';

    if (/^\d{8,}$/.test(parent) && grandParent) return sanitizeFolderName(grandParent);
    if (parent) return sanitizeFolderName(parent);
  } catch (_) {
    // Ignore.
  }
  return 'downloads';
}

function inferOutputFile(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const name = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (name) return name;
  } catch (_) {
    // Ignore.
  }
  return 'audio.mp3';
}

function inferExtension(inputUrl) {
  try {
    const u = new URL(inputUrl);
    const base = decodeURIComponent(u.pathname.split('/').pop() || '');
    const match = base.match(/(\.[a-z0-9]{2,5})(?:$|\?)/i);
    if (match) return match[1];
  } catch (_) {
    // Ignore.
  }
  return '.mp3';
}

function inferExplicitFileName(item, index) {
  const title = sanitizeFolderName(item.title || '').replace(/_/g, ' ').trim();
  const prefix = String(index + 1).padStart(2, '0');
  const ext = inferExtension(item.url);
  if (title) return `${prefix} ${title}${ext}`;
  return `${prefix} ${inferOutputFile(item.url)}`;
}

function tokenizeCurlCommand(curlCommand) {
  const normalized = String(curlCommand || '').replace(/\\\r?\n/g, ' ').trim();
  const tokens = [];
  const re = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match;
  while ((match = re.exec(normalized)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function unescapeBashAnsiC(value) {
  return String(value || '')
    .replace(/\\'/g, "'")
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');
}

function parseCurlCommand(curlCommand) {
  const normalized = String(curlCommand || '').replace(/\\\r?\n/g, ' ').trim();
  const tokens = tokenizeCurlCommand(curlCommand);
  const headers = {};
  let url = null;

  const urlMatch = normalized.match(/https?:\/\/\S+/i);
  if (urlMatch) {
    url = unescapeBashAnsiC(urlMatch[0].replace(/["']+$/, ''));
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();

    if (lower === 'curl' || lower === 'curl.exe') continue;

    if (token === '-H' || token === '--header') {
      const headerLine = tokens[i + 1];
      if (headerLine && headerLine.includes(':')) {
        const idx = headerLine.indexOf(':');
        const key = headerLine.slice(0, idx).trim().toLowerCase();
        const value = unescapeBashAnsiC(headerLine.slice(idx + 1).trim());
        headers[key] = value;
      }
      i += 1;
      continue;
    }

    if (!url && (lower.startsWith('http://') || lower.startsWith('https://'))) {
      url = unescapeBashAnsiC(token);
    }
  }

  let rangeStart = null;
  if (headers.range) {
    const m = headers.range.match(/^bytes=(\d+)-$/i);
    if (m) rangeStart = Number(m[1]);
  }

  return {
    url,
    referer: headers.referer || null,
    userAgent: headers['user-agent'] || null,
    rangeStart
  };
}

function getSequencingMeta(inputUrl) {
  const u = new URL(inputUrl);
  const decodedPath = decodeURIComponent(u.pathname);
  const baseName = decodedPath.split('/').pop() || '';
  const dirName = decodedPath.split('/').slice(0, -1).join('/') || '/';
  const match = baseName.match(/(\d+)/);
  if (!match || match.index === undefined) return null;

  return {
    start: Number(match[1]),
    width: match[1].length,
    startIndex: match.index,
    endIndex: match.index + match[1].length,
    baseName,
    dirName
  };
}

function buildSequencedUrl(inputUrl, number) {
  const meta = getSequencingMeta(inputUrl);
  if (!meta) return inputUrl;

  const u = new URL(inputUrl);
  const padded = String(number).padStart(meta.width, '0');
  const newBase = `${meta.baseName.slice(0, meta.startIndex)}${padded}${meta.baseName.slice(meta.endIndex)}`;
  u.pathname = `${meta.dirName}/${newBase}`.replace(/\/+/g, '/');
  return u.toString();
}

function buildPlan(baseUrl, offset, count) {
  if (offset === 0 && count === 0) return [{ url: baseUrl, number: null }];
  const meta = getSequencingMeta(baseUrl);
  if (!meta) throw new Error('Sequential mode needs number in filename');

  const list = [];
  for (let i = 0; i <= count; i += 1) {
    const number = meta.start + offset + i;
    list.push({ url: buildSequencedUrl(baseUrl, number), number });
  }
  return list;
}

function normalizeConfig(payload) {
  const defaults = {
    referer: 'https://audiobooks4soul.com/',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'
  };

  const explicitLinks = Array.isArray(payload.playerLinks)
    ? payload.playerLinks
        .map((item, index) => {
          const url = String((item && item.url) || '').trim();
          if (!/^https?:\/\//i.test(url)) return null;
          return {
            url,
            title: String((item && item.title) || '').trim(),
            order: index + 1
          };
        })
        .filter(Boolean)
    : [];

  if (explicitLinks.length === 0) {
    throw new Error('Resolve player links first and keep at least one checked item.');
  }

  return {
    url: explicitLinks[0].url,
    referer: defaults.referer,
    userAgent: defaults.userAgent,
    rangeStart: null,
    offset: 0,
    count: 0,
    concurrency: Math.max(1, toInt(payload.concurrency, 2)),
    zipChunkMb: toInt(payload.zipChunkMb, 0),
    usePlayerLinksOnly: true,
    explicitLinks
  };
}

function buildExplicitPlan(items) {
  return items.map((item, index) => ({
    url: item.url,
    number: null,
    title: item.title,
    explicitFileName: inferExplicitFileName(item, index)
  }));
}

function updateSessionRulesPromise(payload) {
  return new Promise((resolve, reject) => {
    chrome.declarativeNetRequest.updateSessionRules(payload, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function applyHeaderRulesForHost(url, config) {
  const host = new URL(url).host;
  const requestHeaders = [];
  if (config.referer) {
    requestHeaders.push({ header: 'referer', operation: 'set', value: config.referer });
  }
  requestHeaders.push({ header: 'dnt', operation: 'set', value: '1' });
  if (config.rangeStart !== null && config.rangeStart !== undefined) {
    requestHeaders.push({ header: 'range', operation: 'set', value: `bytes=${config.rangeStart}-` });
  }

  await updateSessionRulesPromise({
    removeRuleIds: [HEADER_RULE_ID],
    addRules: [
      {
        id: HEADER_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders
        },
        condition: {
          requestDomains: [host],
          resourceTypes: ['xmlhttprequest', 'media', 'other', 'main_frame', 'sub_frame']
        }
      }
    ]
  });
}

async function clearHeaderRules() {
  await updateSessionRulesPromise({ removeRuleIds: [HEADER_RULE_ID], addRules: [] });
}

async function fetchBlob(url, config, signal) {
  const response = await fetch(url, {
    method: 'GET',
    headers: new Headers(),
    credentials: 'omit',
    signal
  });

  if (!response.ok && response.status !== 206) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status} ${text.slice(0, 180)}`);
  }

  return response.blob();
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function downloadBlob(blob, filename) {
  const buffer = await blob.arrayBuffer();
  const base64 = arrayBufferToBase64(buffer);
  const dataUrl = `data:${blob.type || 'application/octet-stream'};base64,${base64}`;

  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: false,
        conflictAction: 'uniquify'
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(downloadId);
      }
    );
  });
}

async function runPool(items, concurrency, worker, shouldStop) {
  const running = new Set();
  const results = [];

  for (const item of items) {
    if (typeof shouldStop === 'function' && shouldStop()) {
      break;
    }

    const p = worker(item)
      .then((value) => results.push({ ok: true, item, value }))
      .catch((error) => results.push({ ok: false, item, error }))
      .finally(() => running.delete(p));

    running.add(p);
    if (running.size >= concurrency) await Promise.race(running);
  }

  await Promise.all(running);
  return results;
}

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(bytes) {
  let c = 0 ^ -1;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

function utf8Encode(text) {
  return new TextEncoder().encode(text);
}

function writeUint16(arr, value) {
  arr.push(value & 0xff, (value >>> 8) & 0xff);
}

function writeUint32(arr, value) {
  arr.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8Encode(entry.name);
    const data = new Uint8Array(entry.data);
    const crc = crc32(data);

    const local = [];
    writeUint32(local, 0x04034b50);
    writeUint16(local, 20);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint16(local, 0);
    writeUint32(local, crc);
    writeUint32(local, data.length);
    writeUint32(local, data.length);
    writeUint16(local, nameBytes.length);
    writeUint16(local, 0);

    const localHeader = new Uint8Array(local);
    const localChunk = new Uint8Array(localHeader.length + nameBytes.length + data.length);
    localChunk.set(localHeader, 0);
    localChunk.set(nameBytes, localHeader.length);
    localChunk.set(data, localHeader.length + nameBytes.length);
    localParts.push(localChunk);

    const central = [];
    writeUint32(central, 0x02014b50);
    writeUint16(central, 20);
    writeUint16(central, 20);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, crc);
    writeUint32(central, data.length);
    writeUint32(central, data.length);
    writeUint16(central, nameBytes.length);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, 0);
    writeUint32(central, offset);

    const centralHeader = new Uint8Array(central);
    const centralChunk = new Uint8Array(centralHeader.length + nameBytes.length);
    centralChunk.set(centralHeader, 0);
    centralChunk.set(nameBytes, centralHeader.length);
    centralParts.push(centralChunk);

    offset += localChunk.length;
  }

  const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
  const end = [];
  writeUint32(end, 0x06054b50);
  writeUint16(end, 0);
  writeUint16(end, 0);
  writeUint16(end, entries.length);
  writeUint16(end, entries.length);
  writeUint32(end, centralSize);
  writeUint32(end, offset);
  writeUint16(end, 0);
  const endChunk = new Uint8Array(end);

  const total = offset + centralSize + endChunk.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(endChunk, pos);
  return out;
}

function splitEntriesByChunkSize(entries, chunkBytes) {
  const chunks = [];
  let current = [];
  let currentSize = 0;

  for (const entry of entries) {
    const size = entry.data.byteLength || 0;
    const estimated = size + 200;

    if (current.length > 0 && currentSize + estimated > chunkBytes) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }

    current.push(entry);
    currentSize += estimated;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function downloadChunkedZip(entries, baseName, chunkBytes, job) {
  const groups = splitEntriesByChunkSize(entries, chunkBytes);
  setJobProgress(job, 'zip', groups.length, 0, `Creating ZIP parts 0/${groups.length}`);
  const names = [];

  for (let i = 0; i < groups.length; i += 1) {
    if (job.cancelRequested) throw new Error('Aborted by user');
    const part = i + 1;
    const partName = `${baseName}.part${part}.zip`;
    const zipBytes = makeZip(groups[i]);
    if (job.cancelRequested) throw new Error('Aborted by user');
    const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
    await downloadBlob(zipBlob, partName);
    names.push(partName);
    log(job, `ZIP part ready: ${partName}`);
    setJobProgress(job, 'zip', groups.length, part, `Creating ZIP parts ${part}/${groups.length}`);
  }

  return names;
}

async function runJob(job) {
  try {
    const fetchConfig = { ...job.config, rangeStart: null };
    await applyHeaderRulesForHost(job.config.url, fetchConfig);
    const plan = buildExplicitPlan(job.config.explicitLinks);
    job.plan = plan;
    log(job, `Using ${plan.length} checked player link(s) from resolved playlist`);

    let completed = 0;
    setJobProgress(job, 'fetch', plan.length, 0, `Fetching 0/${plan.length}`);

    const results = await runPool(plan, job.config.concurrency, async (item) => {
      if (job.cancelRequested) {
        throw new Error('Aborted by user');
      }

      const fileName = item.explicitFileName || inferOutputFile(item.url);
      const series = inferSeriesFolder(item.url);
      const relativePath = `${series}/${fileName}`;
      log(job, `Start: ${relativePath}`);

      const controller = new AbortController();
      job.controllers.add(controller);
      try {
        const blob = await fetchBlob(item.url, fetchConfig, controller.signal);
        const data = await blob.arrayBuffer();
        const size = data.byteLength;
        const sizeMb = (size / (1024 * 1024)).toFixed(2);
        log(job, `Buffered: ${relativePath} (${sizeMb} MB)`);

        return { url: item.url, fileName, series, relativePath, data };
      } finally {
        job.controllers.delete(controller);
        completed += 1;
        setJobProgress(job, 'fetch', plan.length, completed, `Fetching ${completed}/${plan.length}`);
      }
    }, () => job.cancelRequested);

    if (job.cancelRequested) {
      throw new Error('Aborted by user');
    }

    const okItems = results.filter((r) => r.ok).map((r) => r.value);
    const failed = results.filter((r) => !r.ok);

    for (const f of failed) {
      log(job, `Failed: ${f.item.url}`);
      log(job, `Reason: ${f.error.message}`);
    }

    job.items = okItems.map(({ url, fileName, series, relativePath }) => ({
      url,
      fileName,
      series,
      relativePath
    }));
    jobBuffers.set(
      job.id,
      okItems.map(({ relativePath, data }) => ({ name: relativePath, data }))
    );

    job.summary = { total: results.length, ok: okItems.length, failed: failed.length };
    setJobProgress(job, 'fetch', plan.length, plan.length, `Fetch complete ${okItems.length}/${plan.length}`);
    job.status = failed.length > 0 ? 'failed' : 'completed';
    if (job.summary.ok > 0) {
      log(job, 'All files buffered. Click ZIP to download everything together.');
    }
  } catch (err) {
    if (job.cancelRequested || isAbortError(err)) {
      job.status = 'aborted';
      const total = job.progress ? job.progress.total : (job.plan ? job.plan.length : 0);
      const completed = job.progress ? job.progress.completed : 0;
      const ok = job.items ? job.items.length : 0;
      job.summary = { total, ok, failed: Math.max(0, completed - ok) };
      setJobProgress(job, 'fetch', total, completed, `Aborted ${completed}/${total}`);
      log(job, 'Aborted by user.');
    } else {
      job.status = 'failed';
      job.summary = { total: 0, ok: 0, failed: 1 };
      log(job, `Fatal: ${err.message}`);
    }
  } finally {
    try {
      await clearHeaderRules();
    } catch (_) {
      // Ignore cleanup issues.
    }
    job.finishedAt = new Date().toISOString();
  }
}

function startJob(payload) {
  const config = normalizeConfig(payload);
  const job = {
    id: newJobId(),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    summary: null,
    config,
    items: [],
    progress: { phase: 'fetch', total: 0, completed: 0, percent: 0, message: 'Queued' },
    cancelRequested: false,
    controllers: new Set()
  };

  jobs.set(job.id, job);
  runJob(job);
  return { id: job.id, status: job.status };
}

async function createZip(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found');
  if (job.status === 'running' || job.status === 'zipping') throw new Error('Job still running');
  if (job.status === 'aborted') throw new Error('Job was aborted');
  if (!job.items || job.items.length === 0) throw new Error('No files available for zip');
  const bufferedEntries = jobBuffers.get(jobId);
  if (!bufferedEntries || bufferedEntries.length === 0) {
    throw new Error('No buffered files found. Run the job again before ZIP download.');
  }

  const previousStatus = job.status;
  job.status = 'zipping';
  job.cancelRequested = false;
  log(job, 'Preparing ZIP...');
  try {
    const series = job.items[0]?.series || 'downloads';
    const baseName = `${sanitizeFolderName(series)}-${job.id}`;
    const chunkBytes = job.config.zipChunkMb > 0 ? job.config.zipChunkMb * 1024 * 1024 : 0;
    const totalBytes = bufferedEntries.reduce((sum, e) => sum + (e.data.byteLength || 0), 0);

    let fileNames = [];
    if (chunkBytes > 0 && totalBytes > chunkBytes) {
      log(job, `Using chunked ZIP mode (${job.config.zipChunkMb} MB parts)`);
      fileNames = await downloadChunkedZip(bufferedEntries, baseName, chunkBytes, job);
    } else {
      try {
        setJobProgress(job, 'zip', 1, 0, 'Creating ZIP 0/1');
        if (job.cancelRequested) throw new Error('Aborted by user');
        const zipBytes = makeZip(bufferedEntries);
        if (job.cancelRequested) throw new Error('Aborted by user');
        const zipBlob = new Blob([zipBytes], { type: 'application/zip' });
        const zipName = `${baseName}.zip`;
        await downloadBlob(zipBlob, zipName);
        fileNames = [zipName];
        log(job, `ZIP ready: ${zipName}`);
        setJobProgress(job, 'zip', 1, 1, 'Creating ZIP 1/1');
      } catch (err) {
        if (chunkBytes > 0) {
          log(job, `Single ZIP failed, fallback to chunked mode (${job.config.zipChunkMb} MB)`);
          fileNames = await downloadChunkedZip(bufferedEntries, baseName, chunkBytes, job);
        } else {
          throw err;
        }
      }
    }

    jobBuffers.delete(jobId);
    log(job, 'Buffered files cleared from memory.');
    job.status = previousStatus;
    const p = job.progress || { total: 1 };
    setJobProgress(job, 'zip', p.total || 1, p.total || 1, 'ZIP complete');
    if (fileNames.length === 1) {
      return { ok: true, fileName: fileNames[0], fileNames };
    }
    return { ok: true, fileName: fileNames[0], fileNames };
  } catch (err) {
    if (job.cancelRequested || isAbortError(err)) {
      job.status = 'aborted';
      const p = job.progress || { total: 0, completed: 0 };
      setJobProgress(job, 'zip', p.total, p.completed, `ZIP aborted ${p.completed}/${p.total}`);
      log(job, 'ZIP creation aborted by user.');
      throw new Error('ZIP aborted by user');
    }
    job.status = previousStatus;
    throw err;
  } finally {
    // No-op: no network re-fetch during zip creation.
  }
}

function abortJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found');
  if (job.status !== 'running' && job.status !== 'zipping') {
    return { id: job.id, status: job.status, message: 'No active task to abort' };
  }

  job.cancelRequested = true;
  for (const controller of job.controllers) {
    try {
      controller.abort();
    } catch (_) {
      // Ignore controller abort errors.
    }
  }

  log(job, 'Abort requested...');
  return { id: job.id, status: job.status, message: 'Abort requested' };
}

function clearMemory() {
  const active = Array.from(jobs.values()).filter((job) => job.status === 'running' || job.status === 'zipping');
  if (active.length > 0) {
    throw new Error('Cannot clear memory while processing. Abort first.');
  }

  const jobsCleared = jobs.size;
  const buffersCleared = jobBuffers.size;
  jobs.clear();
  jobBuffers.clear();
  return { jobsCleared, buffersCleared };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message && message.type === 'startJob') {
        const result = startJob(message.payload || {});
        sendResponse({ ok: true, result });
        return;
      }

      if (message && message.type === 'getJob') {
        const job = jobs.get(message.jobId);
        if (!job) throw new Error('Job not found');
        sendResponse({ ok: true, result: job });
        return;
      }

      if (message && message.type === 'zipJob') {
        const result = await createZip(message.jobId);
        sendResponse({ ok: true, result });
        return;
      }

      if (message && message.type === 'abortJob') {
        const result = abortJob(message.jobId);
        sendResponse({ ok: true, result });
        return;
      }

      if (message && message.type === 'clearMemory') {
        const result = clearMemory();
        sendResponse({ ok: true, result });
        return;
      }

      throw new Error('Unknown message');
    } catch (err) {
      sendResponse({ ok: false, error: err.message || 'Request failed' });
    }
  })();

  return true;
});
