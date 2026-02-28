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
  if (!data) return "";
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/").padEnd(data.length + (4 - (data.length % 4)) % 4, "="),
    "base64"
  ).toString("utf8");
}

function decodeQuotedPrintable(input) {
  if (!input) return "";
  let s = input.replace(/=\r?\n/g, ""); // remove soft breaks
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
// GRUBHUB PARSER (UNCHANGED)
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
// SQUARE PARSER (TEXT/PLAIN ONLY)
// --------------------
function parseSquare(plainBody) {
  let body = (plainBody || "").replace(/\r/g, "\n").replace(/\u00A0/g, " ");

  // ✅ ONLY cut at true footer markers (DON'T cut at "squareup.com")
  const footerRe = /(Reply to this email|View your full receipt)/i;
  const m = body.match(footerRe);
  if (m && m.index !== undefined) body = body.slice(0, m.index);

  const lines = body
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Estimate + type
  let estimate = "";
  let orderType = "Square Pickup";
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].toLowerCase();
    if (t === "estimated pickup time") {
      estimate = lines[i + 1] || "";
      orderType = "Square Pickup";
    }
    if (t === "estimated delivery time") {
      estimate = lines[i + 1] || "";
      orderType = "Square Delivery";
    }
  }

  // Notes
  let note = "";
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].toLowerCase();
    if (t === "notes" || t === "notes:") {
      note = (lines[i + 1] || "").trim();
      break;
    }
  }

  // Customer + phone: use LAST phone = customer phone (store phone appears earlier)
  const phoneRegex = /\(\d{3}\)\s*\d{3}-\d{4}/;
  const phones = lines.flatMap((l) => (l.match(phoneRegex) ? [l.match(phoneRegex)[0]] : []));
  const phone = phones.length ? phones[phones.length - 1] : "";

  let customer = "UNKNOWN";
  if (phone) {
    // find the line that contains the last phone, then walk upward for a clean name
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (phoneRegex.test(lines[i])) { idx = i; break; }
    }
    for (let j = idx - 1; j >= 0; j--) {
      const cand = lines[j];
      if (!cand) continue;
      if (cand.includes("@")) continue;
      if (/howard/i.test(cand)) continue;
      if (/order|pickup|delivery|estimated|notes/i.test(cand.toLowerCase())) continue;
      customer = cand;
      break;
    }
  }

  // Items: Square pattern is Name then a $ line soon after (often "$0.00"), then "Reg Price"
  const items = [];
  let current = null;

  const isJunk = (l) => {
    const s = l.toLowerCase();
    return (
      s.startsWith("$") ||
      s === "reg price" ||
      s.includes("discount") ||
      s.includes("savings") ||
      s.includes("subtotal") ||
      s.includes("tax") ||
      s.includes("tip") ||
      s.includes("total") ||
      s.includes("order summary") ||
      s.includes("estimated") ||
      s.includes("notes") ||
      s.includes("reply") ||
      s.includes("view") ||
      s.includes("http") ||
      phoneRegex.test(l)
    );
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    // modifiers
    if (current && /^[▪➕+]/.test(l)) {
      const mod = l.replace(/^[▪➕+]\s*/, "").trim();
      if (mod) current.modifiers.push(mod);
      continue;
    }

    // item name
    if (!isJunk(l)) {
      const lookahead = lines.slice(i + 1, i + 6).join(" ");
      const hasPriceSoon = /\$\d/.test(lookahead); // catches $0.00 too
      if (hasPriceSoon) {
        current = { item: `1x ${l}`, modifiers: [] };
        items.push(current);
      }
    }
  }

  return {
    customer,
    orderType,
    phone,
    totalItems: String(items.length),
    estimate,
    note,
    items
  };
}

// --------------------
// RECEIPT BUILDER
// --------------------
function buildReceipt(customer, orderType, phone, totalItems, items, estimate = "", note = "") {
  const buffers = [];
  buffers.push(Buffer.from([0x1B, 0x40])); // init

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
      // ✅ Square: parse text/plain (this is where your real order is)
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

// --------------------
// LOOP
// --------------------
setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});