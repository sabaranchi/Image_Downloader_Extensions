const checkedMap = window.checkedMap || (window.checkedMap = {});
const allImageSet = new Set();

// サイドパネルが読み込まれた瞬間に通知
chrome.runtime.sendMessage({ type: "sidePanelOpened" });

function renderImages(urls) {
  const container = document.getElementById("images");
  container.innerHTML = "";
  const imageUrls = [];

  urls.forEach(u => {
    if (!u || typeof u !== "string") return;
    if (
      u.startsWith("data:image") ||
      u.includes(".jpg") || u.includes("=jpg") || u.includes(".jpeg") ||
      u.includes(".png") || u.includes("=png") || u.includes(".webp") || u.includes("=webp") || 
      u.includes(".gif") || u.includes("=gif") || u.includes(".avif") || u.includes("=avif")
    ) {
      imageUrls.push(u);
    }
  });

  if (imageUrls.length === 0) {
    container.innerHTML = "<p style='color:gray;'>画像が見つかりませんでした。</p>";
    return;
  }

  imageUrls.forEach((url, index) => {
    const isChecked = checkedMap[url] || false;
    const div = document.createElement("div");
    div.className = "img-item";
    div.innerHTML = `
      <input type="checkbox" id="img${index}" value="${url}" ${isChecked ? "checked" : ""}>
      <label for="img${index}">
        <img src="${url}" />
      </label>
    `;
    container.appendChild(div);
    div.querySelector("input").addEventListener("change", e => {
      checkedMap[url] = e.target.checked;
    });
    // Prevent label click from causing browser focus/scroll jump.
    // Instead toggle checkbox programmatically so the panel doesn't 'rollback'.
    const checkbox = div.querySelector('input');
    const labelEl = div.querySelector('label');
    if (labelEl) {
      labelEl.addEventListener('click', (e) => {
        // If the click originated from the actual checkbox, allow default.
        if (e.target === checkbox) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          checkbox.checked = !checkbox.checked;
          checkedMap[url] = checkbox.checked;
          // dispatch change event so any other listeners are notified
          const ev = new Event('change', { bubbles: true });
          checkbox.dispatchEvent(ev);
        } catch (err) {}
      });
    }
  });
}

// 🚀 content.js に直接メッセージを送る
async function requestImages(type = "requestImages") {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  console.log("📤 Sending message to content.js:", type);
  chrome.tabs.sendMessage(tab.id, { type });
}

document.getElementById("download").addEventListener("click", async () => {
  const selectedUrls = Object.entries(checkedMap).filter(([_, c]) => c).map(([url]) => url);
  if (!selectedUrls.length) return alert("No images selected.");

  if (selectedUrls.length >= 10) {
    const zip = new JSZip();
    let count = 0;
    for (const url of selectedUrls) {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        const ext = url.startsWith("data:") ? "png" : url.split(".").pop().split(/\#|\?/)[0];
        zip.file(`image${count}.${ext}`, blob);
        count++;
      } catch {}
    }
    const content = await zip.generateAsync({ type: "blob" });
    chrome.downloads.download({ url: URL.createObjectURL(content), filename: "images.zip", saveAs: true });
  } else {
    selectedUrls.forEach(url => {
      const name = url.startsWith("data:") ? "image.png" : url.split("/").pop().split("?")[0];
      chrome.downloads.download({ url, filename: name, saveAs: false });
    });
  }

  Object.keys(checkedMap).forEach(url => {
    checkedMap[url] = false;
    const checkbox = document.querySelector(`input[type="checkbox"][value="${url}"]`);
    if (checkbox) checkbox.checked = false;
  });
});

// ✅ Reloadボタン
document.getElementById("reload").addEventListener("click", () => {
  console.log("🔁 Reload button clicked");
  allImageSet.clear();
  Object.keys(checkedMap).forEach(k => delete checkedMap[k]);
  renderImages([]); 
  requestImages("forceReload"); // 🔥 直接メッセージ送信
});

// 📩 content.js からのメッセージ受信
chrome.runtime.onMessage.addListener(message => {
  console.log("📩 Received message:", message.type);
  if (message.type === "imagesUpdatedPartial") {
    message.images.forEach(u => allImageSet.add(u));
    renderImages([...allImageSet]);
  } else if (message.type === "imagesUpdatedFull") {
    allImageSet.clear();
    message.images.forEach(u => allImageSet.add(u));
    renderImages([...allImageSet]);
  } else if (message.type === "pageChanged" || message.type === "tabActivated") {
    Object.keys(checkedMap).forEach(k => delete checkedMap[k]);
    allImageSet.clear();
    renderImages([]);
    requestImages("requestImages");
  }
});

// 初回ロード
document.addEventListener("DOMContentLoaded", () => {
  console.log("🚀 DOMContentLoaded → requestImages");
  requestImages("requestImages");
});

// ===== Thumbnail width controls (toolbar) =====
(function() {
  const RANGE_ID = 'thumbRange';
  const NUMBER_ID = 'thumbNumber';
  const STORAGE_KEY = 'thumbMinWidth';

  function applyValue(px) {
    if (!px) return;
    if (typeof px === 'number') px = `${px}px`;
    document.documentElement.style.setProperty('--thumb-min', px);
  }

  // init elements (may not exist in older versions)
  const range = document.getElementById(RANGE_ID);
  const number = document.getElementById(NUMBER_ID);
  if (!range || !number) return;

  // load saved value
  const saved = localStorage.getItem(STORAGE_KEY);
  const initial = saved ? parseInt(saved, 10) : parseInt(range.value, 10);
  range.value = initial;
  number.value = initial;
  applyValue(initial);

  function onInput(v) {
    const n = parseInt(v, 10) || 100;
    range.value = n;
    number.value = n;
    applyValue(n);
    try { localStorage.setItem(STORAGE_KEY, String(n)); } catch(e) {}
  }

  range.addEventListener('input', (e) => onInput(e.target.value));
  number.addEventListener('change', (e) => {
    let val = parseInt(e.target.value, 10) || 100;
    if (val < parseInt(number.min,10)) val = parseInt(number.min,10);
    if (val > parseInt(number.max,10)) val = parseInt(number.max,10);
    onInput(val);
  });
})();