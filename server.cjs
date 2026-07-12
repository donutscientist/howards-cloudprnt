const crypto = require("crypto");
const cheerio = require("cheerio");
const express = require("express");
const { google } = require("googleapis");
const pdfParse = require("pdf-parse");

const app = express();

const TIME_ZONE = process.env.TIME_ZONE || "America/Chicago";
const UBER_SECRET = process.env.UBER_SECRET || "";
const CLEAR_JOBS_KEY = process.env.CLEAR_JOBS_KEY || "";
const PORT = process.env.PORT || 3000;
const EMAIL_POLL_INTERVAL_MS = 5000;
const POLLING_WATCHDOG_MS = 5 * 60 * 1000;
const OPEN_POLL_INTERVAL_SECONDS = 5;
const CLOSED_POLL_INTERVAL_SECONDS = 300;

const openTime = Number(process.env.OPEN_TIME_MINUTES || 4 * 60 + 30); // 4:30 AM
const closeTime = Number(process.env.CLOSE_TIME_MINUTES || 17 * 60); // 5:00 PM

function isBusinessHours() {

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIME_ZONE,
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

// For Square, use text/plain (quoted printable)
function getPlainBody(payload) {
  return getPartText(payload, "text/plain");
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

function cleanModifierText(raw) {
  let s = (raw || "").replace(/\u00A0/g, " ").trim();

  // remove leading icons/bullets/spaces
  s = s.replace(/^[\s➕▪️]+/g, "");

  // capture qty at end: ×2 or x2
  let qty = "";
  const qtyMatch = s.match(/(?:×|x)\s*(\d+)\s*$/i);
  if (qtyMatch) {
    qty = qtyMatch[1];
    s = s.replace(/(?:×|x)\s*\d+\s*$/i, "").trim();
  }

  // remove any ($price) anywhere
  s = s.replace(/\(\s*\$[\d.,]+\s*\)/g, "").trim();

  // convert multiplication sign to normal x (just in case)
  s = s.replace(/×/g, "x");

  // remove control chars that printers show as \c\2 etc
  s = s.replace(/[\x00-\x1F\x7F]/g, "");

  // normalize spaces
  s = s.replace(/\s+/g, " ").trim();

  // re-apply qty in a clean way
  if (qty) s = `${qty}x ${s}`;

  return s;
}

function parseSquareHTML(html) {
  const $ = cheerio.load(html);

  const phoneRegex = /\(\d{3}\)\s*\d{3}-\d{4}/;

  // -------------------------
  // CUSTOMER (Arthur Ju)
  // -------------------------
  // In your email this is inside table.table-date-and-tenders, left column
  let phone = "";
  let customer = "UNKNOWN";

  $('td').each((i,el)=>{
    const txt = $(el).text().trim();

    const match = txt.match(/\(\d{3}\)\s*\d{3}-\d{4}/);
    if(match){
      phone = match[0]; // ONLY phone, stop before email
      customer = $(el).prev().text().trim() || "UNKNOWN";
    }
  });

  // -------------------------
  // NOTE (same <tr>: label + value)
  // -------------------------
  let note = "";
  const noteRow = $("div.pickup-fulfillment-title.p:contains('Notes')").first().closest("tr");
  if (noteRow.length) {
    note = noteRow.find("div.pickup-info.p").first().text().trim();
  }

  // -------------------------
  // ESTIMATE + ORDER TYPE
  // -------------------------
  let estimate = "";
  let orderType = "Square Pickup";

  const pickupRow = $("div.pickup-fulfillment-title.p:contains('Estimated Pickup Time')")
    .first()
    .closest("tr");
  const deliveryRow = $("div.pickup-fulfillment-title.p:contains('Estimated Delivery Time')")
    .first()
    .closest("tr");

  if (pickupRow.length) {
    estimate = pickupRow.find("div.pickup-info.p").first().text().trim();
    orderType = "Square Pickup";
  } else if (deliveryRow.length) {
    estimate = deliveryRow.find("div.pickup-info.p").first().text().trim();
    orderType = "Square Delivery";
  }

  // -------------------------
  // ITEMS + MODIFIERS (ONLY tr.item-row are items)
  // -------------------------
  const items = [];
  let current = null;

  const table = $("table.table-payment-info").first();
  const rows = table.find("tr");

  rows.each((_, tr) => {
    const $tr = $(tr);

    // NEW ITEM
    if ($tr.hasClass("item-row")) {

  let name = $tr.find("h2.item-name").first().text().trim();
  if (!name) return;

  let qty = 1;

  // check if Square injected qty like:
  // "Dozen Donut Holes × 4"
  // OR decoded garbage: "Dozen Donut Holes c\ 4"
  let match =
    name.match(/[x×]\s*(\d+)\s*$/i) ||
    name.match(/c\\\s*(\d+)\s*$/i);

  if (match) {
    qty = parseInt(match[1]);
    name = name.replace(match[0], "").trim();
  }

  current = { item: `${qty}x ${name}`, modifiers: [] };
  items.push(current);
  return;
}

    // MODIFIER ROW (only if we already have an item)
    const isModifier = $(tr).find('td.item-modifier-name').length > 0;

  const name = $(tr).find('div.p').first().text().trim();

  if(!name) return;

// MODIFIER
if (isModifier && current) {
  const raw = $(tr).find("div.p").first().text();
  const mod = cleanModifierText(raw);
  if (mod) current.modifiers.push(mod);
  return;
}

  });

  // total items = number of item rows
  const totalItems = String(items.length);

  return { customer, orderType, phone, totalItems, estimate, note, items };
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
// CHECK EMAIL (GH + SQ)
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

    const sq = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread label:SQ_PRINT",
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
else if (sq.data.messages?.length) {
  messageId = sq.data.messages[0].id;
  platform = "SQ";
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

    if (platform === "SQ") {

  const headers = msg.data.payload.headers;

  const subject =
    headers.find(h => h.name === "Subject")?.value || "";

  // Extract Square order ID
  let orderId = "";
  const match = subject.match(/Order\s*#(\d+)/i);
  if (match) {
    orderId = match[1];
  }

  const html = getHtmlBody(msg.data.payload)
    .replace(/\u00A0/g, " ")
    .replace(/\t/g, " ")
    .replace(/\r/g, "")
    .replace(/[ ]+/g, " ");

  parsed = parseSquareHTML(html);

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

    const id = Math.random().toString(36).substring(2,10);
    const jobBuf = buildReceipt(
      parsed.customer,
      parsed.orderType,
      parsed.phone,
      parsed.totalItems,
      parsed.items,
      parsed.estimate,
      parsed.note
    );

    activeJobs.set(id, jobBuf);
    pending.push(id);

    console.log("QUEUE ADDED:", id);

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
// ADVANCED CLOUDPRNT ENDPOINTS
// --------------------

const CLOUDPRNT_PATHS = [
  "/starcloudprnt",
  "/StarCloudPRNT",
  "/cloudprnt",
  "/CloudPRNT"
];

function handleCloudPrntPoll(req, res) {
  if (printerStoppedLogged) {
    console.log("Printer polling resumes");
  }

  lastPrinterPollAt = Date.now();
  printerStoppedLogged = false;

  const isOpen = isBusinessHours();

  const pollInterval = isOpen
    ? OPEN_POLL_INTERVAL_SECONDS
    : CLOSED_POLL_INTERVAL_SECONDS;

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
}

function handleCloudPrntJobDownload(req, res) {
  const token = req.query.token || req.query.jobToken || req.query.jobid || req.query.jobId;

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
}

app.post(CLOUDPRNT_PATHS, handleCloudPrntPoll);
app.get(CLOUDPRNT_PATHS, handleCloudPrntJobDownload);
app.post("/", handleCloudPrntPoll);


  app.get("/", (req,res)=>{
  if (req.query.token || req.query.jobToken || req.query.jobid || req.query.jobId) {
    return handleCloudPrntJobDownload(req, res);
  }

  res.json({
    ok: true,
    cloudPrntPaths: CLOUDPRNT_PATHS,
    pendingJobs: pending.length,
    businessHours: isBusinessHours()
  });
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
  }, EMAIL_POLL_INTERVAL_MS);
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

  if (!emailStoppedLogged && now - lastEmailPollAt > POLLING_WATCHDOG_MS) {
    console.log("email has stopped polling 5 minutes ago");
    emailStoppedLogged = true;
  }

  if (!printerStoppedLogged && now - lastPrinterPollAt > POLLING_WATCHDOG_MS) {
    console.log("printer has stopped polling 5 minutes ago");
    printerStoppedLogged = true;
  }
}, 30000);

app.get("/restart", (req, res) => {
  console.log("MANUAL RESTART TEST");
  res.send("Restart test triggered...");
  setTimeout(() => process.exit(0), 1000);
});

app.post("/ubereats", (req, res) => {

  console.log("📦 UBER RAW RECEIVED");

  if (!UBER_SECRET) {
    console.log("❌ UBER_SECRET is not configured");
    return res.sendStatus(503);
  }
  
  console.log("HEADERS:", req.headers);
console.log("BODY:", req.body.toString());

  const signature = req.headers["x-uber-signature"];

  const expected = crypto
    .createHmac("sha256", UBER_SECRET)
    .update(req.body)
    .digest("hex");

  if (signature !== expected) {
    console.log("❌ INVALID SIGNATURE");
    return res.sendStatus(401);
  }

  console.log("✅ UBER VERIFIED");

  let order;

  try {
    order = JSON.parse(req.body.toString());
  } catch (e) {
    console.log("❌ JSON PARSE ERROR");
    return res.sendStatus(400);
  }

  console.log(JSON.stringify(order, null, 2));

  res.sendStatus(200);
});


app.get("/ubereats", (req, res) => {
  res.send("Uber webhook live");
});

app.get("/clear-jobs", (req, res) => {
  if (!CLEAR_JOBS_KEY) {
    console.log("CLEAR_JOBS_KEY is not configured");
    return res.status(503).send("Clear jobs endpoint is not configured.");
  }

  if (req.query.key !== CLEAR_JOBS_KEY) {
    return res.status(401).send("Unauthorized");
  }

  const count = pending.length;

  pending.length = 0;
  activeJobs.clear();

  console.log(`CLEARED ${count} UNPRINTED JOBS`);

  return res.send(`Success: ${count} unprinted jobs cleared.`);
});
app.listen(PORT, () => {
  console.log(`SERVER RUNNING on port ${PORT}`);
});
