const crypto = require("crypto");
const webPush = require("./web-push.cjs");

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const alerts = new Map();
const listeners = new Map();
const pushSubscriptions = new Map();
let pushTransport = webPush.send;
let lastResetDate = "";
function shopAlerts(shop) {
  if (!alerts.has(shop)) alerts.set(shop, []);
  return alerts.get(shop);
}

function safeText(value, max = 300) {
  return String(value || "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeDetailText(value, max = 300) {
  return safeText(value, max).replace(/\$\s*\d[\d,.]*(?:\s*USD)?/gi, "").replace(/\bUSD\s*\d[\d,.]*/gi, "").replace(/\s+/g, " ").trim();
}

function safeNote(value) {
  const note = safeDetailText(value, 500).replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, "[phone omitted]");
  return /\b(?:payment|tender|card|token|secret|subtotal|tax|tip|total)\b/i.test(note) ? "" : note;
}

function safeItems(items) {
  return (Array.isArray(items) ? items : []).slice(0, 100).map((entry) => ({
    item: safeDetailText(entry?.item || "Item", 200),
    modifiers: (Array.isArray(entry?.modifiers) ? entry.modifiers : []).slice(0, 100).map((m) => safeDetailText(m, 200))
  }));
}

function safePhone(value) {
  return safeText(value, 40);
}

function notify(shop) {
  for (const listener of listeners.get(shop) || []) listener();
}

function shopPushSubscriptions(shop) {
  const numericShop = Number(shop);
  if (!pushSubscriptions.has(numericShop)) pushSubscriptions.set(numericShop, new Map());
  return pushSubscriptions.get(numericShop);
}

function registerPushSubscription(shop, subscription) {
  const numericShop = Number(shop);
  const endpoint = safeText(subscription?.endpoint, 2000);
  const p256dh = safeText(subscription?.keys?.p256dh, 200);
  const auth = safeText(subscription?.keys?.auth, 100);
  if (!Number.isInteger(numericShop) || numericShop < 1 || !endpoint || !p256dh || !auth) throw new Error("Invalid push subscription");
  const record = { endpoint, expirationTime: subscription.expirationTime || null, keys: { p256dh, auth } };
  for (const subscriptions of pushSubscriptions.values()) subscriptions.delete(endpoint);
  shopPushSubscriptions(numericShop).set(endpoint, record);
  return record;
}

function removePushSubscription(shop, endpoint) { return shopPushSubscriptions(Number(shop)).delete(String(endpoint)); }
function getPushSubscriptions(shop) { return Array.from(shopPushSubscriptions(Number(shop)).values()).map(value => ({ ...value, keys: { ...value.keys } })); }

function buildWebPushPayload(record) {
  return { title: `New Order - Shop #${record.shop}`, body: `${record.customer || "Customer"}\n${record.source} - ${record.type}`, shop: record.shop, order: record.id };
}

async function sendWebPush(record) {
  const payload = buildWebPushPayload(record);
  await Promise.all(getPushSubscriptions(record.shop).map(async (subscription) => {
    try {
      const response = await pushTransport(subscription, payload);
      if ([404, 410].includes(response?.statusCode)) removePushSubscription(record.shop, subscription.endpoint);
    } catch (error) { console.error(`Web Push delivery failed: ${error.message}`); }
  }));
}

function pruneOldAlerts(now = Date.now()) {
  for (const [shop, records] of alerts) {
    const kept = records.filter((record) => now - new Date(record.createdAt).getTime() < MAX_AGE_MS);
    if (kept.length !== records.length) {
      alerts.set(shop, kept);
      notify(shop);
    }
  }
}

function createShopAlert(data) {
  pruneOldAlerts();
  const shop = Number(data.shop);
  if (!Number.isInteger(shop) || shop < 1) throw new Error("Invalid shop");
  const source = safeText(data.source, 60);
  if (!source) return null;
  const jobReference = safeText(data.jobReference, 100);
  const records = shopAlerts(shop);
  if (jobReference) {
    const existing = records.find((record) => record.jobReference === jobReference);
    if (existing) return existing;
  }
  const record = {
    id: crypto.randomBytes(12).toString("hex"), shop,
    createdAt: data.createdAt || new Date().toISOString(),
    source,
    type: data.type === "Delivery" ? "Delivery" : "Pickup",
    customer: /^(?:online order)$/i.test(safeText(data.customer, 100)) ? "" : safeText(data.customer, 100),
    reference: safeText(data.reference, 100), orderedTime: safeText(data.orderedTime, 100),
    scheduleType: safeText(data.scheduleType, 40), scheduledTime: safeText(data.scheduledTime, 100),
    customerPhone: safePhone(data.customerPhone), courierPhone: safePhone(data.courierPhone),
    customerNote: safeNote(data.customerNote), fulfillmentNote: safeNote(data.fulfillmentNote),
    items: safeItems(data.items), status: "active", completedAt: null,
    acknowledged: false, acknowledgedAt: null, jobReference
  };
  records.unshift(record);
  notify(shop);
  void sendWebPush(record);
  return record;
}

function setShopAlertStatus(shop, id, status, now = new Date()) {
  pruneOldAlerts(now.getTime());
  if (status !== "active" && status !== "complete") throw new Error("Invalid alert status");
  const numericShop = Number(shop);
  const record = shopAlerts(numericShop).find((entry) => entry.id === id);
  if (!record) return null;
  if (record.status !== status) {
    record.status = status;
    record.completedAt = status === "complete" ? now.toISOString() : null;
    if (status === "complete" && !record.acknowledged) {
      record.acknowledged = true;
      record.acknowledgedAt = now.toISOString();
    }
    notify(numericShop);
  }
  return record;
}

function acknowledgeShopAlert(shop, id, now = new Date()) {
  pruneOldAlerts(now.getTime());
  const record = shopAlerts(Number(shop)).find((entry) => entry.id === id);
  if (!record) return null;
  if (!record.acknowledged) {
    record.acknowledged = true;
    record.acknowledgedAt = now.toISOString();
    notify(Number(shop));
  }
  return record;
}

function getShopAlerts(shop, now = Date.now()) {
  pruneOldAlerts(now);
  return shopAlerts(Number(shop)).map((record) => ({ ...record, items: record.items.map((item) => ({ ...item, modifiers: [...item.modifiers] })) }));
}

function resetAlertHistory(localTimestamp = "") {
  alerts.clear();
  for (const shop of listeners.keys()) notify(shop);
  console.log(`ALERT HISTORY RESET - ${localTimestamp}`);
}

function localParts(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).reduce((out, part) => (out[part.type] = part.value, out), {});
}

function runAlertMaintenance(now = new Date(), timeZone = "America/Chicago") {
  pruneOldAlerts(now.getTime());
  const parts = localParts(now, timeZone);
  const dateKey = `${parts.year}-${parts.month}-${parts.day}`;
  if (parts.hour === "01" && lastResetDate !== dateKey) {
    lastResetDate = dateKey;
    resetAlertHistory(`${dateKey} 1:${parts.minute} AM`);
    return true;
  }
  return false;
}

function subscribe(shop, listener) {
  if (!listeners.has(shop)) listeners.set(shop, new Set());
  listeners.get(shop).add(listener);
  return () => listeners.get(shop)?.delete(listener);
}

function _clearForTests() { alerts.clear(); pushSubscriptions.clear(); pushTransport = webPush.send; lastResetDate = ""; }
function _setPushTransportForTests(transport) { pushTransport = transport; }

module.exports = { createShopAlert, acknowledgeShopAlert, setShopAlertStatus, getShopAlerts, resetAlertHistory, pruneOldAlerts, runAlertMaintenance, registerPushSubscription, removePushSubscription, getPushSubscriptions, buildWebPushPayload, sendWebPush, subscribe, _clearForTests, _setPushTransportForTests, MAX_AGE_MS };
