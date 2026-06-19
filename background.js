const detectedMediaByTab = new Map();

const EXTENSION_TO_TYPE = {
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  bmp: "image",
  svg: "image",
  ico: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  ogv: "video",
  m3u8: "video",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  opus: "audio"
};

function getMediaType(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const extension = pathname.split(".").pop();
    return EXTENSION_TO_TYPE[extension] || null;
  } catch {
    return null;
  }
}

function addDetectedMedia(tabId, media) {
  if (!tabId || tabId < 0 || !media?.url || !media?.type) return;

  if (!detectedMediaByTab.has(tabId)) detectedMediaByTab.set(tabId, new Map());
  const tabMedia = detectedMediaByTab.get(tabId);
  if (tabMedia.has(media.url)) return;

  tabMedia.set(media.url, media);
  chrome.runtime.sendMessage({ action: "networkMediaFound", tabId, media }).catch(() => {});
}

function inspectRequest(details) {
  const type = getMediaType(details.url);
  if (!type) return;
  addDetectedMedia(details.tabId, {
    type,
    url: details.url,
    thumbnail: type === "image" ? details.url : null,
    isHls: details.url.split("?")[0].toLowerCase().endsWith(".m3u8")
  });
}

chrome.webRequest.onBeforeRequest.addListener(inspectRequest, { urls: ["<all_urls>"] });
chrome.webRequest.onCompleted.addListener(inspectRequest, { urls: ["<all_urls>"] });

chrome.tabs.onRemoved.addListener((tabId) => {
  detectedMediaByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "download") {
    handleDownload(request)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message || String(error) }));
    return true;
  }

  if (request.action === "getDetectedMedia") {
    const tabMedia = detectedMediaByTab.get(request.tabId);
    sendResponse({ success: true, media: tabMedia ? [...tabMedia.values()] : [] });
    return true;
  }

  if (request.action === "clearDetectedMedia") {
    detectedMediaByTab.delete(request.tabId);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === "contentPageChanged") {
    const tabId = _sender?.tab?.id;
    if (tabId) {
      detectedMediaByTab.delete(tabId);
      chrome.runtime.sendMessage({ action: "downloaderPageChanged", tabId, url: request.url }).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }

  return false;
});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.runtime.sendMessage({ action: "downloaderPageChanged", tabId: activeInfo.tabId }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.status === "complete" || changeInfo.url) {
    detectedMediaByTab.delete(tabId);
    chrome.runtime.sendMessage({ action: "downloaderPageChanged", tabId, url: changeInfo.url }).catch(() => {});
  }
});

async function handleDownload(request) {
  const url = request.url;
  if (!url) throw new Error("Missing URL.");
  if (url.startsWith("blob:")) throw new Error("This blob URL is no longer available. Please rescan the page and try again.");

  if (url.split("?")[0].toLowerCase().endsWith(".m3u8")) {
    return downloadHlsAsMp4(url, request.filename || `video_${Date.now()}.mp4`, request.tabId, request.pageUrl);
  }

  if (request.type === "image" || request.type === "audio") {
    return downloadFetchedMedia(url, request.filename || `media_${Date.now()}`, request.type, request.tabId);
  }

  await validateMediaDownload(url, request.type);

  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url,
      filename: request.filename || `media_${Date.now()}`,
      saveAs: false,
      conflictAction: "uniquify"
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function downloadFetchedMedia(url, filename, expectedType, tabId) {
  if (Number.isInteger(tabId) && tabId >= 0) {
    const dataUrl = await fetchMediaDataUrlFromPage(tabId, url).catch(() => null);
    if (dataUrl) return downloadDataUrl(dataUrl, filename);
  }

  try {
    const blob = await fetchMediaBlob(url, expectedType);
    return downloadBlob(blob, filename);
  } catch (error) {
    throw error;
  }
}

async function fetchMediaBlob(url, expectedType) {
  if (url.startsWith("data:")) {
    const response = await fetch(url);
    return response.blob();
  }

  const response = await fetch(url, {
    method: "GET",
    credentials: "omit",
    cache: "no-store",
    referrer: getRefererForUrl(url),
    referrerPolicy: "no-referrer-when-downgrade"
  });

  if (response.status === 404 || response.status === 410) {
    throw new Error("The server says this media URL is no longer available (404). Rescan the page, then try the newly detected item.");
  }
  if (!response.ok) throw new Error(`Media fetch failed: HTTP ${response.status}`);

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) {
    throw new Error("The URL returned an HTML page, not media.");
  }

  const isBinary = contentType.includes("application/octet-stream") || contentType.includes("binary");
  if (expectedType && contentType && !contentType.startsWith(`${expectedType}/`) && !isBinary) {
    throw new Error(`The URL returned ${contentType}, not ${expectedType}.`);
  }

  return response.blob();
}

function getRefererForUrl(url, pageUrl = "") {
  if (pageUrl && /^https?:\/\//i.test(pageUrl)) return pageUrl;
  try {
    const host = new URL(url).hostname;
    if (host.endsWith("cloudintech.net")) return "https://asmr18.fans/";
    if (host.endsWith("gold-usergeneratedcontent.net")) return "https://hitomi.la/reader/3990821.html";
    if (host.endsWith("hitomi.la")) return "https://hitomi.la/";
    if (host.endsWith("pximg.net")) return "https://www.pixiv.net/";
  } catch {}
  return "";
}

async function fetchMediaDataUrlFromPage(tabId, url) {
  const response = await chrome.tabs.sendMessage(tabId, {
    action: "fetchMediaAsDataUrl",
    url
  });
  return response?.success ? response.dataUrl : null;
}

async function downloadBlob(blob, filename) {
  return downloadDataUrl(await blobToDataUrl(blob), filename);
}

async function downloadDataUrl(dataUrl, filename) {
  await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
      conflictAction: "uniquify"
    }, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

async function validateMediaDownload(url, expectedType) {
  if (url.startsWith("data:")) return;

  try {
    const response = await fetch(url, { method: "HEAD", credentials: "include" });
    if (response.status === 404 || response.status === 410) {
      throw new Error("The media file is no longer available. Rescan the page and try again.");
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType) return;
    if (contentType.includes("text/html")) {
      throw new Error("The URL returned an HTML page, not media. Rescan the page and choose the real media item.");
    }

    const isBinary = contentType.includes("application/octet-stream") || contentType.includes("binary");
    if (expectedType && !contentType.startsWith(`${expectedType}/`) && !isBinary) {
      throw new Error(`The URL returned ${contentType}, not ${expectedType}.`);
    }
  } catch (error) {
    if (/HTML page|not media|not image|not video|not audio|returned|no longer available/.test(error.message)) throw error;
  }
}

function absoluteUrl(base, value) {
  return new URL(value, base).toString();
}

async function fetchText(url, tabId = null, pageUrl = "") {
  const response = await fetchWithCredentialFallback(url, pageUrl).catch(() => null);
  if ((!response || !response.ok) && Number.isInteger(tabId) && tabId >= 0) {
    const pageText = await fetchHlsTextFromPage(tabId, url).catch(() => null);
    if (pageText) return pageText;
  }
  if (!response || !response.ok) throw new Error(`HLS playlist fetch failed: HTTP ${response?.status || "fetch failed"}`);
  return response.text();
}

async function fetchArrayBuffer(url, tabId = null, pageUrl = "") {
  const response = await fetchWithCredentialFallback(url, pageUrl).catch(() => null);
  if ((!response || !response.ok) && Number.isInteger(tabId) && tabId >= 0) {
    const dataUrl = await fetchHlsSegmentFromPage(tabId, url).catch(() => null);
    if (dataUrl) return dataUrlToArrayBuffer(dataUrl);
  }
  if (!response || !response.ok) throw new Error(`HLS segment fetch failed: HTTP ${response?.status || "fetch failed"}`);
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html")) throw new Error("HLS segment returned HTML, not media.");
  return response.arrayBuffer();
}

async function fetchWithCredentialFallback(url, pageUrl = "") {
  let lastResponse = null;
  let lastError = null;
  for (const credentials of ["omit", "include"]) {
    try {
      const response = await fetch(url, {
        credentials,
        cache: "no-store",
        referrer: getRefererForUrl(url, pageUrl),
        referrerPolicy: "strict-origin-when-cross-origin"
      });
      if (response.ok) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError || new Error("Fetch failed");
}

async function resolveHlsPlaylist(playlistUrl, tabId = null, pageUrl = "") {
  let url = playlistUrl;
  let text = await fetchText(url, tabId, pageUrl);

  if (/#EXT-X-STREAM-INF/i.test(text)) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let best = null;

    for (let i = 0; i < lines.length; i += 1) {
      const info = lines[i];
      if (!info.startsWith("#EXT-X-STREAM-INF")) continue;
      const next = lines[i + 1];
      if (!next || next.startsWith("#")) continue;
      const bandwidth = Number(info.match(/BANDWIDTH=(\d+)/i)?.[1] || 0);
      if (!best || bandwidth > best.bandwidth) {
        best = { bandwidth, url: absoluteUrl(url, next) };
      }
    }

    if (best) {
      url = best.url;
      text = await fetchText(url, tabId, pageUrl);
    }
  }

  return { url, text };
}

function parseMediaPlaylist(url, text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const initLine = lines.find((line) => line.startsWith("#EXT-X-MAP"));
  const initUri = initLine?.match(/URI="([^"]+)"/i)?.[1] || null;
  const hasKey = lines.some((line) => line.startsWith("#EXT-X-KEY"));
  const segments = lines
    .filter((line) => !line.startsWith("#"))
    .map((line) => absoluteUrl(url, line));

  return {
    initUrl: initUri ? absoluteUrl(url, initUri) : null,
    hasKey,
    segments
  };
}

async function downloadHlsAsMp4(playlistUrl, filename, tabId = null, pageUrl = "") {
  const playlist = await resolveHlsPlaylist(playlistUrl, tabId, pageUrl);
  const parsed = parseMediaPlaylist(playlist.url, playlist.text);

  if (!parsed.segments.length) throw new Error("No HLS segments were found.");
  if (parsed.hasKey) {
    throw new Error("This HLS stream is encrypted. Encrypted TS streams cannot be packaged by this extension yet.");
  }

  const segmentPaths = parsed.segments.map((url) => new URL(url).pathname.toLowerCase());
  const hasTransportStream = segmentPaths.some((path) => path.endsWith(".ts"));
  const looksFragmentedMp4 = parsed.initUrl || segmentPaths.every((path) => /\.(m4s|mp4|cmfv|m4v)$/.test(path));

  const parts = [];
  if (parsed.initUrl) parts.push(await fetchArrayBuffer(parsed.initUrl, tabId, pageUrl));

  for (const segment of parsed.segments) {
    parts.push(await fetchArrayBuffer(segment, tabId, pageUrl));
  }

  const saveAsTs = hasTransportStream && !looksFragmentedMp4;
  const blob = new Blob(parts, { type: saveAsTs ? "video/mp2t" : "video/mp4" });
  return downloadBlob(blob, forceExtension(filename, saveAsTs ? "ts" : "mp4"));
}

function forceExtension(filename, extension) {
  const cleanName = filename || `video_${Date.now()}.${extension}`;
  return cleanName.replace(/\.[a-z0-9]{1,6}$/i, `.${extension}`);
}

async function fetchHlsTextFromPage(tabId, url) {
  const response = await chrome.tabs.sendMessage(tabId, {
    action: "fetchHlsText",
    url
  });
  return response?.success ? response.text : null;
}

async function fetchHlsSegmentFromPage(tabId, url) {
  const response = await chrome.tabs.sendMessage(tabId, {
    action: "fetchHlsSegmentAsDataUrl",
    url
  });
  return response?.success ? response.dataUrl : null;
}

function dataUrlToArrayBuffer(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Invalid data URL.");
  const meta = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  if (meta.includes(";base64")) {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  return new TextEncoder().encode(decodeURIComponent(data)).buffer;
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}
