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

// --------------------
// SQUARE PARSER (USES text/plain from the email)
// --------------------
function parseSquareFromPlain(plainRaw) {
  // decode quoted-printable and normalize
  const plain = decodeQuotedPrintable(plainRaw)
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ ]+/g, " ");

  const lines = plain
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // ----- estimate + orderType -----
  let estimate = "";
  let orderType = "Square Pickup";

  const idxPickup = lines.findIndex((l) => /^Estimated Pickup Time$/i.test(l));
  const idxDelivery = lines.findIndex((l) => /^Estimated Delivery Time$/i.test(l));

  if (idxDelivery !== -1 && lines[idxDelivery + 1]) {
    estimate = lines[idxDelivery + 1];
    orderType = "Square Delivery";
  } else if (idxPickup !== -1 && lines[idxPickup + 1]) {
    estimate = lines[idxPickup + 1];
    orderType = "Square Pickup";
  }

  // ----- note (only if present) -----
  let note = "";
  const idxNotes = lines.findIndex((l) => /^Notes$/i.test(l));
  if (idxNotes !== -1 && lines[idxNotes + 1]) {
    const maybe = lines[idxNotes + 1];
    // Avoid accidentally grabbing "Order status" link text if formats change
    if (!/^Order status/i.test(maybe)) note = maybe;
  }

  // ----- customer + phone: take the LAST phone match (customer block is near bottom) -----
  const phoneRe = /\(\d{3}\)\s*\d{3}-\d{4}/;
  let phone = "";
  let customer = "UNKNOWN";

  for (let i = lines.length - 1; i >= 0; i--) {
    if (phoneRe.test(lines[i])) {
      phone = lines[i].match(phoneRe)[0];
      // previous non-empty line is customer name
      if (lines[i - 1] && !phoneRe.test(lines[i - 1])) customer = lines[i - 1];
      break;
    }
  }

  // ----- items + modifiers -----
  // Stop when we hit totals/payment sections
  const stopWords = new Set([
    "Total", "Savings", "Cash", "Shop Online", "Order status", "Pickup location"
  ]);

  const items = [];
  let currentItem = null;

  const isMoney = (s) => /^\$?\d+(\.\d{2})?$/.test(s);
  const isNoiseLine = (s) =>
    stopWords.has(s) ||
    /^Discount:/i.test(s) ||
    /^Reg Price$/i.test(s) ||
    /^Order #/i.test(s);

  const isModifierLine = (s) =>
    /^[▪•◦]/.test(s) ||          // bullets
    /^➕/.test(s) ||              // plus icon
    /^\+/.test(s);               // plus sign fallback

  // Heuristic: an item name is a line that:
  // - is not money / not noise
  // - within next 6 lines there is a money line (Square lists price below item)
  function looksLikeItemName(i) {
    const s = lines[i];
    if (!s) return false;
    if (isMoney(s)) return false;
    if (isModifierLine(s)) return false;
    if (isNoiseLine(s)) return false;

    // lookahead for a price nearby
    for (let k = 1; k <= 6; k++) {
      if (!lines[i + k]) break;
      if (isMoney(lines[i + k].replace(/[^\d.$]/g, ""))) return true;
      if (/^\$\d/.test(lines[i + k])) return true;
    }
    return false;
  }

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];

    if (stopWords.has(s) || /^Total$/i.test(s) || /^Savings$/i.test(s)) break;

    if (looksLikeItemName(i)) {
      currentItem = { item: `1x ${s}`, modifiers: [] };
      items.push(currentItem);
      continue;
    }

    if (currentItem && isModifierLine(s)) {
      const cleaned = s
        .replace(/^[▪•◦]\s*/g, "")
        .replace(/^➕\s*/g, "+ ")
        .replace(/^\+\s*/g, "+ ")
        .trim();
      if (cleaned) currentItem.modifiers.push(cleaned);
    }
  }

  return {
    customer,
    orderType,
    phone,
    totalItems: String(items.length),
    estimate, // will be printed on its own line
    note,     // will be printed under Total Items only if exists
    items
  };
}

// --------------------
// RECEIPT BUILDER
// NOTE placement: directly under Total Items
// --------------------
function buildReceipt(customer, orderType, phone, totalItems, items, estimate = "", note = "") {
  const buffers = [];
  buffers.push(Buffer.from([0x1B, 0x40])); // ESC @

  // Customer
  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" " + customer + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  // Order type
  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" " + orderType + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  // Phone
  if (phone) {
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" " + phone + "\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  // Total Items
  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" Total Items: " + totalItems + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  // NOTE under Total Items (ONLY if exists)
  if (note) {
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" NOTE: " + note + "\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  // Estimate time on its own line
  if (estimate) {
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" " + estimate + "\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  // Items
  for (const order of items) {
    buffers.push(Buffer.from("\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" "));
    buffers.push(Buffer.from([0x1B, 0x2D, 0x01])); // underline on
    buffers.push(Buffer.from(order.item + "\n"));
    buffers.push(Buffer.from([0x1B, 0x2D, 0x00])); // underline off
    buffers.push(Buffer.from([0x1B, 0x21, 0x00]));
    for (const mod of order.modifiers || []) {
      buffers.push(Buffer.from("    " + mod + "\n"));
    }
  }

  buffers.push(Buffer.from("\n"));
  buffers.push(Buffer.from([0x1B, 0x64, 0x03])); // feed 3
  buffers.push(Buffer.from([0x1D, 0x56, 0x00])); // cut

  return Buffer.concat(buffers);
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
      // Use text/plain for Square (THIS FIXES YOUR WRONG INFO ISSUE)
      const plain = getPlainBody(msg.data.payload);
      parsed = parseSquareFromPlain(plain);
    }

    if (!parsed) return;

    const id = Date.now().toString();
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
      jobToken: next
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