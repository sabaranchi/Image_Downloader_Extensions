let currentMedia = [];
let currentFilter = "all";
let currentTabId = null;
let currentUrl = null;
let pageChangeTimer = null;
const mediaByUrl = new Map();
const nodeByUrl = new Map();

const scanButton = document.getElementById("scanButton");
const clearButton = document.getElementById("clearButton");
const downloadAllButton = document.getElementById("downloadAllButton");
const mediaList = document.getElementById("mediaList");
const mediaCount = document.getElementById("mediaCount");
const tabButtons = document.querySelectorAll(".tab-btn");

const BLOCKED_SCHEMES = ["chrome:", "edge:", "about:", "devtools:", "chrome-extension:", "view-source:"];

function isTabScannable(tab) {
  if (!tab || !tab.id) return false;
  const url = tab.url || "";
  return /^https?:|^file:/.test(url) && !BLOCKED_SCHEMES.some((scheme) => url.startsWith(scheme));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id || null;
  currentUrl = tab?.url || null;
  return tab;
}

async function ensureContentScript(tab) {
  if (!isTabScannable(tab)) throw new Error("This page cannot be scanned.");
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "ping" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  }
}

function addMedia(items) {
  const added = [];
  const changed = [];

  for (const item of items || []) {
    if (!isUsableMedia(item)) continue;
    if (item.type !== "image" && item.type !== "video" && item.type !== "audio") continue;

    const existing = mediaByUrl.get(item.url);
    if (existing) {
      const merged = { ...existing, ...item };
      mediaByUrl.set(item.url, merged);
      const index = currentMedia.findIndex((media) => media.url === item.url);
      if (index >= 0) currentMedia[index] = merged;
      changed.push(merged);
      continue;
    }

    mediaByUrl.set(item.url, item);
    currentMedia.push(item);
    added.push(item);
  }

  appendMediaCards(added);
  updateMediaCards(changed);
  applyFilter();
}

function mergeMediaItems(...lists) {
  const merged = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      if (!isUsableMedia(item)) continue;
      if (item.type !== "image" && item.type !== "video" && item.type !== "audio") continue;
      const existing = merged.get(item.url);
      merged.set(item.url, existing ? { ...existing, ...item } : item);
    }
  }
  return [...merged.values()];
}

function rebuildMediaList(items, { resetFilter = false } = {}) {
  currentMedia = [];
  mediaByUrl.clear();
  nodeByUrl.clear();
  mediaList.replaceChildren();

  if (resetFilter) {
    currentFilter = "all";
    tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.type === "all"));
  }

  const usableItems = mergeMediaItems(items);
  for (const item of usableItems) {
    mediaByUrl.set(item.url, item);
    currentMedia.push(item);
  }

  appendMediaCards(currentMedia);
  applyFilter();
}

function isUsableMedia(item) {
  if (!item || !item.url) return false;
  if (/^blob:/.test(item.url) && !item.resolvedFromBlob) return false;
  if (/\.(html?|php|asp|aspx)(\?|$)/i.test(item.url)) return false;
  return true;
}

function getFilteredMedia() {
  if (currentFilter === "all") return currentMedia;
  return currentMedia.filter((item) => item.type === currentFilter);
}

function setBusy(isBusy) {
  scanButton.disabled = isBusy;
  scanButton.textContent = isBusy ? "Scanning" : "Scan";
}

async function scanPage() {
  const tab = await getActiveTab();
  setBusy(true);

  try {
    const alreadyShown = currentMedia.slice();
    await ensureContentScript(tab);
    const response = await chrome.tabs.sendMessage(tab.id, { action: "scanMedia", reset: true });
    const backgroundResponse = await chrome.runtime.sendMessage({ action: "getDetectedMedia", tabId: tab.id }).catch(() => null);
    if (response && response.success === false) throw new Error(response.error || "Scan failed.");
    rebuildMediaList(mergeMediaItems(alreadyShown, backgroundResponse?.media, response?.media));
  } catch (error) {
    console.error("Scan failed:", error);
    mediaList.innerHTML = '<div class="empty-state">Scan failed</div>';
  } finally {
    setBusy(false);
  }
}

async function clearList() {
  clearState({ resetFilter: true });

  try {
    const tab = await getActiveTab();
    if (isTabScannable(tab)) {
      await chrome.tabs.sendMessage(tab.id, { action: "resetScan" });
      await chrome.runtime.sendMessage({ action: "clearDetectedMedia", tabId: tab.id });
    }
  } catch {
    // The page may not have the content script yet. The UI clear still succeeds.
  }
}

function clearState({ resetFilter }) {
  currentMedia = [];
  mediaByUrl.clear();
  nodeByUrl.clear();
  mediaList.innerHTML = '<div class="empty-state">Scan the page</div>';
  if (resetFilter) {
    currentFilter = "all";
    tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.type === "all"));
  }
  updateCounters();
}

function appendMediaCards(items) {
  if (!items.length) return;
  removeEmptyState();
  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const card = createMediaCard(item);
    nodeByUrl.set(item.url, card);
    fragment.appendChild(card);
  }

  mediaList.appendChild(fragment);
}

function updateMediaCards(items) {
  for (const item of items) {
    const node = nodeByUrl.get(item.url);
    if (!node) continue;
    const nextNode = createMediaCard(item);
    node.replaceWith(nextNode);
    nodeByUrl.set(item.url, nextNode);
  }
}

function removeEmptyState() {
  mediaList.querySelector(".empty-state")?.remove();
}

function updateCounters() {
  mediaCount.textContent = String(getFilteredMedia().length);
  downloadAllButton.disabled = currentMedia.length === 0;
}

function applyFilter() {
  const filtered = new Set(getFilteredMedia().map((item) => item.url));
  let visibleCount = 0;

  for (const [url, node] of nodeByUrl) {
    const isVisible = filtered.has(url);
    node.hidden = !isVisible;
    if (isVisible) visibleCount += 1;
  }

  if (!currentMedia.length) {
    mediaList.innerHTML = '<div class="empty-state">Scan the page</div>';
  } else if (!visibleCount && !mediaList.querySelector(".empty-state")) {
    mediaList.insertAdjacentHTML("afterbegin", '<div class="empty-state">No matching media</div>');
  } else if (visibleCount) {
    removeEmptyState();
  }

  updateCounters();
}

function createMediaCard(item) {
  const card = document.createElement("article");
  card.className = "media-item";

  if (item.type === "video") {
    if (item.thumbnail) {
      const img = document.createElement("img");
      img.className = "video-preview";
      img.src = item.thumbnail;
      img.alt = "";
      img.loading = "lazy";
      card.appendChild(img);
    } else if (!item.isHls) {
      const video = document.createElement("video");
      video.className = "video-preview";
      video.src = item.url;
      video.controls = true;
      video.preload = "none";
      card.appendChild(video);
    } else {
      card.appendChild(createPlaceholder("hls"));
    }
  } else if (item.type === "audio") {
    const audioPanel = document.createElement("div");
    audioPanel.className = "audio-preview";
    const label = document.createElement("div");
    label.textContent = "Audio";
    const audio = document.createElement("audio");
    audio.src = item.url;
    audio.controls = true;
    audio.preload = "none";
    audioPanel.append(label, audio);
    card.appendChild(audioPanel);
  } else {
    const img = document.createElement("img");
    img.className = "media-preview";
    img.src = item.thumbnail || item.url;
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.replaceWith(createPlaceholder(item.type));
    }, { once: true });
    card.appendChild(img);
  }

  const button = document.createElement("button");
  button.className = "download-btn";
  button.type = "button";
  button.textContent = "Save";
  button.addEventListener("click", () => downloadMedia(item));
  card.appendChild(button);

  return card;
}

function createPlaceholder(type) {
  const placeholder = document.createElement("div");
  placeholder.className = "media-placeholder";
  placeholder.textContent = type === "hls" ? "HLS" : (type === "video" ? "Video" : "Image");
  return placeholder;
}

function getFileExtension(item) {
  try {
    const pathname = new URL(item.url).pathname.toLowerCase();
    const match = pathname.match(/\.([a-z0-9]{2,5})$/);
    if (match) return match[1];
  } catch {}
  if (item.type === "audio") return "mp3";
  return item.type === "video" ? "mp4" : "jpg";
}

function generateFilename(item) {
  let ext = getFileExtension(item);
  if (item.type === "video" && !["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) ext = "mp4";
  if (item.type === "image" && ["html", "htm", "php", "asp", "aspx"].includes(ext)) ext = "jpg";
  if (item.type === "audio" && ["html", "htm", "php", "asp", "aspx"].includes(ext)) ext = "mp3";
  const base = item.type === "video" ? "video" : (item.type === "audio" ? "audio" : "image");
  return `${base}_${Date.now()}.${ext}`;
}

async function downloadMedia(item) {
  const response = await chrome.runtime.sendMessage({
    action: "download",
    url: item.url,
    filename: generateFilename(item),
    type: item.type,
    tabId: currentTabId,
    pageUrl: currentUrl
  });

  if (!response?.success) {
    console.error("Download failed:", response?.error);
    alert(response?.error || "Download failed.");
  }
}

async function downloadAll() {
  const filtered = getFilteredMedia();
  downloadAllButton.disabled = true;
  try {
    for (const item of filtered) {
      await downloadMedia(item);
    }
  } finally {
    downloadAllButton.disabled = currentMedia.length === 0;
  }
}

function changeFilter(type) {
  currentFilter = type;
  tabButtons.forEach((button) => button.classList.toggle("active", button.dataset.type === type));
  applyFilter();
}

async function refreshForActiveTab() {
  const tab = await getActiveTab();
  clearState({ resetFilter: true });
  if (!isTabScannable(tab)) return;

  try {
    await chrome.runtime.sendMessage({ action: "clearDetectedMedia", tabId: tab.id });
    await ensureContentScript(tab);
    await chrome.tabs.sendMessage(tab.id, { action: "resetScan" });
    const response = await chrome.tabs.sendMessage(tab.id, { action: "scanMedia", reset: true });
    const backgroundResponse = await chrome.runtime.sendMessage({ action: "getDetectedMedia", tabId: tab.id }).catch(() => null);
    if (response && response.success === false) throw new Error(response.error || "Scan failed.");
    rebuildMediaList(mergeMediaItems(backgroundResponse?.media, response?.media), { resetFilter: true });
  } catch (error) {
    console.error("Auto refresh failed:", error);
  }
}

scanButton.addEventListener("click", scanPage);
clearButton.addEventListener("click", clearList);
downloadAllButton.addEventListener("click", downloadAll);
tabButtons.forEach((button) => button.addEventListener("click", () => changeFilter(button.dataset.type)));
window.addEventListener("resize", () => applyFilter());

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.action === "newMediaFound" || request.action === "networkMediaFound") {
    const sourceTabId = request.tabId || sender?.tab?.id;
    if (sourceTabId && currentTabId && sourceTabId !== currentTabId) return;
    addMedia(request.media ? (Array.isArray(request.media) ? request.media : [request.media]) : []);
  } else if (request.action === "downloaderPageChanged") {
    clearTimeout(pageChangeTimer);
    pageChangeTimer = setTimeout(refreshForActiveTab, 450);
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  const tab = await getActiveTab();
  try {
    const response = await chrome.runtime.sendMessage({ action: "getDetectedMedia", tabId: tab?.id });
    addMedia(response?.media || []);
  } catch {
    applyFilter();
  }
  applyFilter();
});
