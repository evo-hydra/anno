/**
 * Anno Data Capture - Background Service Worker
 *
 * Handles communication between content scripts and the Anno bridge server.
 * Manages captured data queue, connection status, and retry logic.
 */

// Configuration
const DEFAULT_BRIDGE_URL = 'http://localhost:3847';
const BRIDGE_ENDPOINTS = {
  submit: '/api/extension/submit',
  status: '/api/extension/status',
  auth: '/api/extension/auth',
};
const RETRY_DELAYS = [1000, 2000, 5000, 10000, 30000]; // Exponential backoff

// State
let bridgeUrl = DEFAULT_BRIDGE_URL;
let connectionStatus = 'disconnected';
let authToken = null;
let pendingData = [];
let retryCount = 0;

// ============================================================================
// Bridge Communication
// ============================================================================

/**
 * Check if Anno bridge server is available
 */
async function checkBridgeStatus() {
  try {
    const response = await fetch(`${bridgeUrl}${BRIDGE_ENDPOINTS.status}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken && { Authorization: `Bearer ${authToken}` }),
      },
    });

    if (response.ok) {
      const data = await response.json();
      connectionStatus = 'connected';
      retryCount = 0;
      await updateBadge('connected');
      return { connected: true, version: data.version };
    }

    connectionStatus = 'error';
    await updateBadge('error');
    return { connected: false, error: 'Invalid response' };
  } catch (error) {
    connectionStatus = 'disconnected';
    await updateBadge('disconnected');
    return { connected: false, error: error.message };
  }
}

/**
 * Submit captured data to Anno bridge
 */
async function submitData(data) {
  if (connectionStatus !== 'connected') {
    // Queue data for later submission
    pendingData.push({ data, timestamp: Date.now() });
    await savePendingData();
    return { queued: true, queueSize: pendingData.length };
  }

  try {
    const response = await fetch(`${bridgeUrl}${BRIDGE_ENDPOINTS.submit}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken && { Authorization: `Bearer ${authToken}` }),
      },
      body: JSON.stringify(data),
    });

    if (response.ok) {
      const result = await response.json();
      return { success: true, ...result };
    }

    if (response.status === 401) {
      // Token expired, need re-auth
      authToken = null;
      connectionStatus = 'unauthorized';
      await updateBadge('error');
      return { success: false, error: 'Authentication required', needsAuth: true };
    }

    return { success: false, error: `HTTP ${response.status}` };
  } catch (error) {
    // Queue for retry
    pendingData.push({ data, timestamp: Date.now() });
    await savePendingData();
    scheduleRetry();
    return { success: false, error: error.message, queued: true };
  }
}

/**
 * Process pending data queue
 */
async function processPendingData() {
  if (connectionStatus !== 'connected' || pendingData.length === 0) {
    return;
  }

  const toProcess = [...pendingData];
  pendingData = [];

  for (const item of toProcess) {
    const result = await submitData(item.data);
    if (!result.success && !result.queued) {
      // Re-queue failed items
      pendingData.push(item);
    }
  }

  await savePendingData();
}

/**
 * Schedule retry with exponential backoff
 */
function scheduleRetry() {
  const delay = RETRY_DELAYS[Math.min(retryCount, RETRY_DELAYS.length - 1)];
  retryCount++;

  setTimeout(async () => {
    const status = await checkBridgeStatus();
    if (status.connected) {
      await processPendingData();
    }
  }, delay);
}

// ============================================================================
// Storage
// ============================================================================

async function savePendingData() {
  await chrome.storage.local.set({ pendingData });
}

async function loadPendingData() {
  const result = await chrome.storage.local.get(['pendingData', 'bridgeUrl', 'authToken']);
  pendingData = result.pendingData || [];
  bridgeUrl = result.bridgeUrl || DEFAULT_BRIDGE_URL;
  authToken = result.authToken || null;
}

async function saveSettings(settings) {
  if (settings.bridgeUrl) {
    bridgeUrl = settings.bridgeUrl;
  }
  if (settings.authToken) {
    authToken = settings.authToken;
  }
  await chrome.storage.local.set({ bridgeUrl, authToken });
}

// ============================================================================
// Badge Updates
// ============================================================================

async function updateBadge(status) {
  const colors = {
    connected: '#22c55e', // green
    disconnected: '#6b7280', // gray
    error: '#ef4444', // red
    capturing: '#3b82f6', // blue
  };

  const texts = {
    connected: '',
    disconnected: '!',
    error: '!',
    capturing: '...',
  };

  await chrome.action.setBadgeBackgroundColor({ color: colors[status] || colors.disconnected });
  await chrome.action.setBadgeText({ text: texts[status] || '' });
}

// ============================================================================
// Message Handling
// ============================================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'CAPTURED_DATA':
      // Data captured from content script
      const captureResult = await submitData({
        marketplace: message.marketplace,
        dataType: message.dataType,
        items: message.items,
        pageUrl: sender.tab?.url,
        capturedAt: new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
      });
      return captureResult;

    case 'CHECK_STATUS':
      return {
        connectionStatus,
        bridgeUrl,
        pendingCount: pendingData.length,
        authenticated: !!authToken,
      };

    case 'UPDATE_SETTINGS':
      await saveSettings(message.settings);
      return { success: true };

    case 'RECONNECT':
      return await checkBridgeStatus();

    case 'FLUSH_PENDING':
      await processPendingData();
      return { success: true, remaining: pendingData.length };

    case 'CLEAR_PENDING':
      pendingData = [];
      await savePendingData();
      return { success: true };

    default:
      return { error: 'Unknown message type' };
  }
}

// ============================================================================
// Lifecycle
// ============================================================================

// Initialize on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  await loadPendingData();
  await checkBridgeStatus();
});

chrome.runtime.onStartup.addListener(async () => {
  await loadPendingData();
  await checkBridgeStatus();
});

// Periodic health check
setInterval(async () => {
  await checkBridgeStatus();
  if (connectionStatus === 'connected') {
    await processPendingData();
  }
}, 60000); // Every minute
