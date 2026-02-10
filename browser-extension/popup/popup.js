/**
 * Anno Data Capture - Popup Script
 *
 * Manages the popup UI for the browser extension.
 */

// ============================================================================
// DOM Elements
// ============================================================================

const elements = {
  version: document.getElementById('version'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  pendingCount: document.getElementById('pending-count'),
  bridgeUrl: document.getElementById('bridge-url'),
  reconnectBtn: document.getElementById('reconnect-btn'),
  flushBtn: document.getElementById('flush-btn'),
  clearBtn: document.getElementById('clear-btn'),
};

// ============================================================================
// State Management
// ============================================================================

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'CHECK_STATUS' });

    // Update connection status
    updateConnectionStatus(status.connectionStatus);

    // Update pending count
    elements.pendingCount.textContent = status.pendingCount || 0;

    // Update bridge URL
    if (status.bridgeUrl) {
      elements.bridgeUrl.value = status.bridgeUrl;
    }

    // Enable/disable buttons based on state
    elements.flushBtn.disabled = status.pendingCount === 0 || status.connectionStatus !== 'connected';
    elements.clearBtn.disabled = status.pendingCount === 0;
  } catch (error) {
    console.error('Failed to refresh status:', error);
    updateConnectionStatus('error');
  }
}

function updateConnectionStatus(status) {
  const statusMap = {
    connected: { class: 'connected', text: 'Connected' },
    disconnected: { class: 'disconnected', text: 'Disconnected' },
    error: { class: 'error', text: 'Error' },
    unauthorized: { class: 'error', text: 'Unauthorized' },
  };

  const state = statusMap[status] || statusMap.disconnected;
  elements.statusDot.className = `status-dot ${state.class}`;
  elements.statusText.textContent = state.text;
}

// ============================================================================
// Event Handlers
// ============================================================================

async function handleReconnect() {
  elements.reconnectBtn.disabled = true;
  elements.reconnectBtn.textContent = 'Connecting...';

  try {
    // Save the bridge URL if changed
    const newUrl = elements.bridgeUrl.value.trim();
    if (newUrl) {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { bridgeUrl: newUrl },
      });
    }

    const result = await chrome.runtime.sendMessage({ type: 'RECONNECT' });

    if (result.connected) {
      updateConnectionStatus('connected');
    } else {
      updateConnectionStatus('disconnected');
    }
  } catch (error) {
    console.error('Reconnect failed:', error);
    updateConnectionStatus('error');
  } finally {
    elements.reconnectBtn.disabled = false;
    elements.reconnectBtn.textContent = 'Reconnect';
    await refreshStatus();
  }
}

async function handleFlush() {
  elements.flushBtn.disabled = true;
  elements.flushBtn.textContent = 'Sending...';

  try {
    const result = await chrome.runtime.sendMessage({ type: 'FLUSH_PENDING' });

    if (result.remaining > 0) {
      elements.pendingCount.textContent = result.remaining;
    } else {
      elements.pendingCount.textContent = '0';
    }
  } catch (error) {
    console.error('Flush failed:', error);
  } finally {
    elements.flushBtn.textContent = 'Send Pending Data';
    await refreshStatus();
  }
}

async function handleClear() {
  if (!confirm('Are you sure you want to clear all pending data?')) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_PENDING' });
    elements.pendingCount.textContent = '0';
  } catch (error) {
    console.error('Clear failed:', error);
  } finally {
    await refreshStatus();
  }
}

// ============================================================================
// Initialization
// ============================================================================

function init() {
  // Set version from manifest
  elements.version.textContent = chrome.runtime.getManifest().version;

  // Attach event listeners
  elements.reconnectBtn.addEventListener('click', handleReconnect);
  elements.flushBtn.addEventListener('click', handleFlush);
  elements.clearBtn.addEventListener('click', handleClear);

  // Handle URL input changes
  elements.bridgeUrl.addEventListener('change', async () => {
    const newUrl = elements.bridgeUrl.value.trim();
    if (newUrl) {
      await chrome.runtime.sendMessage({
        type: 'UPDATE_SETTINGS',
        settings: { bridgeUrl: newUrl },
      });
    }
  });

  // Initial status refresh
  refreshStatus();

  // Refresh status periodically while popup is open
  setInterval(refreshStatus, 5000);
}

// Run initialization
document.addEventListener('DOMContentLoaded', init);
