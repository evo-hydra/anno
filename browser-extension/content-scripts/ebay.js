/**
 * Anno Data Capture - eBay Content Script
 *
 * Extracts purchase history data from eBay purchase history pages.
 * Runs in the user's authenticated session context.
 */

// ============================================================================
// Constants
// ============================================================================

const SELECTORS = {
  // Order containers
  orderCard: '.m-order-card, [data-test-id="order-card"], .purchase-history-item',

  // Order info
  orderId: '[data-test-id="order-id"], .order-id, a[href*="ord-details"]',
  orderDate: '[data-test-id="order-date"], .order-date, .date-col',
  orderStatus: '[data-test-id="order-status"], .order-status, .status-label',

  // Item info
  itemContainer: '.m-order-line-item, .line-item, .item-row',
  itemTitle: '.item-title, .item-name a, a[href*="/itm/"]',
  itemPrice: '.item-price, .price-col, [data-test-id="item-price"]',
  itemQuantity: '.item-quantity, .quantity-col, [data-test-id="quantity"]',
  itemImage: '.item-image img, .photo-area img',
  itemNumber: 'a[href*="/itm/"], [data-test-id="item-number"]',

  // Seller info
  sellerName: '.seller-name, [data-test-id="seller-name"], a[href*="/usr/"]',
  sellerRating: '.seller-rating, [data-test-id="seller-rating"]',

  // Order totals
  orderTotal: '.order-total, [data-test-id="order-total"], .total-price',
  shippingCost: '.shipping-cost, [data-test-id="shipping-cost"]',

  // Tracking
  trackingNumber: 'a[href*="track"], [data-test-id="tracking-link"]',
  deliveryStatus: '.delivery-status, [data-test-id="delivery-status"]',
};

// ============================================================================
// Data Extraction
// ============================================================================

/**
 * Extract eBay item number from URL
 */
function extractItemNumber(url) {
  if (!url) return null;
  const match = url.match(/\/itm\/(?:[^/]+\/)?(\d+)/);
  return match ? match[1] : null;
}

/**
 * Parse price string to number
 */
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^\d.,]/g, '');
  const normalized = cleaned.includes(',') && cleaned.includes('.')
    ? cleaned.indexOf(',') < cleaned.indexOf('.')
      ? cleaned.replace(',', '')
      : cleaned.replace('.', '').replace(',', '.')
    : cleaned.replace(',', '.');
  const amount = parseFloat(normalized);
  return isNaN(amount) ? null : amount;
}

/**
 * Detect currency from price string or page locale
 */
function detectCurrency(priceStr) {
  if (!priceStr) return 'USD';
  if (priceStr.includes('$') && !priceStr.includes('C$') && !priceStr.includes('AU$')) return 'USD';
  if (priceStr.includes('£')) return 'GBP';
  if (priceStr.includes('€')) return 'EUR';
  if (priceStr.includes('C$')) return 'CAD';
  if (priceStr.includes('AU$')) return 'AUD';

  // Fallback to page locale
  const hostname = window.location.hostname;
  if (hostname.includes('.co.uk')) return 'GBP';
  if (hostname.includes('.de') || hostname.includes('.fr') || hostname.includes('.it') || hostname.includes('.es'))
    return 'EUR';
  return 'USD';
}

/**
 * Parse date from various eBay formats
 */
function parseOrderDate(dateStr) {
  if (!dateStr) return null;
  // Try to normalize the date string
  const cleaned = dateStr.replace(/Purchased|on|:/gi, '').trim();
  try {
    const date = new Date(cleaned);
    return isNaN(date.getTime()) ? dateStr : date.toISOString();
  } catch {
    return dateStr;
  }
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
    const orderLink = orderElement.querySelector('a[href*="ord-details"]');
    if (orderLink) {
      const match = orderLink.href.match(/orderId=(\d+)/);
      orderId = match ? match[1] : null;
    }
  }

  // Extract order date
  const orderDateStr = getText(SELECTORS.orderDate);
  const orderDate = parseOrderDate(orderDateStr);

  // Extract order status
  const status = getText(SELECTORS.orderStatus);

  // Extract order total
  const totalText = getText(SELECTORS.orderTotal);
  const totalAmount = parsePrice(totalText);

  // Extract shipping cost
  const shippingText = getText(SELECTORS.shippingCost);
  const shippingAmount = parsePrice(shippingText);

  // Extract seller info
  const sellerName = getText(SELECTORS.sellerName);
  const sellerRating = getText(SELECTORS.sellerRating);

  // Extract items
  const items = [];
  const itemElements = orderElement.querySelectorAll(SELECTORS.itemContainer);

  // If no separate item containers, treat the order as single item
  const elementsToProcess = itemElements.length > 0 ? itemElements : [orderElement];

  for (const itemEl of elementsToProcess) {
    const titleEl = itemEl.querySelector(SELECTORS.itemTitle);
    const title = titleEl ? titleEl.textContent.trim() : null;
    const productUrl = titleEl?.href || getAttr(SELECTORS.itemNumber, 'href');
    const itemNumber = extractItemNumber(productUrl);

    const priceText = itemEl.querySelector(SELECTORS.itemPrice)?.textContent.trim();
    const price = parsePrice(priceText);
    const currency = detectCurrency(priceText);

    const imageUrl = getAttr(SELECTORS.itemImage, 'src');

    // Extract quantity
    let quantity = 1;
    const qtyText = getText(SELECTORS.itemQuantity);
    if (qtyText) {
      const qtyMatch = qtyText.match(/(?:Qty|Quantity)[:\s]*(\d+)/i);
      if (qtyMatch) quantity = parseInt(qtyMatch[1], 10);
      else {
        const numMatch = qtyText.match(/^(\d+)$/);
        if (numMatch) quantity = parseInt(numMatch[1], 10);
      }
    }

    if (title || itemNumber) {
      items.push({
        title: title || `Item #${itemNumber}`,
        itemNumber,
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

  // Extract tracking info
  const trackingUrl = getAttr(SELECTORS.trackingNumber, 'href');
  const deliveryStatus = getText(SELECTORS.deliveryStatus);

  return {
    orderId,
    orderDate,
    status,
    total: totalAmount
      ? {
          amount: totalAmount,
          currency: detectCurrency(totalText),
        }
      : null,
    shipping: shippingAmount
      ? {
          amount: shippingAmount,
          currency: detectCurrency(shippingText),
        }
      : null,
    seller: {
      name: sellerName,
      rating: sellerRating,
    },
    items,
    deliveryStatus,
    trackingUrl,
    marketplace: 'ebay',
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
      if (orderData.orderId || orderData.items.length > 0) {
        orders.push(orderData);
      }
    } catch (error) {
      console.warn('[Anno] Failed to extract eBay order:', error);
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
    console.log('[Anno] No eBay orders to capture');
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'CAPTURED_DATA',
      marketplace: 'ebay',
      dataType: 'purchases',
      items: orders,
    });

    console.log(`[Anno] Captured ${orders.length} eBay orders:`, response);
    showNotification(`Captured ${orders.length} purchases`, response.success ? 'success' : 'queued');
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
  button.textContent = 'Capture Purchases';
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
    button.textContent = 'Capture Purchases';
    button.style.background = '#3b82f6';
  });

  document.body.appendChild(button);
}

// ============================================================================
// Initialization
// ============================================================================

function init() {
  console.log('[Anno] eBay content script loaded');

  // Wait for page to stabilize
  setTimeout(() => {
    addCaptureButton();
  }, 1000);
}

// Run initialization
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
