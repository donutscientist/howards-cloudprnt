const cheerio = require("cheerio");
const crypto = require("crypto");
const https = require("https");
const express = require("express");
const { google } = require("googleapis");
const pdfParse = require("pdf-parse");
const path = require("path");
const alertSystem = require("./alert-system.cjs");

const app = express();

function businessTimeZone() {
  return process.env.BUSINESS_TZ || "America/Chicago";
}

function formatBusinessTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: businessTimeZone(),
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod}`;
}

app.use(express.raw({ type: "*/*" }));
app.use(express.static(path.join(__dirname, "public"), { index: false, maxAge: "1h" }));

// --------------------
// ADVANCED CLOUDPRNT QUEUE
// --------------------
let activeJobs = new Map(); // token -> { buf, metadata }
let pending = [];           // tokens FIFO

const routeQueues = new Map(); // route -> { activeJobs, pending }
const SQUARE_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const SQUARE_DEDUP_MAX_ENTRIES = 5000;
const queuedSquareOrders = new Map(); // orderId -> expiresAt, set only after successful queue add
const removalIdToJob = new Map(); // removalId -> { route, token }
const routeLabels = new Map();
const printerPollState = new Map();
const PRINTER_POLL_SECONDS = 5;
const EMAIL_POLL_MS = Number(process.env.EMAIL_POLL_MS || 5000);

let lastEmailPollAt = Date.now();
let emailStoppedLogged = false;

function normalizePrintRoute(route) {
  const raw = String(route || "").trim();
  if (!raw || raw === "/") return "";
  return raw.replace(/^\/+/, "").replace(/\/+$/, "");
}

function getRouteQueue(route) {
  const normalized = normalizePrintRoute(route);
  if (!routeQueues.has(normalized)) {
    routeQueues.set(normalized, { activeJobs: new Map(), pending: [] });
  }
  return routeQueues.get(normalized);
}

function createSafeId() {
  return crypto.randomBytes(8).toString("hex");
}

function enqueueReceipt(jobBuf, route = "", metadata = {}) {
  const id = createSafeId();
  const normalizedRoute = normalizePrintRoute(route);
  const safeMetadata = {
    createdAt: metadata.createdAt || new Date().toISOString(),
    routeLabel: metadata.routeLabel || routeLabelForRoute(normalizedRoute) || "#1",
    source: metadata.source || "Unknown",
    orderType: metadata.orderType || "Unknown",
    removalId: metadata.removalId || createSafeId()
  };
  const job = { buf: jobBuf, metadata: safeMetadata };

  if (normalizedRoute) {
    const queue = getRouteQueue(normalizedRoute);
    queue.activeJobs.set(id, job);
    queue.pending.push(id);
  } else {
    activeJobs.set(id, job);
    pending.push(id);
  }
  removalIdToJob.set(safeMetadata.removalId, { route: normalizedRoute, token: id });

  console.log("QUEUE ADDED:", id);

  return id;
}

// --------------------
// GMAIL AUTH
// --------------------
const auth = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);

auth.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth });

// --------------------
// HELPERS: BASE64URL + QUOTED-PRINTABLE
// --------------------
function decodeBase64Url(data) {
  return Buffer.from(
    data
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(data.length + (4 - (data.length % 4)) % 4, "="),
    "base64"
  ).toString("utf8");
}

// --------------------
// GET PART BY MIME
// --------------------
function findPart(payload, predicate) {
  function walk(part) {
    if (!part) return null;
    if (predicate(part)) return part;
    if (part.parts) {
      for (const p of part.parts) {
        const found = walk(p);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(payload);
}

function getPartText(payload, mimeType) {
  const part = findPart(payload, (p) => p.mimeType === mimeType && p.body?.data);
  if (!part) return "";
  return decodeBase64Url(part.body.data);
}

// Backward-compatible: keep your old behavior for GH (HTML)
function getHtmlBody(payload) {
  return getPartText(payload, "text/html");
}

////////////////////////////////////////////////////
// DOORDASH PDF PARSER
////////////////////////////////////////////////////
async function parseDoorDashPDF(msg) {

  function findPDF(part) {
    if (!part) return null;

    if (part.filename && part.filename.toLowerCase().endsWith(".pdf")) {
      return part.body.attachmentId;
    }

    if (part.parts) {
      for (const p of part.parts) {
        const r = findPDF(p);
        if (r) return r;
      }
    }

    return null;
  }

  try {

    const attachmentId = findPDF(msg.data.payload);
    if (!attachmentId) return null;

    const attachment = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: msg.data.id,
      id: attachmentId
    });

    const pdfBuffer = Buffer.from(
      attachment.data.data.replace(/-/g,"+").replace(/_/g,"/"),
      "base64"
    );

    const data = await pdfParse(pdfBuffer);
    const text = data.text || "";

const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

// DEBUG
console.log("DOORDASH RAW LINES:");
lines.forEach((l,i)=>console.log(i, l));

let customer = "DoorDash";
let phone = "";
let totalItems = "";
let items = [];
let current = null;

    for (let idx = 0; idx < lines.length; idx++) {

  const line = lines[idx];

      // PHONE
if (/\(\d{3}\)/.test(line)) {
  phone = line;

  // Look ahead for the "items" line after the phone
  for (let i = idx + 1; i < lines.length; i++) {

    if (/items/i.test(lines[i])) {

      const match = lines[i].match(/^(\d+)/);

      if (match) {
        totalItems = match[1];
      }

      break;
    }

  }
}

    

if (/subtotal|tax|total|\~ end/i.test(line)) continue;

if (/^\d+x/i.test(line)) {

  // look ahead until we hit "item"
  let valid = false;

for (let i = idx + 1; i < lines.length; i++) {

  // another item appears first → page break duplication
  if (/^\d+x/i.test(lines[i])) {
    break;
  }

  // proper item ending
  if (/item$/i.test(lines[i]) || /^\$/.test(lines[i])) {
    valid = true;
    break;
  }

}

  if (!valid) continue;

  let qty = line.match(/^(\d+)/)[1];

  let name = line
    .replace(/^\d+x/i,"")
    .replace(/\(in\s*\)\s*[A-Za-z\s]+/i,"")
    .replace(/\$\d+.*$/,"")
    .replace(/item$/i,"")
    .trim();

  current = {
    item: `${qty}x ${name}`,
    modifiers: [],
    category: /beverages/i.test(line) ? "Beverages" : ""
  };

  items.push(current);
  continue;
      }

      // MODIFIER
if (/^•/.test(line) && current) {

        if (line.includes("**")) continue;

let mod = line.replace(/^•\s*/,"").trim();

// remove title before colon
if (mod.includes(":")) {
  mod = mod.split(":").slice(1).join(":").trim();
}

// remove price
mod = mod.replace(/\(\+\s*\$[0-9.]+\)/g,"").trim();

// remove extra spaces
mod = mod.replace(/\s+/g," ").trim();

if (mod) current.modifiers.push(mod);
      }
    }

    // SORT BEVERAGES FIRST
    items.sort((a,b)=>{
      if(a.category === "Beverages" && b.category !== "Beverages") return -1;
      if(b.category === "Beverages" && a.category !== "Beverages") return 1;
      return 0;
    });

    return {
      customer,
      orderType: "DoorDash",
      phone,
      totalItems,
      items,
      estimate: "",
      note: ""
    };

  } catch (err) {
    console.log("DOORDASH ERROR:", err.message);
    return null;
  }
}

// --------------------
// GRUBHUB PARSER (unchanged from your working one)
// --------------------
function parseGrubHub(html) {
  const $ = cheerio.load(html);

  const hidden = $('[data-section="grubhub-order-data"]');

  let phone =
    hidden.find('[data-field="phone"]').text().trim() ||
    $('a[href^="tel:"]').first().text().trim();

  let service = hidden.find('[data-field="service-type"]').text().trim();
  let orderType =
    service.toLowerCase().includes("delivery") ? "GrubHub Delivery" :
    service.toLowerCase().includes("pickup") ? "GrubHub Pickup" :
    $('div:contains("Deliver to:")').length ? "GrubHub Delivery" :
    $('div:contains("Pickup by:")').length ? "GrubHub Pickup" :
    "GrubHub Pickup";

  let customer = "UNKNOWN";
  const deliverLabel = $("div").filter((i, el) => $(el).text().trim() === "Deliver to:").first();
  if (deliverLabel.length) {
    customer = deliverLabel.next("div").text().trim() || customer;
  } else {
    const pickupLabel = $("div").filter((i, el) => $(el).text().trim() === "Pickup by:").first();
    if (pickupLabel.length) customer = pickupLabel.next("div").text().trim() || customer;
  }


  const items = [];

  $("tr").each((i, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 3) return;

    const qtyTxt = $(tds[0]).text().replace(/\s+/g, " ").trim();
    const xTxt = $(tds[1]).text().replace(/\s+/g, " ").trim();
    const name = $(tds[2]).text().replace(/\s+/g, " ").trim();

    if (!/^\d+$/.test(qtyTxt)) return;
    if (xTxt.toLowerCase() !== "x") return;
    if (!name) return;

    const currentItem = { item: `${qtyTxt}x ${name}`, modifiers: [] };

    const next = $(tr).next("tr");
    next.find("li").each((j, li) => {
      let mod = $(li).text().replace(/\s+/g, " ").trim();
      mod = mod.replace(/^▪️/, "").replace(/^▪/, "").trim();
      if (mod) currentItem.modifiers.push(mod);
    });

    const counter = {};
    for (const m of currentItem.modifiers) counter[m] = (counter[m] || 0) + 1;
    currentItem.modifiers = Object.entries(counter).map(([n, q]) => (q === 1 ? n : `${q}x ${n}`));

    items.push(currentItem);
  });

  const totalItems = String(
  items.reduce((sum, i) => {
    const m = i.item.match(/^(\d+)x/);
    return sum + (m ? parseInt(m[1]) : 1);
  }, 0)
);

return { customer, orderType, phone, totalItems, items, estimate: "", note: "" };

}

// --------------------
// RECEIPT BUILDER
// NOTE placement: directly under Total Items
// --------------------

const COLS = 32;

// make printer-safe ASCII + remove control chars
function toAscii(s) {
  if (!s) return "";
  return String(s)
    .replace(/\u00A0/g, " ")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/×/g, "x")
    .replace(/[^\x20-\x7E]/g, "")     // strip non-ascii
    .replace(/[\x00-\x1F\x7F]/g, "")  // strip control
    .replace(/\s+/g, " ")
    .trim();
}

// HARD CUT (no wrap). Always <= 32 chars total INCLUDING indent.
function cut32(text, indent = "") {
  const t = toAscii(text);
  const usable = Math.max(0, COLS - indent.length);
  return indent + t.slice(0, usable);
}

function buildReceipt(customer, orderType, phone, totalItems, items, estimate = "", note = "", receiptDetails = {}) {
  const b = [];
  b.push(Buffer.from([0x1B, 0x40])); // ESC @

  // helper to push ONE printable line (never > 32)
  const line = (txt, indent = "") => b.push(Buffer.from(cut32(txt, indent) + "\n", "ascii"));

  // Header (ALL CUT TO 32)
  b.push(Buffer.from([0x1B, 0x45, 0x01])); line(customer, "   ");  b.push(Buffer.from([0x1B, 0x45, 0x00]));
  b.push(Buffer.from([0x1B, 0x45, 0x01])); line("---------------");  b.push(Buffer.from([0x1B, 0x45, 0x00]));
  b.push(Buffer.from([0x1B, 0x45, 0x01])); line(orderType, "   "); b.push(Buffer.from([0x1B, 0x45, 0x00]));

  if (phone) {
    b.push(Buffer.from([0x1B, 0x45, 0x01])); line(phone, "   "); b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  b.push(Buffer.from([0x1B, 0x45, 0x01])); line(`Total Items: ${totalItems}`, "   "); b.push(Buffer.from([0x1B, 0x45, 0x00]));

  if (note) {
    b.push(Buffer.from([0x1B, 0x45, 0x01]));
    line(`NOTE: ${note}`, "   "); // also hard-cut
    b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  if (estimate) {
    b.push(Buffer.from([0x1B, 0x45, 0x01])); line(estimate, "   "); b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  if (receiptDetails.schedule) {
    b.push(Buffer.from([0x1B, 0x45, 0x01])); line(`Schedule: ${receiptDetails.schedule}`); b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }
  if (receiptDetails.orderedOn) {
    b.push(Buffer.from([0x1B, 0x45, 0x01])); line(`Ordered on: ${receiptDetails.orderedOn}`); b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }
  if (receiptDetails.scheduledFor) {
    b.push(Buffer.from([0x1B, 0x45, 0x01])); line(`Scheduled for: ${receiptDetails.scheduledFor}`); b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  // Items + modifiers
  for (const order of items) {
    b.push(Buffer.from("\n"));

    // ITEM: keep your indentation + styles, but still hard-cut
    b.push(Buffer.from([0x1B, 0x45, 0x01])); // bold
    b.push(Buffer.from([0x1B, 0x2D, 0x01])); // underline
    line(order.item, "   "); // <-- item indent (change to "  " if you want 2 spaces)
    b.push(Buffer.from([0x1B, 0x2D, 0x00])); // underline off
    b.push(Buffer.from([0x1B, 0x45, 0x00])); // bold off

    // MODS: 4-space indent, hard-cut
    for (const mod of order.modifiers || []) {
      line(mod, "      ");
    }
  }

  b.push(Buffer.from("\n"));

// END OF ORDER LINE
b.push(Buffer.from([0x1B, 0x45, 0x01])); // bold
line("--End of Order--", "       ");
b.push(Buffer.from([0x1B, 0x45, 0x00])); // bold off

b.push(Buffer.from("\n"));
b.push(Buffer.from([0x1B, 0x64, 0x03])); // feed 3
b.push(Buffer.from([0x1D, 0x56, 0x00])); // cut
return Buffer.concat(b);
}

// --------------------
// CHECK EMAIL (GRUBHUB + DOORDASH)
// --------------------
async function checkEmail() {
  try {
    
    if (emailStoppedLogged) {
  console.log("Email polling resumes");
}

lastEmailPollAt = Date.now();
emailStoppedLogged = false;


    const gh = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread label:GH_PRINT",
      maxResults: 1
    });

    const dd = await gmail.users.messages.list({
  userId: "me",
  q: "is:unread label:DD_PRINT",
  maxResults: 1
});

    let messageId = null;
    let platform = null;

    if (gh.data.messages?.length) {
  messageId = gh.data.messages[0].id;
  platform = "GH";
} 
else if (dd.data.messages?.length) {
  messageId = dd.data.messages[0].id;
  platform = "DD";
}
else {
  return;
}

    console.log("EMAIL FOUND:", platform);

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full"
    });

    let parsed = null;

    if (platform === "GH") {

  const headers = msg.data.payload.headers;

  const subject =
    headers.find(h => h.name === "Subject")?.value || "";

  // Extract order ID
  let orderId = "";
  const match = subject.match(/Order\s*([0-9\-]+)/i);
  if (match) {
    orderId = match[1];
  }

  const html = getHtmlBody(msg.data.payload)
    .replace(/\u00A0/g, " ")
    .replace(/\t/g, " ")
    .replace(/\r/g, "")
    .replace(/[ ]+/g, " ");

  parsed = parseGrubHub(html);

  if (parsed && orderId) {
    parsed.phone = `Order #${orderId}`;
  }
}

if (platform === "DD") {

  const headers = msg.data.payload.headers;

  const subject =
    headers.find(h => h.name === "Subject")?.value || "";

  // CUSTOMER NAME
  let customer = "DoorDash";
  const nameMatch = subject.match(/order from (.+?) for/i);
  if (nameMatch) {
    customer = nameMatch[1].trim();
  }

  // ORDER TYPE
  let orderType = "DoorDash Pickup";
  if (/delivery/i.test(subject)) {
    orderType = "DoorDash Delivery";
  }

  // ORDER ID
  let orderId = "";
  const idMatch = subject.match(/Order\s*#\s*([A-Za-z0-9]+)/i);
  if (idMatch) {
    orderId = idMatch[1];
  }

  const parsedDD = await parseDoorDashPDF(msg);

  if (parsedDD) {
    parsedDD.customer = customer;
    parsedDD.orderType = orderType;

    if (orderId) {
      parsedDD.phone = `Order #${orderId}`;
    }

    parsed = parsedDD;
  }
}
    if (!parsed) return;

    const jobBuf = buildReceipt(
      parsed.customer,
      parsed.orderType,
      parsed.phone,
      parsed.totalItems,
      parsed.items,
      parsed.estimate,
      parsed.note
    );

    const printJobId = enqueueReceipt(jobBuf, "", { source: platform === "GH" ? "GrubHub" : "DoorDash", orderType: (parsed.orderType || "").includes("Delivery") ? "Delivery" : "Pickup" });
    alertSystem.createShopAlert({
      shop: 1, jobReference: `email:${messageId}`, source: platform === "GH" ? "GrubHub" : "DoorDash",
      type: (parsed.orderType || "").includes("Delivery") ? "Delivery" : "Pickup",
      customer: parsed.customer, reference: String(parsed.phone || "").replace(/^Order\s*#/i, "").trim(),
      items: parsed.items, customerNote: parsed.note
    });

    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] }
    });

    console.log("PRINT JOB ADDED");
  } catch (e) {
    console.log("CHECK EMAIL ERROR:", e.message);
  }
}


// --------------------
// SQUARE WEBHOOK ORDER PRINTING
// Printable rule: order.created events queue open orders once per 24 hours after queue success.
// --------------------

function pruneSquareDedup(now = Date.now()) {
  for (const [orderId, expiresAt] of queuedSquareOrders) {
    if (expiresAt <= now) queuedSquareOrders.delete(orderId);
  }
  while (queuedSquareOrders.size > SQUARE_DEDUP_MAX_ENTRIES) {
    queuedSquareOrders.delete(queuedSquareOrders.keys().next().value);
  }
}

function hasQueuedSquareOrder(orderId) {
  pruneSquareDedup();
  return queuedSquareOrders.has(orderId);
}

function markSquareQueued(orderId) {
  if (!orderId) return;
  pruneSquareDedup();
  queuedSquareOrders.set(orderId, Date.now() + SQUARE_DEDUP_TTL_MS);
}

function formatSquareQuantity(value, fallback = 1) {
  const n = Number.parseFloat(String(value ?? "").trim());
  const safe = Number.isFinite(n) && n > 0 ? n : fallback;
  return Number.isInteger(safe) ? String(safe) : String(Number(safe.toFixed(3)));
}

function normalizeSquareSource(value) {
  const text = String(value || "").toLowerCase();
  if (/uber\s*eats|ubereats|uber/.test(text)) return "UberEats";
  if (/door\s*dash|doordash/.test(text)) return "DoorDash";
  if (/grub\s*hub|grubhub/.test(text)) return "GrubHub";
  return null;
}

function detectSquareSource(order) {
  const candidates = [
    order?.source?.name,
    ...(order?.tenders || []).map(tender => tender?.other_details?.source),
    ...(order?.fulfillments || []).map(fulfillment => fulfillment?.delivery_details?.courier_provider_name),
    typeof order?.source === "string" ? order.source : "",
    order?.application_details?.application_name,
    order?.application_details?.square_product,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSquareSource(candidate);
    if (normalized) return normalized;
  }
  return "Online Order";
}

function detectSquareFulfillment(order) {
  for (const f of order?.fulfillments || []) {
    if (f?.type === "DELIVERY" || f?.delivery_details) return "Delivery";
    if (f?.type === "PICKUP" || f?.pickup_details) return "Pickup";
  }
  return null;
}

function getSquareNotificationUrl() {
  return process.env.SQ_URL;
}

function verifySquareSignature(req, rawBodyBuffer) {
  const signatureKey = process.env.SQ_SIGNATURE;
  const notificationUrl = getSquareNotificationUrl();
  const signature = req.get("x-square-hmacsha256-signature") || "";

  if (!signatureKey || !notificationUrl || !signature || !Buffer.isBuffer(rawBodyBuffer)) return false;

  const payload = Buffer.concat([Buffer.from(notificationUrl, "utf8"), rawBodyBuffer]);
  const expected = crypto
    .createHmac("sha256", signatureKey)
    .update(payload)
    .digest("base64");

  const expectedBuf = Buffer.from(expected, "base64");
  const signatureBuf = Buffer.from(signature, "base64");

  return expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function logSquareApiError({ requestUrl, statusCode, responseBody }) {
  let squareError = null;

  try {
    const parsed = JSON.parse(responseBody);
    squareError = Array.isArray(parsed?.errors) ? parsed.errors[0] : null;
  } catch (err) {
    squareError = null;
  }

  console.error("Square Orders API request failed", {
    requestUrl,
    status: statusCode,
    safeDetail: String(squareError?.detail || responseBody || "").slice(0, 180),
    squareErrorCode: squareError?.code,
    squareErrorCategory: squareError?.category,
    squareErrorDetail: squareError?.detail
  });
}

function squareApiGet(path, { logErrors = true } = {}) {
  if (process.env.SQ_TEST_ORDER_JSON) {
    return Promise.resolve(JSON.parse(process.env.SQ_TEST_ORDER_JSON));
  }

  return new Promise((resolve, reject) => {
    const environment = String(process.env.SQ_ENVIRONMENT || "production").toLowerCase();
    const hostname = environment === "sandbox" ? "connect.squareupsandbox.com" : "connect.squareup.com";
    const requestUrl = `https://${hostname}${path}`;

    const req = https.request({
      method: "GET",
      hostname,
      path,
      headers: {
        "Authorization": `Bearer ${process.env.SQ_TOKEN}`,
        "Square-Version": "2026-07-16",
        "Content-Type": "application/json"
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          if (logErrors) logSquareApiError({ requestUrl, statusCode: res.statusCode, responseBody: data });
          return reject(new Error(`Square API ${res.statusCode}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function getSquareOrderId(event) {
  return event?.data?.object?.order_created?.order_id || event?.data?.object?.order?.id || event?.data?.id;
}

function getSquareFulfillmentDetails(order) {
  for (const fulfillment of order.fulfillments || []) {
    const details = fulfillment.pickup_details || fulfillment.delivery_details || fulfillment.shipment_details;
    if (details) return { fulfillment, details };
  }
  return { fulfillment: {}, details: {} };
}

function getSquareRecipient(order) {
  const { details } = getSquareFulfillmentDetails(order);
  return order.ticket_name || details?.recipient?.display_name || order.customer_id || "Online Order";
}

function getSquareOrderType(order) {
  const source = detectSquareSource(order);
  const fulfillmentType = detectSquareFulfillment(order) || "Pickup";
  return `${source} ${fulfillmentType}`;
}

function formatSquareReceiptTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: businessTimeZone(), month: "2-digit", day: "2-digit", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod}`;
}

function getSquareOrderNumber(order, source) {
  if (source === "UberEats" && order.reference_id) return String(order.reference_id).slice(-4);
  return order.ticket_name || order.reference_id || order.id;
}

function parseSquareOrder(order) {
  const { fulfillment, details } = getSquareFulfillmentDetails(order);
  const items = (order.line_items || []).map((lineItem) => {
    const modifierTotals = new Map();
    for (const modifier of lineItem.modifiers || []) {
      const name = modifier?.name;
      if (!name) continue;
      const qty = Number.parseFloat(formatSquareQuantity(modifier.quantity, 1));
      modifierTotals.set(name, (modifierTotals.get(name) || 0) + qty);
    }
    const modifiers = Array.from(modifierTotals.entries());
    return {
      item: `${formatSquareQuantity(lineItem.quantity, 1)}x ${lineItem.name || "Item"}`,
      modifiers: modifiers.map(([name, qty]) => modifiers.length === 1 && qty === 1 ? name : `${formatSquareQuantity(qty, 1)}x ${name}`)
    };
  });

  const totalItems = String(
    Number((order.line_items || []).reduce((sum, lineItem) => {
      return sum + Number.parseFloat(formatSquareQuantity(lineItem.quantity, 1));
    }, 0).toFixed(3))
  );

  const source = detectSquareSource(order);
  const fulfillmentType = detectSquareFulfillment(order) || "Pickup";
  const scheduleType = String(details.schedule_type || fulfillment.schedule_type || "").toUpperCase();
  const schedule = scheduleType === "ASAP" ? "ASAP" : scheduleType === "SCHEDULED" ? "Scheduled" : "";
  const orderedAt = details.placed_at || order.created_at || "";
  const scheduledAt = details.pickup_at || details.deliver_at || "";
  const customerPhone = details?.recipient?.phone_number || "";
  const courierPhone = details?.courier_details?.phone_number || details?.courier?.phone_number || details?.courier_phone_number
    || String(details?.note || "").match(/\bcourier\b[^\n\r+\d]*(\+?\d[\d\s().-]{7,}\d)/i)?.[1] || "";

  return {
    customer: getSquareRecipient(order),
    orderType: getSquareOrderType(order),
    phone: `Order #${getSquareOrderNumber(order, source)}`,
    totalItems,
    items,
    estimate: "",
    note: "",
    schedule,
    orderedOn: formatSquareReceiptTimestamp(orderedAt),
    scheduledFor: schedule === "Scheduled" ? formatSquareReceiptTimestamp(scheduledAt) : "",
    customerPhone,
    courierPhone,
    fulfillmentNote: details?.note || "",
    source,
    fulfillmentType
  };
}

function routeForSquareLocation(locationId) {
  if (locationId === process.env.SQ_LOCATION_1) {
    console.log("SQUARE LOCATION 1 MATCHED");
    return normalizePrintRoute(process.env.ROUTE_1);
  }
  if (locationId === process.env.SQ_LOCATION_2) {
    console.log("SQUARE LOCATION 2 MATCHED");
    return normalizePrintRoute(process.env.ROUTE_2);
  }
  console.log("SQUARE LOCATION UNKNOWN");
  return null;
}

function isSquarePrintable(order) {
  const state = order?.state || order?.status || "OPEN";
  return state === "OPEN" || state === "DRAFT";
}

function safeSquareError(err) {
  return String(err?.message || err || "unknown").replace(/Bearer\s+\S+/ig, "Bearer [redacted]").slice(0, 180);
}

async function processSquareOrder(event) {
  const orderId = getSquareOrderId(event);
  if (!orderId) {
    console.log("SQUARE ORDER ID MISSING");
    return;
  }
  if (hasQueuedSquareOrder(orderId)) {
    console.log(`SQUARE ORDER ALREADY QUEUED: ${orderId}`);
    return;
  }
  console.log(`SQUARE ORDER PROCESSING: ${orderId}`);

  try {
    let order;
    try {
      ({ order } = await squareApiGet(`/v2/orders/${encodeURIComponent(orderId)}`));
    } catch (err) {
      console.log(`SQUARE ORDER RETRIEVE FAILED: ${safeSquareError(err)}`);
      return;
    }
    if (!order) {
      console.log("SQUARE ORDER RETRIEVE FAILED: missing order");
      return;
    }
    if (!isSquarePrintable(order)) {
      console.log(`SQUARE ORDER NOT PRINTABLE: ${order.state || order.status || "state unknown"}`);
      return;
    }

    const route = routeForSquareLocation(order?.location_id);
    if (!route) return;
    const routeLabel = route === normalizePrintRoute(process.env.ROUTE_2) ? "#2" : "#1";

    let parsed;
    let jobBuf;
    try {
      parsed = parseSquareOrder(order);
      console.log(`SQUARE ORDER: ${parsed.source} | ${parsed.fulfillmentType} | ${routeLabel}`);
      jobBuf = buildReceipt(parsed.customer, parsed.orderType, parsed.phone, parsed.totalItems, parsed.items, parsed.estimate, parsed.note, {
        schedule: parsed.schedule,
        orderedOn: parsed.orderedOn,
        scheduledFor: parsed.scheduledFor
      });
    } catch (err) {
      console.log("SQUARE RECEIPT BUILD FAILED");
      return;
    }

    try {
      const printJobId = enqueueReceipt(jobBuf, route, {
        routeLabel,
        source: parsed.source,
        orderType: parsed.fulfillmentType
      });
      alertSystem.createShopAlert({
        shop: routeLabel === "#2" ? 2 : 1, jobReference: printJobId, source: parsed.source,
        type: parsed.fulfillmentType, customer: parsed.customer,
        reference: String(parsed.phone || "").replace(/^Order\s*#/i, "").trim(), items: parsed.items,
        orderedTime: parsed.orderedOn, scheduleType: parsed.schedule, scheduledTime: parsed.scheduledFor,
        customerNote: parsed.note, fulfillmentNote: parsed.fulfillmentNote,
        customerPhone: parsed.customerPhone, courierPhone: parsed.courierPhone
      });
      markSquareQueued(orderId);
    } catch (err) {
      console.log("SQUARE QUEUE FAILED");
      return;
    }
    console.log(`SQUARE ORDER QUEUED: ${orderId} -> ${routeLabel}`);
  } catch (err) {
    console.log(`SQUARE PROCESSING FAILED: ${safeSquareError(err)}`);
  }
}

app.get("/sq-webhook", (req, res) => {
  res.send("Square webhook route is live");
});

app.post("/sq-webhook", (req, res) => {
  console.log("SQUARE WEBHOOK RECEIVED");

  const rawBodyBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ""), "utf8");
  if (!verifySquareSignature(req, rawBodyBuffer)) {
    console.log("SQUARE INVALID SIGNATURE");
    return res.status(403).send("Invalid signature");
  }
  console.log("SQUARE SIGNATURE VERIFIED");

  let event;
  try {
    event = JSON.parse(rawBodyBuffer.toString("utf8"));
  } catch (err) {
    return res.status(400).send("Invalid JSON");
  }


  res.status(200).send("OK");

  if (event.type === "order.created") {
    processSquareOrder(event);
  } else {
    console.log(`SQUARE EVENT IGNORED: ${event.type}`);
  }
});

// --------------------
// ADVANCED CLOUDPRNT ENDPOINTS
// --------------------

app.post("/starcloudprint", (req, res) => {
  notePrinterPoll("");

  if (pending.length > 0) {
    const next = pending[0];
    console.log(`JOB READY: ${routeLabelForRoute("")} -> ${next}`);
    return res.json({
      jobReady: true,
      mediaTypes: ["application/vnd.star.starprnt"],
      jobToken: next,
      contentType: "application/vnd.star.starprnt",
      nextPollInterval: PRINTER_POLL_SECONDS
    });
  }

  res.json({ jobReady: false, nextPollInterval: PRINTER_POLL_SECONDS });
});

app.get("/starcloudprint", (req, res) => {
  const token = req.query.token || req.query.jobToken || req.query.jobid;

  if (!token || !activeJobs.has(token)) {
    return res.status(204).send();
  }

  console.log(`JOB DOWNLOADED: ${routeLabelForRoute("")} -> ${token}`);

  const job = activeJobs.get(token);
  const jobBuf = job?.buf || job;

  res.setHeader("Content-Type", "application/vnd.star.starprnt");
  res.setHeader("Content-Length", jobBuf.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(jobBuf);

  if (job?.metadata?.removalId) removalIdToJob.delete(job.metadata.removalId);
  activeJobs.delete(token);
  pending = pending.filter((t) => t !== token);
});




function routeLabelForRoute(route) {
  const normalized = normalizePrintRoute(route);
  if (normalized === normalizePrintRoute(process.env.ROUTE_2)) return "#2";
  if (normalized === normalizePrintRoute(process.env.ROUTE_1)) return "#1";
  return routeLabels.get(normalized) || "#1";
}

function notePrinterPoll(route) {
  const label = routeLabelForRoute(route);
  const state = printerPollState.get(label) || { online: false, lastPollAt: 0, stoppedLogged: false };
  state.lastPollAt = Date.now();
  if (!state.online) console.log(`Printer polling connected: ${label} - ${formatBusinessTimestamp()}`);
  state.online = true;
  state.stoppedLogged = false;
  printerPollState.set(label, state);
}

function removeJobByToken(route, token) {
  const queue = route ? getRouteQueue(route) : { activeJobs, pending };
  const job = queue.activeJobs.get(token);
  if (!job) return false;
  queue.activeJobs.delete(token);
  queue.pending = queue.pending.filter((t) => t !== token);
  if (!route) pending = queue.pending;
  if (job?.metadata?.removalId) removalIdToJob.delete(job.metadata.removalId);
  return job;
}

function registerCloudPrntRoute(route) {
  const normalizedRoute = normalizePrintRoute(route);
  if (!normalizedRoute) return;
  const path = `/${normalizedRoute}`;

  app.post(path, (req, res) => {
    notePrinterPoll(normalizedRoute);

    const queue = getRouteQueue(normalizedRoute);
    if (queue.pending.length > 0) {
      const next = queue.pending[0];
      console.log(`JOB READY: ${routeLabelForRoute(normalizedRoute)} -> ${next}`);
      return res.json({
        jobReady: true,
        mediaTypes: ["application/vnd.star.starprnt"],
        jobToken: next,
        contentType: "application/vnd.star.starprnt",
        nextPollInterval: PRINTER_POLL_SECONDS
      });
    }

    res.json({ jobReady: false, nextPollInterval: PRINTER_POLL_SECONDS });
  });

  app.get(path, (req, res) => {
    const token = req.query.token || req.query.jobToken || req.query.jobid;
    const queue = getRouteQueue(normalizedRoute);

    if (!token || !queue.activeJobs.has(token)) {
      return res.status(204).send();
    }

    console.log(`JOB DOWNLOADED: ${routeLabelForRoute(normalizedRoute)} -> ${token}`);

    const job = queue.activeJobs.get(token);
    const jobBuf = job?.buf || job;
    res.setHeader("Content-Type", "application/vnd.star.starprnt");
    res.setHeader("Content-Length", jobBuf.length);
    res.setHeader("Cache-Control", "no-store");
    res.send(jobBuf);

    if (job?.metadata?.removalId) removalIdToJob.delete(job.metadata.removalId);
    queue.activeJobs.delete(token);
    queue.pending = queue.pending.filter((t) => t !== token);
  });
}

routeLabels.set(normalizePrintRoute(process.env.ROUTE_1), "#1");
routeLabels.set(normalizePrintRoute(process.env.ROUTE_2), "#2");
registerCloudPrntRoute(process.env.ROUTE_1);
registerCloudPrntRoute(process.env.ROUTE_2);


function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function pendingQueueRows() {
  const rows = [];
  const addRows = (route, queue) => {
    for (const token of queue.pending) {
      const job = queue.activeJobs.get(token);
      const metadata = job?.metadata || {};
      rows.push({
        createdAt: metadata.createdAt || new Date(0).toISOString(),
        routeLabel: metadata.routeLabel || routeLabelForRoute(route),
        source: metadata.source || "Unknown",
        orderType: metadata.orderType || "Unknown",
        removalId: metadata.removalId || ""
      });
    }
  };
  addRows("", { activeJobs, pending });
  for (const [route, queue] of routeQueues) addRows(route, queue);
  rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return rows;
}

function businessDateParts(iso) {
  const date = new Date(iso);
  return {
    date: date.toLocaleDateString("en-US", { timeZone: businessTimeZone(), month: "short", day: "numeric", year: "numeric" }),
    time: date.toLocaleTimeString("en-US", { timeZone: businessTimeZone(), hour: "numeric", minute: "2-digit" })
  };
}

function authenticateAlert(req, res) {
  const clearKey = process.env.CLEAR_KEY;
  if (!clearKey) { res.status(404).send("Not found"); return false; }
  if (req.query.key !== clearKey) { res.status(401).send("Unauthorized"); return false; }
  return true;
}

function alertShopFromRequest(req) {
  const shop = Number(req.params.shop);
  return Number.isInteger(shop) && shop > 0 ? shop : null;
}

function publicAlert(record) {
  return {
    id: record.id, shop: record.shop, createdAt: record.createdAt,
    status: record.status, completedAt: record.completedAt, acknowledged: record.acknowledged, acknowledgedAt: record.acknowledgedAt,
    receivedTime: businessDateParts(record.createdAt).time, source: record.source, type: record.type,
    customer: record.customer, reference: record.reference, orderedTime: record.orderedTime, scheduleType: record.scheduleType,
    scheduledTime: record.scheduledTime, customerPhone: record.customerPhone, courierPhone: record.courierPhone, customerNote: record.customerNote,
    fulfillmentNote: record.fulfillmentNote, items: record.items
  };
}

app.get(/^\/alert(\d+)$/, (req, res) => {
  req.params.shop = req.params[0];
  if (!authenticateAlert(req, res) || !alertShopFromRequest(req)) return;
  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#091018"><meta name="apple-mobile-web-app-capable" content="yes"><title>Howard's Orders</title><link rel="manifest"><link rel="icon" href="/alert-icon.svg"><link rel="stylesheet" href="/alert-app.css"></head><body><header><h1>HOWARD'S ORDERS</h1><div id="shop" class="shop"></div><div>STATUS: <span id="status" class="status reconnecting">RECONNECTING</span></div><button id="enableNotifications" class="notification-setup hidden">Enable Notifications</button><nav id="orderTabs" aria-label="Order status"><button data-tab="active" class="selected">Active</button><button data-tab="complete">Complete</button></nav></header><main><section id="listView"><div id="alerts"></div></section><section id="detailView" class="hidden details"><button id="detailAction"></button><div id="detailBody"></div></section></main><script src="/alert-app.js" defer></script></body></html>`);
});

app.get(/^\/api\/alert(\d+)$/, (req, res) => {
  req.params.shop = req.params[0];
  if (!authenticateAlert(req, res)) return;
  const shop = alertShopFromRequest(req);
  if (!shop) return res.status(404).send("Not found");
  res.setHeader("Cache-Control", "no-store");
  res.json({ shop, alerts: alertSystem.getShopAlerts(shop).map(publicAlert) });
});

app.post(/^\/api\/alert(\d+)\/([a-f0-9]+)\/(active|complete)$/, (req, res) => {
  req.params.shop = req.params[0];
  if (!authenticateAlert(req, res)) return;
  const shop = alertShopFromRequest(req);
  if (!shop) return res.status(404).send("Not found");
  const record = alertSystem.setShopAlertStatus(shop, req.params[1], req.params[2]);
  if (!record) return res.status(404).send("Order not found");
  res.setHeader("Cache-Control", "no-store");
  res.json({ alert: publicAlert(record) });
});

app.post(/^\/api\/alert(\d+)\/([a-f0-9]+)\/acknowledge$/, (req, res) => {
  req.params.shop = req.params[0];
  if (!authenticateAlert(req, res)) return;
  const shop = alertShopFromRequest(req);
  if (!shop) return res.status(404).send("Not found");
  const record = alertSystem.acknowledgeShopAlert(shop, req.params[1]);
  if (!record) return res.status(404).send("Order not found");
  res.setHeader("Cache-Control", "no-store");
  res.json({ alert: publicAlert(record) });
});

app.get(/^\/api\/alert(\d+)\/push-key$/, (req, res) => {
  req.params.shop = req.params[0];
  if (!authenticateAlert(req, res) || !alertShopFromRequest(req)) return;
  res.setHeader("Cache-Control", "no-store");
  res.json({ publicKey: process.env.WEB_PUSH_PUBLIC_KEY || "" });
});

app.post(/^\/api\/alert(\d+)\/push-subscription$/, (req, res) => {
  req.params.shop = req.params[0];
  if (!authenticateAlert(req, res)) return;
  const shop = alertShopFromRequest(req);
  if (!shop) return res.status(404).send("Not found");
  try {
    const subscription = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}");
    alertSystem.registerPushSubscription(shop, subscription);
    res.status(201).json({ registered: true, shop });
  } catch { res.status(400).json({ error: "Invalid push subscription" }); }
});

app.get(/^\/alert(\d+)\/manifest\.webmanifest$/, (req, res) => {
  req.params.shop = req.params[0];
  if (!authenticateAlert(req, res)) return;
  const shop = alertShopFromRequest(req);
  if (!shop) return res.status(404).send("Not found");
  res.type("application/manifest+json").send(JSON.stringify({
    name: "Howard's Order Alert", short_name: `Order Alert ${shop}`, id: `/alert${shop}`,
    start_url: `/alert${shop}?key=${encodeURIComponent(req.query.key)}`, scope: "/", display: "standalone",
    background_color: "#091018", theme_color: "#091018",
    icons: [{ src: "/alert-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }]
  }));
});

app.get("/v", (req, res) => {
  const clearKey = process.env.CLEAR_KEY;
  if (!clearKey) return res.status(404).send("Not found");
  if (req.query.key !== clearKey) return res.status(401).send("Unauthorized");

  const rows = pendingQueueRows().map((row) => {
    const when = businessDateParts(row.createdAt);
    return `<tr><td>${htmlEscape(row.routeLabel)}</td><td>${htmlEscape(when.date)}</td><td>${htmlEscape(when.time)}</td><td>${htmlEscape(row.source)}</td><td>${htmlEscape(row.orderType)}</td><td><div class="actions"><form method="post" action="/queue/remove" onsubmit="return confirm('Remove this order from the queue?')"><input type="hidden" name="key" value="${htmlEscape(clearKey)}"><input type="hidden" name="id" value="${htmlEscape(row.removalId)}"><button type="submit">Remove</button></form></div></td></tr>`;
  }).join("");


  res.setHeader("Cache-Control", "no-store");
  res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Queue</title><style>body{font-family:Arial,sans-serif;margin:1rem;color:#222}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:.6rem;text-align:left}.actions{display:flex;align-items:center;gap:.5rem}.actions form{margin:0}button{display:inline-block;padding:.5rem;border:1px solid #777;border-radius:4px;background:#f5f5f5;color:#111;text-decoration:none;font:inherit}@media(max-width:600px){body{margin:.5rem}th,td{padding:.45rem;font-size:.9rem}.actions{flex-direction:column;align-items:flex-start}}</style></head><body><h1>Waiting Orders</h1><table><thead><tr><th>Shop</th><th>Date</th><th>Time</th><th>Source</th><th>Type</th><th>Action</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No waiting orders</td></tr>'}</tbody></table></body></html>`);
});

app.post("/queue/remove", express.urlencoded({ extended: false }), (req, res) => {
  const clearKey = process.env.CLEAR_KEY;
  if (!clearKey) return res.status(404).send("Not found");
  const parsedBody = Buffer.isBuffer(req.body) ? Object.fromEntries(new URLSearchParams(req.body.toString("utf8"))) : (req.body || {});
  if (parsedBody.key !== clearKey && req.query.key !== clearKey) return res.status(401).send("Unauthorized");
  const id = parsedBody.id || req.query.id;
  const entry = removalIdToJob.get(id);
  if (entry) {
    const job = removeJobByToken(entry.route, entry.token);
    if (job) console.log(`QUEUE ITEM REMOVED: ${job.metadata?.routeLabel || routeLabelForRoute(entry.route)}`);
  }
  res.redirect(`/v?key=${encodeURIComponent(clearKey)}`);
});

app.get("/clear", (req, res) => {
  const clearKey = process.env.CLEAR_KEY;
  if (!clearKey) return res.status(404).send("Not found");
  if (req.query.key !== clearKey) return res.status(401).send("Unauthorized");

  let pendingRemoved = pending.length;
  let activeRemoved = activeJobs.size;
  pending = [];
  activeJobs.clear();
  for (const queue of routeQueues.values()) {
    pendingRemoved += queue.pending.length;
    activeRemoved += queue.activeJobs.size;
    queue.pending = [];
    queue.activeJobs.clear();
  }
  removalIdToJob.clear();
  console.log("ADMIN QUEUES CLEARED");

  if (req.query.resetSquare === "1") {
    queuedSquareOrders.clear();
    console.log("ADMIN SQUARE DEDUP CLEARED");
    return res.type("text/plain").send("Queues and Square deduplication cleared.");
  }

  res.type("text/plain").send(`Queues cleared.\nPending jobs removed: ${pendingRemoved}\nActive jobs removed: ${activeRemoved}\nSquare deduplication retained.`);
});

app.get("/health", (req, res) => {
  pruneSquareDedup();
  const route1 = normalizePrintRoute(process.env.ROUTE_1);
  const route2 = normalizePrintRoute(process.env.ROUTE_2);
  const q1 = getRouteQueue(route1);
  const q2 = getRouteQueue(route2);
  res.json({
    ok: true,
    uptimeSeconds: Math.floor(process.uptime()),
    queues: {
      [route1 || "default"]: { pending: q1.pending.length, active: q1.activeJobs.size },
      [route2 || "default"]: { pending: q2.pending.length, active: q2.activeJobs.size }
    },
    square: {
      queuedCount: queuedSquareOrders.size
    },
    printers: {
      "#1": printerPollState.get("#1") || { online: false, lastPollAt: 0, stoppedLogged: false },
      "#2": printerPollState.get("#2") || { online: false, lastPollAt: 0, stoppedLogged: false }
    },
    lastEmailPollAt
  });
});

  app.get("/", (req,res)=>{
  res.send("OK");
});


// --------------------
// LOOP
// --------------------
let emailTimer = null;

function startEmailPolling() {
  if (emailTimer) return;

  if (emailStoppedLogged) {
    console.log("Email polling resumes");
  }

  lastEmailPollAt = Date.now();
  emailStoppedLogged = false;

  emailTimer = setInterval(async () => {
    lastEmailPollAt = Date.now();
    emailStoppedLogged = false;
    await checkEmail();
  }, EMAIL_POLL_MS);
}

startEmailPolling();
function checkPollingStatus(now = Date.now()) {
  if (!emailStoppedLogged && now - lastEmailPollAt > 5 * 60 * 1000) {
    console.log("email has stopped polling 5 minutes ago");
    emailStoppedLogged = true;
  }
  for (const [label, state] of printerPollState) {
    if (state.online && !state.stoppedLogged && now - state.lastPollAt > 5 * 60 * 1000) {
      console.log(`Printer stops polling 5 minutes ago: ${label} - ${formatBusinessTimestamp()}`);
      state.online = false;
      state.stoppedLogged = true;
    }
  }
  pruneSquareDedup(now);
}

setInterval(() => checkPollingStatus(), 30000);
setInterval(() => alertSystem.runAlertMaintenance(new Date(), businessTimeZone()), 30000);
setInterval(() => alertSystem.checkPushoverReceipts(), 60000);


if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log("SERVER RUNNING");
  });
}

module.exports = { app, buildReceipt, parseSquareOrder, verifySquareSignature, normalizePrintRoute, queuedSquareOrders, enqueueReceipt, getRouteQueue, notePrinterPoll, printerPollState, checkPollingStatus, isSquarePrintable, formatBusinessTimestamp, parseGrubHub, parseDoorDashPDF, checkEmail, EMAIL_POLL_MS, PRINTER_POLL_SECONDS, alertSystem };
