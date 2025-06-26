chrome.action.onClicked.addListener(tab => {
    chrome.tabs.sendMessage(tab.id, { type: 'consent' });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.warn(request);
    if (request.deviceConnected === true) {
        chrome.action.setIcon({ path: {"16": "green-16.png", "48": "green-48.png", "128": "green-128.png"},});
    } else if (request.deviceConnected === false){
        chrome.action.setIcon({ path: {"16": "red-16.png", "48": "red-48.png", "128": "red-128.png"},});
    }
});