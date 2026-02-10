/**
 * Anno Data Capture - Amazon Content Script
 *
 * Extracts order data from Amazon order history pages.
 * Runs in the user's authenticated session context.
 */

// ============================================================================
// Constants
// ============================================================================

const SELECTORS = {
  // Order containers
  orderCard: '.order-card, .order, [data-component="orderCard"]',
  orderHeader: '.order-header, .a-box-inner',

  // Order info
  orderId: '[data-test-id="order-id"], .yohtmlc-order-id, a[href*="order-details"]',
  orderDate: '[data-test-id="order-date"], .order-info .value, .a-color-secondary',
  orderTotal: '.yohtmlc-order-total .value, .a-text-bold',

  // Item info
  itemRow: '.yohtmlc-item, .shipment .a-fixed-left-grid',
  itemTitle: '.yohtmlc-product-title, a[href*="/dp/"], a[href*="/gp/product/"]',
  itemPrice: '.yohtmlc-price, .a-color-price',
  itemQuantity: '.product-image + .a-row, .item-view-qty',
  itemImage: '.product-image img, .item-view-left-col-inner img',
  itemAsin: 'a[href*="/dp/"], a[href*="/gp/product/"]',

  // Shipping info
  shippingStatus: '.delivery-box .a-row, .shipment-status',
  trackingNumber: 'a[href*="track"], [data-test-id="tracking-link"]',

  // Pagination
  paginationNext: '.a-pagination .a-last a, [data-action="pagination-next"]',
};

// ============================================================================
// Data Extraction
// ============================================================================

/**
 * Extract ASIN from Amazon URL
 */
function extractAsin(url) {
  if (!url) return null;
  const dpMatch = url.match(/\/dp\/([A-Z0-9]{10})/);
  if (dpMatch) return dpMatch[1];
  const productMatch = url.match(/\/gp\/product\/([A-Z0-9]{10})/);
  if (productMatch) return productMatch[1];
  return null;
}

/**
 * Parse price string to number
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^\d.,]/g, '');
  // Handle different locales (1,234.56 vs 1.234,56)
  const normalized = cleaned.includes(',') && cleaned.includes('.')
    ? cleaned.indexOf(',') < cleaned.indexOf('.')
      ? cleaned.replace(',', '') // US format: 1,234.56 -> 1234.56
      : cleaned.replace('.', '').replace(',', '.') // EU format: 1.234,56 -> 1234.56
    : cleaned.replace(',', '.');
  const amount = parseFloat(normalized);
  return isNaN(amount) ? null : amount;
}

/**
 * Detect currency from price string or page locale
 */
function detectCurrency(priceStr) {
  if (!priceStr) return 'USD';
  if (priceStr.includes('$')) return 'USD';
  if (priceStr.includes('£')) return 'GBP';
  if (priceStr.includes('€')) return 'EUR';
  if (priceStr.includes('¥')) return 'JPY';
  if (priceStr.includes('CA$')) return 'CAD';

  // Fallback to page locale
  const hostname = window.location.hostname;
  if (hostname.includes('.co.uk')) return 'GBP';
  if (hostname.includes('.de') || hostname.includes('.fr') || hostname.includes('.it') || hostname.includes('.es'))
    return 'EUR';
  if (hostname.includes('.co.jp')) return 'JPY';
  if (hostname.includes('.ca')) return 'CAD';
  return 'USD';
}

/**
 * Extract data from a single order card
 */
function extractOrderData(orderElement) {
  const getText = (selector) => {
    const el = orderElement.querySelector(selector);
    return el ? el.textContent.trim() : null;
  };

  const getAttr = (selector, attr) => {
    const el = orderElement.querySelector(selector);
    return el ? el.getAttribute(attr) : null;
  };

  // Extract order ID
  let orderId = getText(SELECTORS.orderId);
  if (!orderId) {
    const orderLink = orderElement.querySelector('a[href*="order-details"]');
    if (orderLink) {
      const match = orderLink.href.match(/orderID=([0-9-]+)/);
      orderId = match ? match[1] : null;
    }
  }

  // Extract order date
  let orderDate = getText(SELECTORS.orderDate);
  // Try to parse various date formats
  if (orderDate) {
    // Remove "Ordered" prefix if present
    orderDate = orderDate.replace(/^Ordered\s*/i, '');
  }

  // Extract order total
  const totalText = getText(SELECTORS.orderTotal);
  const totalAmount = parsePrice(totalText);

  // Extract items
  const items = [];
  const itemElements = orderElement.querySelectorAll(SELECTORS.itemRow);

  for (const itemEl of itemElements) {
    const titleEl = itemEl.querySelector(SELECTORS.itemTitle);
    const title = titleEl ? titleEl.textContent.trim() : null;
    const productUrl = titleEl ? titleEl.href : null;
    const asin = extractAsin(productUrl);

    const priceText = itemEl.querySelector(SELECTORS.itemPrice)?.textContent.trim();
    const price = parsePrice(priceText);
    const currency = detectCurrency(priceText);

    const imageUrl = getAttr(SELECTORS.itemImage, 'src');

    // Try to extract quantity
    let quantity = 1;
    const qtyText = itemEl.querySelector(SELECTORS.itemQuantity)?.textContent;
    if (qtyText) {
      const qtyMatch = qtyText.match(/(?:Qty|Quantity)[:\s]*(\d+)/i);
      if (qtyMatch) quantity = parseInt(qtyMatch[1], 10);
    }

    if (title) {
      items.push({
        title,
        asin,
        productUrl,
        price: price
          ? {
              amount: price,
              currency,
            }
          : null,
        quantity,
        imageUrl,
      });
    }
  }

  // Extract shipping status
  const shippingStatus = getText(SELECTORS.shippingStatus);
  const trackingUrl = getAttr(SELECTORS.trackingNumber, 'href');

  return {
    orderId,
    orderDate,
    total: totalAmount
      ? {
          amount: totalAmount,
          currency: detectCurrency(totalText),
        }
      : null,
    items,
    shippingStatus,
    trackingUrl,
    marketplace: 'amazon',
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Extract all orders from current page
 */
function extractAllOrders() {
  const orderElements = document.querySelectorAll(SELECTORS.orderCard);
  const orders = [];

  for (const orderEl of orderElements) {
    try {
      const orderData = extractOrderData(orderEl);
      if (orderData.orderId && orderData.items.length > 0) {
        orders.push(orderData);
      }
    } catch (error) {
      console.warn('[Anno] Failed to extract order:', error);
    }
  }

  return orders;
}

// ============================================================================
// Communication
// ============================================================================

/**
 * Send captured data to background script
 */
async function sendCapturedData(orders) {
  if (orders.length === 0) {
    console.log('[Anno] No orders to capture');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURED_DATA',
      marketplace: 'amazon',
      dataType: 'orders',
      items: orders,
    });

    console.log(`[Anno] Captured ${orders.length} Amazon orders:`, response);
    showNotification(`Captured ${orders.length} orders`, response.success ? 'success' : 'queued');
  } catch (error) {
    console.error('[Anno] Failed to send captured data:', error);
    showNotification('Capture failed', 'error');
  }
}

// ============================================================================
// UI Feedback
// ============================================================================

/**
 * Show capture notification
 */
function showNotification(message, type) {
  const colors = {
    success: '#22c55e',
    queued: '#f59e0b',
    error: '#ef4444',
  };

  const notification = document.createElement('div');
  notification.id = 'anno-notification';
  notification.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 20px;
    background: ${colors[type] || colors.success};
    color: white;
    border-radius: 8px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 999999;
    opacity: 0;
    transform: translateY(10px);
    transition: all 0.3s ease;
  `;
  notification.textContent = `Anno: ${message}`;

  // Remove existing notification
  document.getElementById('anno-notification')?.remove();

  document.body.appendChild(notification);

  // Animate in
  requestAnimationFrame(() => {
    notification.style.opacity = '1';
    notification.style.transform = 'translateY(0)';
  });

  // Auto-remove after 3 seconds
  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transform = 'translateY(10px)';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

/**
 * Add capture button to page
 */
function addCaptureButton() {
  if (document.getElementById('anno-capture-btn')) return;

  const button = document.createElement('button');
  button.id = 'anno-capture-btn';
  button.textContent = 'Capture Orders';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    left: 20px;
    padding: 10px 20px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 8px;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    z-index: 999998;
    transition: all 0.2s ease;
  `;

  button.addEventListener('mouseover', () => {
    button.style.background = '#2563eb';
    button.style.transform = 'scale(1.02)';
  });

  button.addEventListener('mouseout', () => {
    button.style.background = '#3b82f6';
    button.style.transform = 'scale(1)';
  });

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Capturing...';
    button.style.background = '#6b7280';

    const orders = extractAllOrders();
    await sendCapturedData(orders);

    button.disabled = false;
    button.textContent = 'Capture Orders';
    button.style.background = '#3b82f6';
  });

  document.body.appendChild(button);
}

// ============================================================================
// Initialization
// ============================================================================

function init() {
  console.log('[Anno] Amazon content script loaded');

  // Wait for page to stabilize
  setTimeout(() => {
    addCaptureButton();

    // Optional: Auto-capture on page load
    // const orders = extractAllOrders();
    // if (orders.length > 0) {
    //   sendCapturedData(orders);
    // }
  }, 1000);
}

// Run initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
