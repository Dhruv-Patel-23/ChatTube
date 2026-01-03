export {}

// This tells Chrome to open the side panel when the icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })

// background.ts
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  if (tab.url?.includes("youtube.com/watch")) {
    // Tell the side panel to refresh for the new video
    chrome.runtime.sendMessage({ 
      type: "TAB_CHANGED", 
      url: tab.url 
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && changeInfo.url.includes("youtube.com/watch")) {
    chrome.runtime.sendMessage({ 
      type: "URL_UPDATED", 
      url: changeInfo.url 
    });
  }
});