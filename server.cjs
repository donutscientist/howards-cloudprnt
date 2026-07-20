const cheerio = require("cheerio");
const crypto = require("crypto");
const https = require("https");
const express = require("express");
const { google } = require("googleapis");
const pdfParse = require("pdf-parse");

const app = express();

let openTime = 4 * 60 + 30; // 4:30 AM
let closeTime = 17 * 60;    // 5:00 PM

function isBusinessHours() {

  if (process.env.TEST_ALWAYS_OPEN === "1") return true;

  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const [h,m] = now.split(":").map(Number);
  const time = h * 60 + m;

  return time >= openTime && time <= closeTime;

}

app.use(express.raw({ type: "*/*" }));

// --------------------
// ADVANCED CLOUDPRNT QUEUE
// --------------------
let activeJobs = new Map(); // token -> Buffer
let pending = [];           // tokens FIFO

const routeQueues = new Map(); // route -> { activeJobs, pending }
const SQUARE_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const SQUARE_DEDUP_MAX_ENTRIES = 5000;
const recentlyProcessedSquareOrders = new Map(); // orderId -> { status, expiresAt }
const completedJobSquareOrderIds = new Map(); // orderId -> expiresAt


let lastEmailPollAt = Date.now();
let lastPrinterPollAt = Date.now();

let emailStoppedLogged = false;
let printerStoppedLogged = false;

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

function enqueueReceipt(jobBuf, route = "", metadata = {}) {
  const id = Math.random().toString(36).substring(2,10);
  const normalizedRoute = normalizePrintRoute(route);

  if (normalizedRoute) {
    const queue = getRouteQueue(normalizedRoute);
    queue.activeJobs.set(id, { buf: jobBuf, metadata });
    queue.pending.push(id);
  } else {
    activeJobs.set(id, { buf: jobBuf, metadata });
    pending.push(id);
  }

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

function buildReceipt(customer, orderType, phone, totalItems, items, estimate = "", note = "") {
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

    enqueueReceipt(jobBuf);

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
// Printable rule: only order.created/order.updated events whose retrieved order is OPEN are queued,
// and each Square order ID is claimed, queued, and printed at most once per deduplication TTL.
// --------------------

function pruneSquareDedup(now = Date.now()) {
  for (const [orderId, entry] of recentlyProcessedSquareOrders) {
    if (!entry || entry.expiresAt <= now) recentlyProcessedSquareOrders.delete(orderId);
  }
  for (const [orderId, expiresAt] of completedJobSquareOrderIds) {
    if (expiresAt <= now) completedJobSquareOrderIds.delete(orderId);
  }
  while (recentlyProcessedSquareOrders.size > SQUARE_DEDUP_MAX_ENTRIES) {
    recentlyProcessedSquareOrders.delete(recentlyProcessedSquareOrders.keys().next().value);
  }
  while (completedJobSquareOrderIds.size > SQUARE_DEDUP_MAX_ENTRIES) {
    completedJobSquareOrderIds.delete(completedJobSquareOrderIds.keys().next().value);
  }
}

function setSquareDedup(orderId, status) {
  pruneSquareDedup();
  recentlyProcessedSquareOrders.set(orderId, { status, expiresAt: Date.now() + SQUARE_DEDUP_TTL_MS });
}

function getSquareDedupStatus(orderId) {
  pruneSquareDedup();
  return recentlyProcessedSquareOrders.get(orderId)?.status || null;
}

function markSquareCompleted(orderId) {
  if (!orderId) return;
  completedJobSquareOrderIds.set(orderId, Date.now() + SQUARE_DEDUP_TTL_MS);
  setSquareDedup(orderId, "printed");
}

function queueHasSquareOrderId(queue, orderId) {
  for (const token of queue.pending) {
    const job = queue.activeJobs.get(token);
    if (job?.metadata?.squareOrderId === orderId) return true;
  }
  for (const job of queue.activeJobs.values()) {
    if (job?.metadata?.squareOrderId === orderId) return true;
  }
  return false;
}

function isSquareOrderQueued(orderId) {
  if (queueHasSquareOrderId({ activeJobs, pending }, orderId)) return true;
  for (const queue of routeQueues.values()) {
    if (queueHasSquareOrderId(queue, orderId)) return true;
  }
  return false;
}

function isSquareOrderPrinted(orderId) {
  pruneSquareDedup();
  return completedJobSquareOrderIds.has(orderId) || getSquareDedupStatus(orderId) === "printed";
}

function claimSquareOrder(orderId) {
  const status = getSquareDedupStatus(orderId);
  if (status === "processing") { console.log(`SQUARE ORDER ALREADY PROCESSING: ${orderId}`); return false; }
  if (status === "queued" || isSquareOrderQueued(orderId)) { console.log(`SQUARE ORDER ALREADY QUEUED: ${orderId}`); setSquareDedup(orderId, "queued"); return false; }
  if (status === "printed" || isSquareOrderPrinted(orderId)) { console.log(`SQUARE ORDER ALREADY PRINTED: ${orderId}`); return false; }
  console.log(`SQUARE ORDER PROCESSING: ${orderId}`);
  setSquareDedup(orderId, "processing");
  return true;
}

function releaseSquareOrder(orderId) {
  if (getSquareDedupStatus(orderId) === "processing") recentlyProcessedSquareOrders.delete(orderId);
}

function formatSquareQuantity(value, fallback = 1) {
  const n = Number.parseFloat(String(value ?? "").trim());
  const safe = Number.isFinite(n) && n > 0 ? n : fallback;
  return Number.isInteger(safe) ? String(safe) : String(Number(safe.toFixed(3)));
}

function normalizeSquareSource(value) {
  const text = String(value || "").toLowerCase();
  if (/uber/.test(text)) return "Uber Eats";
  if (/door\s*dash|doordash/.test(text)) return "DoorDash";
  if (/grub\s*hub|grubhub/.test(text)) return "Grubhub";
  if (/square/.test(text)) return "Square";
  return null;
}

function detectSquareSource(order) {
  const candidates = [
    order?.source?.name,
    typeof order?.source === "string" ? order.source : "",
    order?.application_details?.application_name,
    order?.application_details?.square_product,
    order?.ticket_name,
    order?.reference_id,
    ...(order?.fulfillments || []).flatMap(f => [f?.type, f?.state, f?.pickup_details?.schedule_type, f?.delivery_details?.courier_pickup_at])
  ];
  for (const candidate of candidates) {
    const normalized = normalizeSquareSource(candidate);
    if (normalized) return normalized;
  }
  return "Square";
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
    responseBody,
    squareErrorCode: squareError?.code,
    squareErrorCategory: squareError?.category,
    squareErrorDetail: squareError?.detail
  });
}

function squareApiGet(path) {
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
          logSquareApiError({ requestUrl, statusCode: res.statusCode, responseBody: data });
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
  return event?.data?.object?.order_created?.order_id ||
    event?.data?.object?.order_updated?.order_id ||
    event?.data?.object?.order?.id ||
    event?.data?.id;
}

function getSquareEventOrderVersion(event) {
  return event?.data?.object?.order_updated?.version ||
    event?.data?.object?.order_created?.version ||
    event?.data?.object?.order?.version;
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
  return details?.recipient?.display_name || order.ticket_name || order.customer_id || "Square";
}

function getSquareOrderType(order) {
  const source = detectSquareSource(order);
  const fulfillmentType = detectSquareFulfillment(order);
  console.log(`SQUARE SOURCE: ${source} | ${fulfillmentType || "Order"}`);
  return fulfillmentType ? `${source} ${fulfillmentType}` : `${source} Order`;
}

function getSquareOrderTime(order) {
  const { details } = getSquareFulfillmentDetails(order);
  return details.pickup_at || details.deliver_at || details.placed_at || order.created_at || "";
}

function getSquareOrderNumber(order) {
  return order.ticket_name || order.reference_id || order.id;
}

function parseSquareOrder(order) {
  const { details } = getSquareFulfillmentDetails(order);
  const items = (order.line_items || []).map((lineItem) => {
    const modifierTotals = new Map();
    for (const modifier of lineItem.modifiers || []) {
      const name = modifier?.name;
      if (!name) continue;
      const qty = Number.parseFloat(formatSquareQuantity(modifier.quantity, 1));
      modifierTotals.set(name, (modifierTotals.get(name) || 0) + qty);
    }
    return {
      item: `${formatSquareQuantity(lineItem.quantity, 1)}x ${lineItem.name || "Item"}`,
      modifiers: Array.from(modifierTotals.entries()).map(([name, qty]) => `${formatSquareQuantity(qty, 1)}x ${name}`)
    };
  });

  const totalItems = String(
    (order.line_items || []).reduce((sum, lineItem) => sum + (Number.parseFloat(lineItem.quantity) || 1), 0)
  );

  const notes = [order.note, details.note].filter(Boolean).join(" / ");
  const source = order.source?.name ? `Source: ${order.source.name}` : "";

  return {
    customer: getSquareRecipient(order),
    orderType: getSquareOrderType(order),
    phone: `Order #${getSquareOrderNumber(order)}`,
    totalItems,
    items,
    estimate: getSquareOrderTime(order),
    note: [notes, source].filter(Boolean).join(" / ")
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
  return (order?.state || order?.status || "OPEN") === "OPEN";
}

async function processSquareOrder(event) {
  const orderId = getSquareOrderId(event);
  if (!orderId) return;
  if (!claimSquareOrder(orderId)) {
    console.log(`SQUARE DUPLICATE SKIPPED: ${orderId}`);
    return;
  }

  try {
    const { order } = await squareApiGet(`/v2/orders/${encodeURIComponent(orderId)}`);
    if (!isSquarePrintable(order)) {
      releaseSquareOrder(orderId);
      return;
    }

    if (isSquareOrderQueued(orderId)) {
      console.log(`SQUARE ORDER ALREADY QUEUED: ${orderId}`);
      setSquareDedup(orderId, "queued");
      return;
    }
    if (isSquareOrderPrinted(orderId)) {
      console.log(`SQUARE ORDER ALREADY PRINTED: ${orderId}`);
      return;
    }

    const route = routeForSquareLocation(order?.location_id);
    if (!route) {
      releaseSquareOrder(orderId);
      return;
    }

    const parsed = parseSquareOrder(order);
    const jobBuf = buildReceipt(
      parsed.customer,
      parsed.orderType,
      parsed.phone,
      parsed.totalItems,
      parsed.items,
      parsed.estimate,
      parsed.note
    );

    enqueueReceipt(jobBuf, route, { squareOrderId: orderId, source: "square" });
    setSquareDedup(orderId, "queued");
    console.log(`SQUARE ORDER QUEUED: ${orderId} -> ${route}`);
  } catch (err) {
    releaseSquareOrder(orderId);
    console.log("SQUARE ORDER RETRIEVE ERROR", err.message);
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

  if (["order.created", "order.updated"].includes(event.type)) {
    processSquareOrder(event);
  }
});

// --------------------
// ADVANCED CLOUDPRNT ENDPOINTS
// --------------------

  app.post("/starcloudprint", (req, res) => {

  if (printerStoppedLogged) {
  console.log("Printer polling resumes");
}

lastPrinterPollAt = Date.now();
printerStoppedLogged = false;

  const isOpen = isBusinessHours();

  const pollInterval = isOpen
    ? 5
    : 43200; // 12 hours

  if (!isOpen) {
    return res.json({
      jobReady: false,
      nextPollInterval: pollInterval
    });
  }

  if (pending.length > 0) {

    const next = pending[0];

    console.log("JOB READY ->", next);

    return res.json({
      jobReady: true,
      mediaTypes: ["application/vnd.star.starprnt"],
      jobToken: next,
      contentType: "application/vnd.star.starprnt",
      nextPollInterval: pollInterval
    });
  }

  res.json({
    jobReady: false,
    nextPollInterval: pollInterval
  });

});

  app.get("/starcloudprint", (req, res) => {
console.log("TEST PRINTER POLLED:", new Date().toISOString());
    const token = req.query.token || req.query.jobToken || req.query.jobid;

    if (!token || !activeJobs.has(token)) {
      return res.status(204).send();
    }

    console.log("DOWNLOADING JOB:", token);

    const job = activeJobs.get(token);
    const jobBuf = job?.buf || job;

    res.setHeader("Content-Type", "application/vnd.star.starprnt");
    res.setHeader("Content-Length", jobBuf.length);
    res.setHeader("Cache-Control", "no-store");
    res.send(jobBuf);

    if (job?.metadata?.squareOrderId) markSquareCompleted(job.metadata.squareOrderId);
    activeJobs.delete(token);
    pending = pending.filter((t) => t !== token);

  });


function registerCloudPrntRoute(route) {
  const normalizedRoute = normalizePrintRoute(route);
  if (!normalizedRoute) return;
  const path = `/${normalizedRoute}`;

  app.post(path, (req, res) => {
    console.log(`PRINTER POLLED: ${normalizedRoute}`);

    lastPrinterPollAt = Date.now();
    printerStoppedLogged = false;

    const isOpen = isBusinessHours();
    const pollInterval = isOpen ? 5 : 43200;
    if (!isOpen) {
      return res.json({ jobReady: false, nextPollInterval: pollInterval });
    }

    const queue = getRouteQueue(normalizedRoute);
    if (queue.pending.length > 0) {
      const next = queue.pending[0];
      console.log(`JOB READY: ${normalizedRoute} -> ${next}`);
      return res.json({
        jobReady: true,
        mediaTypes: ["application/vnd.star.starprnt"],
        jobToken: next,
        contentType: "application/vnd.star.starprnt",
        nextPollInterval: pollInterval
      });
    }

    res.json({ jobReady: false, nextPollInterval: pollInterval });
  });

  app.get(path, (req, res) => {
    const token = req.query.token || req.query.jobToken || req.query.jobid;
    const queue = getRouteQueue(normalizedRoute);

    if (!token || !queue.activeJobs.has(token)) {
      return res.status(204).send();
    }

    console.log(`JOB DOWNLOADED: ${normalizedRoute} -> ${token}`);

    const job = queue.activeJobs.get(token);
    const jobBuf = job?.buf || job;
    res.setHeader("Content-Type", "application/vnd.star.starprnt");
    res.setHeader("Content-Length", jobBuf.length);
    res.setHeader("Cache-Control", "no-store");
    res.send(jobBuf);

    if (job?.metadata?.squareOrderId) markSquareCompleted(job.metadata.squareOrderId);
    queue.activeJobs.delete(token);
    queue.pending = queue.pending.filter((t) => t !== token);
  });
}

registerCloudPrntRoute(process.env.ROUTE_1);
registerCloudPrntRoute(process.env.ROUTE_2);


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
  completedJobSquareOrderIds.clear();
  console.log("ADMIN QUEUES CLEARED");

  if (req.query.resetSquareDedup === "1") {
    recentlyProcessedSquareOrders.clear();
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
      recentlyProcessedCount: recentlyProcessedSquareOrders.size,
      processingCount: Array.from(recentlyProcessedSquareOrders.values()).filter(e => e.status === "processing").length
    }
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
  }, 5000);
}

function stopEmailPolling() {
  if (emailTimer) {
    clearInterval(emailTimer);
    emailTimer = null;
  }
}

// check every 30 sec to switch ON/OFF exactly
setInterval(() => {

  if (isBusinessHours()) {
    startEmailPolling();
  } else {
    stopEmailPolling();
  }

}, 30000);

// run once on startup
if (isBusinessHours()) {
  startEmailPolling();
}
setInterval(() => {
  if (pending.length > 50) {
    console.log("🧹 CLEANING QUEUE");
    pending = pending.slice(-20);
  }
}, 60000);

setInterval(() => {
  const now = Date.now();

  if (!emailStoppedLogged && now - lastEmailPollAt > 5 * 60 * 1000) {
    console.log("email has stopped polling 5 minutes ago");
    emailStoppedLogged = true;
  }

  if (!printerStoppedLogged && now - lastPrinterPollAt > 5 * 60 * 1000) {
    console.log("printer has stopped polling 5 minutes ago");
    printerStoppedLogged = true;
  }
}, 30000);

app.get("/restart", (req, res) => {
  console.log("MANUAL RESTART TEST");
  res.send("Restart test triggered...");
  setTimeout(() => process.exit(0), 1000);
});

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => {
    console.log("SERVER RUNNING");
  });
}

module.exports = { app, buildReceipt, parseSquareOrder, verifySquareSignature, normalizePrintRoute, recentlyProcessedSquareOrders };
