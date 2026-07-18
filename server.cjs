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

let lastEmailPollAt = Date.now();
let lastPrinterPollAt = Date.now();

let emailStoppedLogged = false;
let printerStoppedLogged = false;

function enqueueReceipt(jobBuf, route = "") {
  const id = Math.random().toString(36).substring(2,10);

  activeJobs.set(id, jobBuf);
  pending.push(id);

  console.log("QUEUE ADDED:", id);
  if (route) console.log("Square job queued:", id, "route:", route);

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
// --------------------
function getSquareNotificationUrl(req) {
  if (process.env.SQUARE_WEBHOOK_URL) return process.env.SQUARE_WEBHOOK_URL;

  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}${req.originalUrl}`;
}

function verifySquareSignature(req, rawBody) {
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const signature = req.get("x-square-hmacsha256-signature") || "";

  if (!signatureKey || !signature) return false;

  const payload = getSquareNotificationUrl(req) + rawBody;
  const expected = crypto
    .createHmac("sha256", signatureKey)
    .update(payload, "utf8")
    .digest("base64");

  const expectedBuf = Buffer.from(expected, "base64");
  const signatureBuf = Buffer.from(signature, "base64");

  return expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function squareApiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: "GET",
      hostname: "connect.squareup.com",
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
          return reject(new Error(`Square API ${res.statusCode}: ${data}`));
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
    event?.data?.id;
}

function getSquareRecipient(order) {
  for (const fulfillment of order.fulfillments || []) {
    const details = fulfillment.pickup_details || fulfillment.delivery_details || fulfillment.shipment_details;
    if (details?.recipient?.display_name) return details.recipient.display_name;
  }
  return order.customer_id || "Square";
}

function getSquareOrderType(order) {
  const fulfillment = (order.fulfillments || [])[0] || {};
  if (fulfillment.type === "DELIVERY") return "Square Delivery";
  return "Square Pickup";
}

function getSquareOrderNumber(order) {
  return order.ticket_name || order.reference_id || order.id;
}

function parseSquareOrder(order) {
  const items = (order.line_items || []).map((lineItem) => ({
    item: `${lineItem.quantity || "1"}x ${lineItem.name || "Item"}`,
    modifiers: (lineItem.modifiers || []).map((modifier) => modifier.name).filter(Boolean)
  }));

  const totalItems = String(
    (order.line_items || []).reduce((sum, lineItem) => sum + (parseInt(lineItem.quantity, 10) || 1), 0)
  );

  return {
    customer: getSquareRecipient(order),
    orderType: getSquareOrderType(order),
    phone: `Order #${getSquareOrderNumber(order)}`,
    totalItems,
    items,
    estimate: "",
    note: ""
  };
}

function routeForSquareLocation(locationId) {
  if (locationId === process.env.SQ_LOCATION_1) return process.env.ROUTE_1;
  if (locationId === process.env.SQ_LOCATION_2) return process.env.ROUTE_2;
  return null;
}

app.post("/square-webhook", async (req, res) => {
  console.log("Square webhook received");

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");
  if (!verifySquareSignature(req, rawBody)) {
    console.log("Square webhook rejected: invalid signature");
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    console.log("Square webhook rejected: invalid JSON");
    return res.status(400).send("Invalid JSON");
  }

  if (!["order.created", "order.updated"].includes(event.type)) {
    return res.status(200).send("Ignored");
  }

  const orderId = getSquareOrderId(event);
  if (!orderId) return res.status(200).send("No order ID");

  try {
    const { order } = await squareApiGet(`/v2/orders/${encodeURIComponent(orderId)}`);
    const locationId = order?.location_id;
    const route = routeForSquareLocation(locationId);

    if (!route) {
      console.log("Square webhook ignored: unknown location", locationId);
      return res.status(200).send("Unknown location");
    }

    console.log("Square location matched:", locationId);
    console.log("Square route selected:", route);

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

    const jobId = enqueueReceipt(jobBuf, route);
    console.log("Square job queued:", jobId);
    res.status(200).send("Queued");
  } catch (err) {
    console.log("SQUARE WEBHOOK ERROR:", err.message);
    res.status(500).send("Square webhook error");
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

    res.setHeader("Content-Type", "application/vnd.star.starprnt");
    res.setHeader("Content-Length", job.length);
    res.setHeader("Cache-Control", "no-store");
    res.send(job);

    activeJobs.delete(token);
    pending = pending.filter((t) => t !== token);

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

app.listen(process.env.PORT || 3000, () => {
  console.log("SERVER RUNNING");
});
