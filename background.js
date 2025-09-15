chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab || !tab.url) return;

    // 対象ページのみ通知（chrome:// や拡張ページは除外）
    if (/^https?:\/\//.test(tab.url)) {
      chrome.tabs.sendMessage(tabId, { type: "tabActivated" }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn("❌ tabActivated failed:", chrome.runtime.lastError.message);
        } else {
          console.log("✅ tabActivated sent to tab", tabId);
        }
      });
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === "sidePanelOpened") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { type: "forceReload" });
    });
  }
});