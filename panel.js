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
      u.includes(".jpg") || u.includes(".jpeg") ||
      u.includes(".png") || u.includes(".webp") || u.includes(".gif") || u.includes(".avif")
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
