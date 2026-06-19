(() => {
  if (window.__mediaDownloaderContentLoaded) return;
  window.__mediaDownloaderContentLoaded = true;

  const seenUrls = new Set();
  const blobMap = {};

  function injectPageScript() {
    try {
      if (document.querySelector("script[data-media-downloader-pageinject]")) return;
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("page_inject.js");
      script.dataset.mediaDownloaderPageinject = "1";
      (document.documentElement || document.head || document.body).appendChild(script);
    } catch (error) {
      console.warn("media-downloader: page injection failed", error);
    }
  }

  injectPageScript();

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.__BLOB_MAP) Object.assign(blobMap, data.__BLOB_MAP);
    if (data && data.__CAPTURE_PUSH && data.__CAPTURE_PUSH.url) {
      const item = mediaItemFromUrl(data.__CAPTURE_PUSH.url);
      if (item) sendItems([item]);
    }
  });

  function resolveUrl(url) {
    if (!url || typeof url !== "string") return "";
    if (!url.startsWith("blob:")) return url;
    if (blobMap[url]) return blobMap[url];
    try {
      window.postMessage({ __RESOLVE_BLOB: url }, "*");
    } catch {}
    return blobMap[url] || url;
  }

  function filenameFromUrl(url, fallback) {
    try {
      const parsed = new URL(url, location.href);
      const name = parsed.pathname.split("/").filter(Boolean).pop();
      return name || fallback;
    } catch {
      return fallback;
    }
  }

  function extractCssUrls(value) {
    if (!value || typeof value !== "string" || value === "none") return [];
    const urls = [];
    const re = /url\(["']?([^"')]+)["']?\)/g;
    let match;
    while ((match = re.exec(value)) !== null) {
      if (match[1]) urls.push(match[1]);
    }
    return urls;
  }

  function pushAttributeMedia(candidate, items) {
    const attrs = ["href", "src", "data-src", "data-url", "data-file", "data-audio", "data-media"];
    attrs.forEach((attr) => {
      const value = candidate.getAttribute?.(attr);
      pushIfNew(items, mediaItemFromUrl(value));
    });
  }

  function extractMediaUrlsFromText(text) {
    if (!text || typeof text !== "string") return [];
    const urls = [];
    const re = /https?:\\?\/\\?\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|webm|mov|m4v|mp3|m4a|aac|flac|wav|png|jpe?g|webp|avif)(?:\?[^\s"'<>\\)]*)?/gi;
    let match;
    while ((match = re.exec(text)) !== null) {
      urls.push(match[0].replaceAll("\\/", "/").replaceAll("&amp;", "&"));
    }
    return urls;
  }

  async function fetchWithCredentialFallback(url, options = {}) {
    const baseOptions = {
      method: "GET",
      cache: "no-store",
      referrer: location.href,
      referrerPolicy: "no-referrer-when-downgrade",
      ...options
    };

    let firstError = null;
    for (const credentials of ["omit", "include"]) {
      try {
        const response = await fetch(url, { ...baseOptions, credentials });
        if (response.ok) return response;
        firstError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        firstError = error;
      }
    }

    throw firstError || new Error("Fetch failed");
  }

  function mediaItemFromUrl(url) {
    if (!url || typeof url !== "string") return null;
    const cleanUrl = resolveUrl(url);
    const resolvedFromBlob = url.startsWith("blob:") && cleanUrl !== url;
    if (cleanUrl.startsWith("blob:")) return null;
    const path = cleanUrl.split("?")[0].toLowerCase();
    if (/\.(png|jpe?g|gif|webp|avif|bmp|svg|ico)$/.test(path) || cleanUrl.startsWith("data:image/")) {
      return { type: "image", url: cleanUrl, thumbnail: cleanUrl, filename: filenameFromUrl(cleanUrl, "image"), resolvedFromBlob };
    }
    if (/\.(mp4|webm|mov|m4v|ogv|ogg|m3u8)$/.test(path) || cleanUrl.startsWith("blob:")) {
      return { type: "video", url: cleanUrl, thumbnail: null, filename: filenameFromUrl(cleanUrl, "video"), resolvedFromBlob, isHls: /\.m3u8$/i.test(path) };
    }
    if (/\.(mp3|wav|m4a|aac|flac|opus)$/.test(path)) {
      return { type: "audio", url: cleanUrl, thumbnail: null, filename: filenameFromUrl(cleanUrl, "audio"), resolvedFromBlob };
    }
    return null;
  }

  function pushIfNew(items, item) {
    if (!item || !item.url || seenUrls.has(item.url)) return;
    seenUrls.add(item.url);
    items.push(item);
  }

  function collectFromRoot(root, items) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const element = root;
    const selector = "img, picture source, video, audio, source, a[href], [style], [data-src], [data-url], [data-file], [data-audio], [data-media]";
    const candidates = element.matches?.(selector) ? [element] : [];
    candidates.push(...element.querySelectorAll?.(selector) || []);

    candidates.forEach((candidate) => {
      if (candidate.matches("img, picture source")) {
        const url = candidate.currentSrc || candidate.src || candidate.srcset?.split(",").pop()?.trim().split(/\s+/)[0];
        pushIfNew(items, mediaItemFromUrl(url));
        return;
      }

      if (candidate.matches("video")) {
        const url = resolveUrl(candidate.currentSrc || candidate.src || candidate.querySelector("source")?.src);
        if (!url || url.startsWith("blob:")) return;
        pushIfNew(items, {
          type: "video",
          url,
          thumbnail: candidate.poster || null,
          filename: filenameFromUrl(url, "video"),
          resolvedFromBlob: candidate.currentSrc?.startsWith("blob:") || candidate.src?.startsWith("blob:"),
          isHls: url.split("?")[0].toLowerCase().endsWith(".m3u8")
        });
        return;
      }

      if (candidate.matches("audio")) {
        const url = resolveUrl(candidate.currentSrc || candidate.src || candidate.querySelector("source")?.src);
        if (!url || url.startsWith("blob:")) return;
        pushIfNew(items, {
          type: "audio",
          url,
          thumbnail: null,
          filename: filenameFromUrl(url, "audio"),
          resolvedFromBlob: candidate.currentSrc?.startsWith("blob:") || candidate.src?.startsWith("blob:")
        });
        return;
      }

      if (candidate.matches("source")) {
        pushIfNew(items, mediaItemFromUrl(candidate.src || candidate.srcset?.split(",").pop()?.trim().split(/\s+/)[0]));
        return;
      }

      pushAttributeMedia(candidate, items);

      if (candidate.hasAttribute("style")) {
        const inlineBg = candidate.style.backgroundImage;
        extractCssUrls(inlineBg).forEach((url) => pushIfNew(items, mediaItemFromUrl(url)));
      }
    });
  }

  function collectComputedBackgrounds(items) {
    const elements = Array.from(document.body?.querySelectorAll("*") || []).slice(0, 2500);
    elements.forEach((element) => {
      try {
        const background = getComputedStyle(element).backgroundImage;
        extractCssUrls(background).forEach((url) => pushIfNew(items, mediaItemFromUrl(url)));
      } catch {}
    });
  }

  function collectMedia({ reset = false, roots = null } = {}) {
    if (reset) seenUrls.clear();
    const items = [];

    const scanRoots = roots?.length ? roots : [document.documentElement];
    scanRoots.forEach((root) => collectFromRoot(root, items));
    if (!roots?.length) collectComputedBackgrounds(items);

    document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], meta[property="og:video"], meta[property="og:audio"]').forEach((meta) => {
      pushIfNew(items, mediaItemFromUrl(meta.content));
    });

    collectPerformanceMedia(items);
    if (!roots?.length) collectScriptMedia(items);

    return items;
  }

  function collectPerformanceMedia(items) {
    try {
      performance.getEntriesByType("resource").forEach((entry) => {
        pushIfNew(items, mediaItemFromUrl(entry.name));
      });
    } catch {}
  }

  function collectScriptMedia(items) {
    const scripts = Array.from(document.scripts || []).slice(-80);
    scripts.forEach((script) => {
      try {
        extractMediaUrlsFromText(script.textContent || "").forEach((url) => pushIfNew(items, mediaItemFromUrl(url)));
      } catch {}
    });
  }

  function sendItems(items) {
    if (!items.length) return;
    try {
      if (!chrome?.runtime?.id) return;
      chrome.runtime.sendMessage({ action: "newMediaFound", media: items }).catch(() => {});
    } catch {}
  }

  let timer = null;
  const pendingRoots = new Set();
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.type === "childList") {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) pendingRoots.add(node);
        });
      } else if (mutation.target?.nodeType === Node.ELEMENT_NODE) {
        pendingRoots.add(mutation.target);
      }
    });
    clearTimeout(timer);
    timer = setTimeout(() => {
      const roots = [...pendingRoots];
      pendingRoots.clear();
      sendItems(collectMedia({ roots }));
    }, 250);
  });

  function startObserver() {
    try {
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "poster", "style"] });
    } catch {}
  }

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === "ping") {
      sendResponse({ success: true });
      return true;
    }
    if (request.action === "scanMedia") {
      try {
        sendResponse({ success: true, media: collectMedia({ reset: !!request.reset }) });
      } catch (error) {
        sendResponse({ success: false, error: error.message || String(error), media: [] });
      }
      return true;
    }
    if (request.action === "resetScan") {
      seenUrls.clear();
      sendResponse({ success: true });
      return true;
    }
    if (request.action === "fetchMediaAsDataUrl") {
      (async () => {
        try {
          const response = await fetchWithCredentialFallback(request.url);
          const contentType = (response.headers.get("content-type") || "").toLowerCase();
          if (contentType.includes("text/html")) {
            sendResponse({ success: false, error: "HTML response" });
            return;
          }
          const blob = await response.blob();
          const reader = new FileReader();
          reader.onloadend = () => sendResponse({ success: true, dataUrl: reader.result });
          reader.onerror = () => sendResponse({ success: false, error: "FileReader failed" });
          reader.readAsDataURL(blob);
        } catch (error) {
          sendResponse({ success: false, error: error.message || String(error) });
        }
      })();
      return true;
    }
    if (request.action === "fetchHlsText") {
      (async () => {
        try {
          const response = await fetchWithCredentialFallback(request.url, {
            referrerPolicy: "strict-origin-when-cross-origin"
          });
          sendResponse({ success: true, text: await response.text() });
        } catch (error) {
          sendResponse({ success: false, error: error.message || String(error) });
        }
      })();
      return true;
    }
    if (request.action === "fetchHlsSegmentAsDataUrl") {
      (async () => {
        try {
          const response = await fetchWithCredentialFallback(request.url, {
            referrerPolicy: "strict-origin-when-cross-origin"
          });
          const blob = await response.blob();
          const reader = new FileReader();
          reader.onloadend = () => sendResponse({ success: true, dataUrl: reader.result });
          reader.onerror = () => sendResponse({ success: false, error: "FileReader failed" });
          reader.readAsDataURL(blob);
        } catch (error) {
          sendResponse({ success: false, error: error.message || String(error) });
        }
      })();
      return true;
    }
    return false;
  });

  function notifyPageChanged() {
    seenUrls.clear();
    try {
      if (chrome?.runtime?.id) chrome.runtime.sendMessage({ action: "contentPageChanged", url: location.href }).catch(() => {});
    } catch {}
    setTimeout(() => sendItems(collectMedia({ reset: true })), 300);
  }

  function hookHistory() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function pushState() {
      const result = originalPushState.apply(this, arguments);
      window.dispatchEvent(new Event("downloaderLocationChange"));
      return result;
    };
    history.replaceState = function replaceState() {
      const result = originalReplaceState.apply(this, arguments);
      window.dispatchEvent(new Event("downloaderLocationChange"));
      return result;
    };
    window.addEventListener("popstate", () => window.dispatchEvent(new Event("downloaderLocationChange")));
    window.addEventListener("downloaderLocationChange", notifyPageChanged);
  }

  hookHistory();
  startObserver();
  setTimeout(() => sendItems(collectMedia()), 250);
  setInterval(() => {
    const items = [];
    collectPerformanceMedia(items);
    sendItems(items);
  }, 2000);
})();
