(() => {
  if (window.__imageObserverInitialized) return;
  window.__imageObserverInitialized = true;

  let lastImageSet = new Set();
  window.observer = null;

  async function getAllImages() {
    console.log("🕵️ getAllImages called at", new Date().toLocaleTimeString());
    console.log("🖼️ img count:", document.querySelectorAll("img").length);
    const urls = new Set();

    // 1. <img> タグ
    document.querySelectorAll("img").forEach(img => {
      if (img.currentSrc) urls.add(img.currentSrc);
      else if (img.src) urls.add(img.src);
    });

    // 2. <canvas>
    document.querySelectorAll("canvas").forEach(c => {
      try {
        urls.add(c.toDataURL("image/png"));
      } catch {}
    });

    // 3. background-image
    document.querySelectorAll("div, a, span").forEach(el => {
      const bg = window.getComputedStyle(el).backgroundImage;
      if (bg && bg.startsWith("url(")) urls.add(bg.slice(5, -2));
    });

    // 4. Blob / AVIF 対策：canvas に描画して PNG に変換
    const finalUrls = [];
    for (const url of urls) {
      if (!url) continue;

      // AVIF または Blob URL の場合
      if (url.endsWith(".avif") || url.startsWith("blob:")) {
        try {
          const img = await new Promise((resolve, reject) => {
            const i = new Image();
            i.crossOrigin = "anonymous";
            i.onload = () => resolve(i);
            i.onerror = () => reject(i);
            i.src = url;
          });

          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          finalUrls.push(canvas.toDataURL("image/png"));
        } catch {
          finalUrls.push(url); // 失敗しても元のURL保持
        }
      } else {
        finalUrls.push(url);
      }
    }
    console.log("✅ Final image count:", finalUrls.length);
    console.log("✅ Final image URLs:", finalUrls);
    return [...new Set(finalUrls)];
  }

  async function updateImages() {
    const current = await getAllImages();
    const currentSet = new Set(current);

    const hasChanged =
      current.length !== lastImageSet.size ||
      [...currentSet].some(url => !lastImageSet.has(url));

    if (!hasChanged) return;

    lastImageSet = currentSet;
    try {
      chrome.runtime.sendMessage({ type: "imagesUpdatedPartial", images: current });
    } catch {}
  }
  
  async function forceReloadImages() {
    await new Promise(r => setTimeout(r, 500)); // ✅ 500ms待機
    const all = await getAllImages();
    console.log("🔁 forceReloadImages: found", all.length, "images");
    console.log("🔁 image URLs:", all);
    lastImageSet = new Set(all); // ✅ 状態を強制更新
    try {
      chrome.runtime.sendMessage({ type: "imagesUpdatedFull", images: all });
    } catch (e) {
      console.warn("Failed to send full image list:", e);
    }
  }

  function startObserver() {
    if (window.observer) window.observer.disconnect();
    window.observer = new MutationObserver(debounceUpdate);
    window.observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "style"] });
    updateImages();
  }

  let updateTimer = null;
  function debounceUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(updateImages, 400);
  }

  function hookHistoryEvents() {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function () {
      originalPushState.apply(this, arguments);
      window.dispatchEvent(new Event("locationchange"));
    };

    history.replaceState = function () {
      originalReplaceState.apply(this, arguments);
      window.dispatchEvent(new Event("locationchange"));
    };

    window.addEventListener("popstate", () => window.dispatchEvent(new Event("locationchange")));
    window.addEventListener("locationchange", () => {
      clearTimeout(window.__locationChangeTimer);
      window.__locationChangeTimer = setTimeout(() => {
        try { chrome.runtime.sendMessage({ type: "pageChanged" }); } catch {}
        startObserver();
      }, 300);
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === "tabActivated") {
        console.log("Tab activated:", location.href);
        startObserver(); // ✅ タブがアクティブになったら再監視開始
      }
    });

    chrome.runtime.onMessage.addListener((message) => {
      console.log("📩 Message received in content.js:", message.type);
      if (message.type === "requestImages") {
        updateImages(); // 差分送信
      } else if (message.type === "forceReload") {
        console.log("🔁 forceReload triggered");
        forceReloadImages(); // 全再送信
      }
    });
  }

  // URL監視補強
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      window.dispatchEvent(new Event("locationchange"));
    }
  }, 1000);

  hookHistoryEvents();
  startObserver();
})();