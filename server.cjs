const cheerio = require("cheerio");
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.raw({ type: "*/*" }));

// --------------------
// CLOUDPRNT QUEUE
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

function decodeQuotedPrintable(input) {
  if (!input) return "";
  let s = input.replace(/=\r?\n/g, "");
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

function getHtmlBody(payload) {
  return getPartText(payload, "text/html");
}

function getPlainBody(payload) {
  return getPartText(payload, "text/plain");
}

// --------------------
// GRUBHUB PARSER (YOUR SAME)
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
// SQUARE PARSER (FIXED: text/plain, NO CUT, BLOCK PARSE)
// --------------------
function parseSquare(plainText) {
  const phoneRegex = /\(\d{3}\)\s*\d{3}-\d{4}/;
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

  // Normalize
  const lines = (plainText || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .split("\n")
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Helpers
  const isNoise = (l) => {
    const s = l.toLowerCase();
    return (
      s.includes("reply to this email") ||
      s.includes("view your full receipt") ||
      s.includes("your full receipt has") ||
      s.includes("run your own business") ||
      s.includes("get started with square") ||
      s.includes("square just got more") ||
      s.includes("receipt settings") ||
      s.includes("square privacy") ||
      s.includes("learn more") ||
      s.includes("update preferences") ||
      s.includes("squareup.com") ||
      s.includes("a.squareupmessaging.com") ||
      s.startsWith("http")
    );
  };

  const isMoney = (l) => /^\$\d/.test(l);
  const isSummaryLine = (l) => {
    const s = l.toLowerCase();
    return (
      s.includes("subtotal") ||
      s.includes("tax") ||
      s.includes("tip") ||
      s.includes("total") ||
      s.includes("discount") ||
      s.includes("savings") ||
      s === "reg price" ||
      s.includes("order #") ||
      s.includes("shop online")
    );
  };

  // Order type + estimate
  let estimate = "";
  let orderType = "Square Pickup";
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].toLowerCase();
    if (s === "estimated pickup time") {
      estimate = lines[i + 1] || "";
      orderType = "Square Pickup";
    }
    if (s === "estimated delivery time") {
      estimate = lines[i + 1] || "";
      orderType = "Square Delivery";
    }
  }

  // Note
  let note = "";
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].toLowerCase();
    if (s === "notes" || s === "notes:") {
      note = lines[i + 1] || "";
      break;
    }
  }

  // Customer block (use LAST “real” phone, not store phone)
  // Store phone is often (901) 213-1100; customer is usually different.
  let customer = "UNKNOWN";
  let phone = "";
  let customerEmail = "";

  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(phoneRegex);
    if (m) {
      const candidatePhone = m[0];
      // Skip obvious store phone if it appears
      if (candidatePhone === "(901) 213-1100") continue;

      phone = candidatePhone;
      const maybeName = lines[i - 1] || "";
      customer = maybeName && !isNoise(maybeName) ? maybeName : "UNKNOWN";

      // often email is next line after phone
      const maybeEmail = lines[i + 1] || "";
      if (emailRegex.test(maybeEmail)) customerEmail = maybeEmail;

      break;
    }
  }

  // Items parsing:
  // Detect item header lines (not noise, not money, not summary),
  // then collect bullet/plus modifier lines that follow.
  const items = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    if (isNoise(l)) continue;

    // modifier lines
    if (current && (/^[▪➕+]/.test(l))) {
      const mod = l.replace(/^[▪➕+]\s*/, "").trim();
      if (mod) current.modifiers.push(mod);
      continue;
    }

    // ignore money + summary junk
    if (isMoney(l) || isSummaryLine(l) || phoneRegex.test(l)) continue;

    // candidate item name:
    // look ahead a bit: Square usually shows "$0.00" then "Reg Price" then "$X.XX"
    const look = lines.slice(i + 1, i + 12).join(" ");
    const hasPriceSoon = /\$\d/.test(look) && look.toLowerCase().includes("reg price");

    if (hasPriceSoon) {
      current = { item: `1x ${l}`, modifiers: [] };
      items.push(current);
    }
  }

  // de-dupe modifiers a bit
  for (const it of items) {
    const counter = {};
    for (const m of it.modifiers) counter[m] = (counter[m] || 0) + 1;
    it.modifiers = Object.entries(counter).map(([n, q]) => (q === 1 ? n : `${q}x ${n}`));
  }

  // If you want email printed too, append to customer line:
  const customerLine =
    customerEmail ? `${customer} (${customerEmail})` : customer;

  return {
    customer: customerLine,
    orderType,
    phone,
    totalItems: String(items.length),
    estimate,
    note,
    items
  };
}

// --------------------
// RECEIPT BUILDER (UNCHANGED)
// --------------------
function buildReceipt(customer, orderType, phone, totalItems, items, estimate = "", note = "") {
  const buffers = [];
  buffers.push(Buffer.from([0x1B, 0x40])); // ESC @

  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" " + customer + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" " + orderType + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  if (phone) {
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" " + phone + "\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" Total Items: " + totalItems + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  if (note) {
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" NOTE: " + note + "\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  if (estimate) {
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" " + estimate + "\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  for (const order of items) {
    buffers.push(Buffer.from("\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" "));
    buffers.push(Buffer.from([0x1B, 0x2D, 0x01]));
    buffers.push(Buffer.from(order.item + "\n"));
    buffers.push(Buffer.from([0x1B, 0x2D, 0x00]));
    buffers.push(Buffer.from([0x1B, 0x21, 0x00]));

    for (const mod of order.modifiers || []) {
      buffers.push(Buffer.from("    " + mod + "\n"));
    }
  }

  buffers.push(Buffer.from("\n"));
  buffers.push(Buffer.from([0x1B, 0x64, 0x03]));
  buffers.push(Buffer.from([0x1D, 0x56, 0x00]));
  return Buffer.concat(buffers);
}

// --------------------
// CHECK EMAIL
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
      const plainRaw = getPlainBody(msg.data.payload);
      const plain = decodeQuotedPrintable(plainRaw);

      parsed = parseSquare(plain);

      // quick debug (remove later)
      console.log("SQ PARSED:", {
        customer: parsed.customer,
        phone: parsed.phone,
        totalItems: parsed.totalItems
      });
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
// CLOUDPRNT ENDPOINTS
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

  if (!token || !activeJobs.has(token)) return res.status(204).send();

  const job = activeJobs.get(token);

  res.setHeader("Content-Type", "application/vnd.star.starprnt");
  res.setHeader("Content-Length", job.length);
  res.setHeader("Cache-Control", "no-store");
  res.send(job);

  activeJobs.delete(token);
  pending = pending.filter((t) => t !== token);

  console.log("PRINTED:", token);
});

setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});