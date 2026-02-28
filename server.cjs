const cheerio = require("cheerio");
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.raw({ type: "*/*" }));

// --------------------
// ADVANCED CLOUDPRNT QUEUE
// --------------------
let activeJobs = new Map(); // token -> Buffer
let pending = [];           // tokens FIFO

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

// Gmail message parts often contain quoted-printable text (with =20, soft wraps "=\n")
function decodeQuotedPrintable(input) {
  if (!input) return "";

  // Remove soft line breaks
  let s = input.replace(/=\r?\n/g, "");

  // Convert =XX hex escapes
  s = s.replace(/=([A-Fa-f0-9]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );

  return s;
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

  let totalItems = "0";
  const totalP = $("p")
    .filter((i, el) => /\b\d+\s*item\b/i.test($(el).text().replace(/\s+/g, " ").trim()))
    .first();
  if (totalP.length) {
    const m = totalP.text().replace(/\s+/g, " ").match(/(\d+)\s*item/i);
    if (m) totalItems = m[1];
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
  b.push(Buffer.from([0x1B, 0x45, 0x01])); line(customer, " ");  b.push(Buffer.from([0x1B, 0x45, 0x00]));
  b.push(Buffer.from([0x1B, 0x45, 0x01])); line(orderType, " "); b.push(Buffer.from([0x1B, 0x45, 0x00]));

  if (phone) {
    b.push(Buffer.from([0x1B, 0x45, 0x01])); line(phone, " "); b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  b.push(Buffer.from([0x1B, 0x45, 0x01])); line(`Total Items: ${totalItems}`, " "); b.push(Buffer.from([0x1B, 0x45, 0x00]));

  if (note) {
    b.push(Buffer.from([0x1B, 0x45, 0x01]));
    line(`NOTE: ${note}`, " "); // also hard-cut
    b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  if (estimate) {
    b.push(Buffer.from([0x1B, 0x45, 0x01])); line(estimate, " "); b.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  // Items + modifiers
  for (const order of items) {
    b.push(Buffer.from("\n"));

    // ITEM: keep your indentation + styles, but still hard-cut
    b.push(Buffer.from([0x1B, 0x45, 0x01])); // bold
    b.push(Buffer.from([0x1B, 0x2D, 0x01])); // underline
    line(order.item, " "); // <-- item indent (change to "  " if you want 2 spaces)
    b.push(Buffer.from([0x1B, 0x2D, 0x00])); // underline off
    b.push(Buffer.from([0x1B, 0x45, 0x00])); // bold off

    // MODS: 4-space indent, hard-cut
    for (const mod of order.modifiers || []) {
      line(mod, "    ");
    }
  }

  b.push(Buffer.from("\n"));
  b.push(Buffer.from([0x1B, 0x64, 0x03])); // feed 3
  b.push(Buffer.from([0x1D, 0x56, 0x00])); // cut
  return Buffer.concat(b);
}

  buffers.push(Buffer.from("\n"));
  buffers.push(Buffer.from([0x1B, 0x64, 0x03])); // feed 3
  buffers.push(Buffer.from([0x1D, 0x56, 0x00])); // cut

  return Buffer.concat(buffers);
}
function getSquarePlain(payload){

  function walk(part){

    if(!part) return "";

    if(part.mimeType === "text/plain" && part.body?.data){

      let raw = Buffer
        .from(part.body.data,"base64")
        .toString("utf8");

      // REMOVE SOFT WRAPS
      raw = raw.replace(/=\r?\n/g,"");

      // DECODE =20 etc
      raw = raw.replace(/=([A-Fa-f0-9]{2})/g,
        (_,hex)=>String.fromCharCode(parseInt(hex,16))
      );

      return raw;
    }

    if(part.parts){
      for(const p of part.parts){
        const r = walk(p);
        if(r) return r;
      }
    }

    return "";
  }

  return walk(payload);
}
// --------------------
// CHECK EMAIL (GH + SQ)
// --------------------
async function checkEmail() {
  try {
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

    let messageId = null;
    let platform = null;

    if (gh.data.messages?.length) {
      messageId = gh.data.messages[0].id;
      platform = "GH";
    } else if (sq.data.messages?.length) {
      messageId = sq.data.messages[0].id;
      platform = "SQ";
    } else {
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
      const html = getHtmlBody(msg.data.payload)
        .replace(/\u00A0/g, " ")
        .replace(/\t/g, " ")
        .replace(/\r/g, "")
        .replace(/[ ]+/g, " ");
      parsed = parseGrubHub(html);
    }

    if (platform === "SQ") {

  const html = getHtmlBody(msg.data.payload)
    .replace(/\u00A0/g, " ")
    .replace(/\t/g, " ")
    .replace(/\r/g, "")
    .replace(/[ ]+/g, " ");

  parsed = parseSquareHTML(html);
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
app.post("/starcloudprnt", (req, res) => {
  console.log("PRINTER POLLED");

  if (pending.length > 0) {
  const next = pending[0];

  return res.json({
    jobReady: true,
    mediaTypes: ["application/vnd.star.starprnt"],
    jobToken: next,
    contentType: "application/vnd.star.starprnt"
  });
}

  res.json({ jobReady: false });
});

app.get("/starcloudprnt", (req, res) => {
  const token = req.query.token || req.query.jobToken || req.query.jobid;

  console.log("PRINTER REQUESTED:", token);
  console.log("PENDING:", pending);

  if (!token || !activeJobs.has(token)) {
    return res.status(204).send();
  }

  const job = activeJobs.get(token);

  res.setHeader("Content-Type", "application/vnd.star.starprnt");
  res.setHeader("Content-Length", job.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(job);

  activeJobs.delete(token);
  pending = pending.filter((t) => t !== token);

  console.log("PRINTED:", token);
});

// --------------------
// LOOP
// --------------------
setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});