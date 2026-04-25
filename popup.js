const $ = (id) => document.getElementById(id);

const fields = {
  concurrency: $('concurrency'),
  zipChunkMb: $('zipChunkMb')
};

const startBtn = $('startBtn');
const zipBtn = $('zipBtn');
const abortBtn = $('abortBtn');
const clearMemoryBtn = $('clearMemoryBtn');
const resolvePlaylistBtn = $('resolvePlaylistBtn');
const selectAllPlayerLinksBtn = $('selectAllPlayerLinksBtn');
const selectNonePlayerLinksBtn = $('selectNonePlayerLinksBtn');
const playerLinksList = $('playerLinksList');
const statusEl = $('status');
const logEl = $('log');
const progressBar = $('progressBar');
const progressLabel = $('progressLabel');

let pollTimer = null;
let currentJobId = null;
let resolvedPlayerLinks = [];
let discoveryRunning = false;
let discoveryPollTimer = null;
let discoveryTabId = null;
let isJobProcessing = false;
let zipAvailable = false;

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', Boolean(isError));
}

function setLog(lines) {
  logEl.textContent = lines;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(percent, label) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  progressBar.value = safePercent;
  progressLabel.textContent = label || 'Idle';
}

function setAbortEnabled(enabled) {
  abortBtn.disabled = !enabled;
}

function syncControlStates() {
  const busy = Boolean(discoveryRunning || isJobProcessing);
  resolvePlaylistBtn.disabled = busy;
  startBtn.disabled = busy;
  zipBtn.disabled = busy || !zipAvailable;
  selectAllPlayerLinksBtn.disabled = busy;
  selectNonePlayerLinksBtn.disabled = busy;
  clearMemoryBtn.disabled = busy;
  fields.concurrency.disabled = busy;
  fields.zipChunkMb.disabled = busy;
  abortBtn.disabled = !busy;
}

function stopDiscoveryPolling() {
  if (discoveryPollTimer) {
    clearInterval(discoveryPollTimer);
    discoveryPollTimer = null;
  }
  discoveryTabId = null;
}

function startDiscoveryPolling(tabId) {
  stopDiscoveryPolling();
  discoveryTabId = tabId;
  discoveryPollTimer = setInterval(async () => {
    if (!discoveryRunning || !discoveryTabId) {
      stopDiscoveryPolling();
      return;
    }
    try {
      const snap = await chrome.scripting.executeScript({
        target: { tabId: discoveryTabId },
        func: () => globalThis.__aacDiscoveryProgress || null
      });
      const progress = snap && snap[0] && snap[0].result;
      if (!progress) return;
      const pct = progress.percent ?? 0;
      const msg = progress.message || `Discovery ${pct}%`;
      setProgress(pct, msg);
    } catch (_) {
      // Ignore polling errors while discovery is running.
    }
  }, 300);
}

function setResolvedPlayerLinks(items) {
  resolvedPlayerLinks = Array.isArray(items) ? items.filter((item) => item && item.url) : [];
  playerLinksList.innerHTML = '';

  if (resolvedPlayerLinks.length === 0) {
    playerLinksList.classList.add('empty');
    playerLinksList.textContent = 'No player links discovered yet';
    return;
  }

  playerLinksList.classList.remove('empty');
  resolvedPlayerLinks.forEach((item, index) => {
    const row = document.createElement('label');
    row.className = 'checkItem';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.index = String(index);

    const body = document.createElement('div');
    body.className = 'checkItemBody';

    const title = document.createElement('div');
    title.className = 'checkItemTitle';
    title.textContent = item.title || `Track ${index + 1}`;

    const url = document.createElement('div');
    url.className = 'checkItemUrl';
    url.textContent = item.url;

    body.appendChild(title);
    body.appendChild(url);
    row.appendChild(checkbox);
    row.appendChild(body);
    playerLinksList.appendChild(row);
  });
}

function getSelectedPlayerLinks() {
  const selectedIndexes = Array.from(playerLinksList.querySelectorAll('input[type="checkbox"]:checked'))
    .map((el) => Number(el.dataset.index))
    .filter((index) => Number.isInteger(index) && index >= 0);

  return selectedIndexes
    .map((index) => resolvedPlayerLinks[index])
    .filter((item) => item && item.url);
}

function setAllPlayerLinkSelections(checked) {
  const boxes = Array.from(playerLinksList.querySelectorAll('input[type="checkbox"]'));
  if (boxes.length === 0) {
    setStatus('No discovered player links available.', true);
    return;
  }

  for (const box of boxes) {
    box.checked = checked;
  }

  setStatus(checked ? `Selected ${boxes.length} player link(s).` : 'Cleared all player link selections.');
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    throw new Error('No active tab found');
  }
  return tabs[0];
}

function getPayload() {
  const selectedPlayerLinks = getSelectedPlayerLinks();
  if (selectedPlayerLinks.length === 0) {
    throw new Error('Resolve playlist links and keep at least one checked item before starting.');
  }

  return {
    concurrency: fields.concurrency.value,
    zipChunkMb: fields.zipChunkMb.value,
    playerLinks: selectedPlayerLinks
  };
}

async function pollJob(jobId) {
  if (pollTimer) clearInterval(pollTimer);
  isJobProcessing = true;
  syncControlStates();

  pollTimer = setInterval(async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'getJob', jobId });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Failed to get job');
      }
      const job = response.result;

      setLog((job.logs || []).join('\n') || 'No logs yet...');

      if (job.progress) {
        setProgress(job.progress.percent || 0, job.progress.message || 'Processing...');
      }

      if (job.status !== 'running' && job.status !== 'zipping') {
        clearInterval(pollTimer);
        pollTimer = null;
        isJobProcessing = false;

        const s = job.summary || { total: 0, ok: 0, failed: 0 };
        setStatus(`Job ${job.status}. total=${s.total} ok=${s.ok} failed=${s.failed}`, job.status === 'failed' || job.status === 'aborted');
        zipAvailable = s.ok > 0 && job.status !== 'zipping';
        syncControlStates();
      }
    } catch (err) {
      clearInterval(pollTimer);
      pollTimer = null;
      isJobProcessing = false;
      syncControlStates();
      setStatus(`Polling failed: ${err.message}`, true);
    }
  }, 1000);
}

startBtn.addEventListener('click', async () => {
  try {
    zipAvailable = false;
    isJobProcessing = true;
    syncControlStates();
    setProgress(0, 'Preparing fetch...');
    setStatus('Starting...');

    const response = await chrome.runtime.sendMessage({
      type: 'startJob',
      payload: getPayload()
    });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Start failed');
    }
    const data = response.result;

    currentJobId = data.id;
    setStatus(`Job ${data.id} running...`);
    setLog(`Job ${data.id} started`);
    pollJob(data.id);
  } catch (err) {
    isJobProcessing = false;
    syncControlStates();
    setProgress(0, 'Idle');
    setStatus(err.message, true);
  }
});

zipBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  try {
    isJobProcessing = true;
    syncControlStates();
    setProgress(0, 'Preparing ZIP...');
    setStatus('Creating ZIP...');
    pollJob(currentJobId);
    const response = await chrome.runtime.sendMessage({ type: 'zipJob', jobId: currentJobId });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'ZIP failed');
    }
    if (response.result.fileNames && response.result.fileNames.length > 1) {
      setStatus(`ZIP parts downloaded: ${response.result.fileNames.length}`);
    } else {
      setStatus(`ZIP downloaded: ${response.result.fileName}`);
    }
    zipAvailable = false;
    isJobProcessing = false;
    setProgress(100, 'ZIP complete');
    syncControlStates();
    pollJob(currentJobId);
  } catch (err) {
    isJobProcessing = false;
    syncControlStates();
    setStatus(err.message, true);
  }
});

resolvePlaylistBtn.addEventListener('click', async () => {
  try {
    if (discoveryRunning) {
      throw new Error('Discovery is already running. Abort or wait for completion.');
    }

    const tab = await getActiveTab();
    if (!tab.id) throw new Error('Current tab is not scriptable');

    discoveryRunning = true;
    syncControlStates();
    setProgress(0, 'Starting discovery...');
    startDiscoveryPolling(tab.id);

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const isLikelyAudioUrl = (value) => {
          const url = String(value || '');
          if (!/^https?:\/\//i.test(url)) return false;
          return /\.(mp3|m4a|m4b|aac|ogg|wav|flac|opus)(\?|$)/i.test(url)
            || /\/audio\//i.test(url)
            || /[?&](format|type)=audio/i.test(url);
        };

        const getAudioUrl = () => {
          const sourceEl = document.querySelector('#audio source[src]');
          const audioEl = document.querySelector('#audio');
          const src =
            (sourceEl && sourceEl.getAttribute('src')) ||
            (audioEl && audioEl.currentSrc) ||
            (audioEl && audioEl.getAttribute('src')) ||
            '';

          if (!src) return '';
          if (/^https?:\/\//i.test(src)) return src;
          try {
            return new URL(src, location.href).toString();
          } catch (_) {
            return '';
          }
        };

        const clickNode = (node) => {
          node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        };

        const waitForAudioChange = async (previous, maxWaitMs) => {
          const start = Date.now();
          while (Date.now() - start < maxWaitMs) {
            const current = getAudioUrl();
            if (current && current !== previous) return current;
            await sleep(200);
          }
          return getAudioUrl();
        };

        let items = Array.from(document.querySelectorAll('#simp .simp-playlist .simp-source, .simp-playlist .simp-source, span.simp-source[data-src]'));
        if (items.length === 0) {
          return { error: 'No .simp-source items found on page', urls: [] };
        }

        globalThis.__aacDiscoveryAbort = false;
        globalThis.__aacDiscoveryProgress = {
          phase: 'discovery',
          total: items.length,
          completed: 0,
          percent: 0,
          message: `Discovery 0/${items.length}`
        };

        const out = [];
        const seen = new Set();
        let previousAudio = getAudioUrl();

        for (let idx = 0; idx < items.length; idx += 1) {
          const item = items[idx];
          const title = (item.textContent || '').trim();
          const raw = item.getAttribute('data-src') || '';
          let resolved = '';

          if (globalThis.__aacDiscoveryAbort) {
            globalThis.__aacDiscoveryProgress = {
              phase: 'discovery',
              total: items.length,
              completed: idx,
              percent: Math.round((idx / Math.max(1, items.length)) * 100),
              message: `Discovery aborted at ${idx}/${items.length}`
            };
            return { aborted: true, urls: out, totalItems: items.length };
          }

          if (/^https?:\/\//i.test(raw)) {
            resolved = raw;
          } else {
            const li = item.closest('li');
            clickNode(item);
            if (li) clickNode(li);
            await sleep(250);
            resolved = await waitForAudioChange(previousAudio, 4500);
          }

          if (/^https?:\/\//i.test(resolved) && !seen.has(resolved) && isLikelyAudioUrl(resolved)) {
            seen.add(resolved);
            out.push({ title, url: resolved });
          }

          if (resolved) {
            previousAudio = resolved;
          }

          const completed = idx + 1;
          globalThis.__aacDiscoveryProgress = {
            phase: 'discovery',
            total: items.length,
            completed,
            percent: Math.round((completed / Math.max(1, items.length)) * 100),
            message: `Discovery ${completed}/${items.length}`
          };
        }

        globalThis.__aacDiscoveryProgress = {
          phase: 'discovery',
          total: items.length,
          completed: items.length,
          percent: 100,
          message: `Discovery complete ${items.length}/${items.length}`
        };

        return { urls: out, totalItems: items.length };
      }
    });

    const payload = (result && result[0] && result[0].result) || { urls: [], totalItems: 0 };
    discoveryRunning = false;
    stopDiscoveryPolling();
    syncControlStates();

    if (payload.aborted) {
      setResolvedPlayerLinks(payload.urls || []);
      setProgress(0, 'Discovery aborted');
      setStatus('Discovery aborted by user.', true);
      return;
    }

    if (payload.error) {
      setResolvedPlayerLinks([]);
      setProgress(0, 'Discovery failed');
      setStatus(payload.error, true);
      return;
    }

    const items = payload.urls || [];
    setResolvedPlayerLinks(items);
    if (items.length > 0) {
      setProgress(100, `Discovery complete (${items.length} audio links)`);
      setStatus(`Loaded ${items.length} audio link(s) from the playlist.`);
    } else {
      setProgress(100, 'Discovery complete (0 audio links)');
      setStatus('No audio links were found in the playlist.', true);
    }
  } catch (err) {
    discoveryRunning = false;
    stopDiscoveryPolling();
    syncControlStates();
    setProgress(0, 'Discovery failed');
    setStatus(err.message, true);
  }
});

abortBtn.addEventListener('click', async () => {
  try {
    if (discoveryRunning && discoveryTabId) {
      await chrome.scripting.executeScript({
        target: { tabId: discoveryTabId },
        func: () => {
          globalThis.__aacDiscoveryAbort = true;
          return true;
        }
      });
      setStatus('Abort requested for discovery...');
      return;
    }

    if (currentJobId) {
      const response = await chrome.runtime.sendMessage({ type: 'abortJob', jobId: currentJobId });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Abort failed');
      }
      setStatus('Abort requested for active task...');
      return;
    }

    setStatus('No active task to abort.', true);
  } catch (err) {
    setStatus(err.message, true);
  }
});

selectAllPlayerLinksBtn.addEventListener('click', () => {
  setAllPlayerLinkSelections(true);
});

selectNonePlayerLinksBtn.addEventListener('click', () => {
  setAllPlayerLinkSelections(false);
});

clearMemoryBtn.addEventListener('click', async () => {
  try {
    if (discoveryRunning || isJobProcessing) {
      throw new Error('Cannot clear memory while processing. Abort first.');
    }

    const response = await chrome.runtime.sendMessage({ type: 'clearMemory' });
    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'Clear memory failed');
    }

    currentJobId = null;
    zipAvailable = false;
    resolvedPlayerLinks = [];
    setResolvedPlayerLinks([]);
    setLog('Ready.');
    setProgress(0, 'Idle');
    setStatus('Memory cleared.');
    syncControlStates();
  } catch (err) {
    setStatus(err.message, true);
  }
});

setProgress(0, 'Idle');
syncControlStates();
