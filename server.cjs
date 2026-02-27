const cheerio = require("cheerio");
const express = require("express");
const { google } = require("googleapis");
const crypto = require("crypto");

const app = express();
app.use(express.raw({ type: "*/*" }));

// --------------------
// PRINT JOB QUEUE
// --------------------
const jobs = new Map();   // token -> Buffer
const pending = [];       // FIFO list of tokens

function newQueueId() {
  // Unique ID not related to email data
  return crypto.randomUUID();
}

function enqueueJob(buffer) {
  const token = newQueueId();
  jobs.set(token, buffer);
  pending.push(token);
  console.log("QUEUE ADDED:", token, "PENDING:", pending.length);
  return token;
}

// --------------------
// GMAIL AUTH
// --------------------
const auth = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);

auth.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN,
});

const gmail = google.gmail({ version: "v1", auth });

// --------------------
// EMAIL BODY EXTRACT
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

function getBody(payload) {
  function walk(part) {
    if (!part) return "";

    if (part.mimeType === "text/html" && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }

    if (part.parts) {
      for (const p of part.parts) {
        const result = walk(p);
        if (result) return result;
      }
    }
    return "";
  }
  return walk(payload);
}

// --------------------
// ORDER ID PARSER (IMPROVED)
// --------------------
function extractOrderId(html) {
  // 1) try text-only (most reliable vs raw HTML)
  const $ = cheerio.load(html);
  const text = $("body").text()
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Common patterns seen in GH emails:
  // "Order: #76653270-2645821"
  // "Order # 76653270-2645821"
  // "Order number 76653270-2645821"
  let m =
    text.match(/Order\s*(?:Number|ID)?\s*#?\s*[:\-]?\s*([0-9]{5,}(?:-[0-9]{3,})+)/i) ||
    text.match(/#\s*([0-9]{5,}(?:-[0-9]{3,})+)/);

  if (m) return m[1].trim();

  // 2) fallback: raw HTML (sometimes the text is broken)
  const cleanHtml = html
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ");

  m =
    cleanHtml.match(/Order\s*(?:Number|ID)?\s*#?\s*[:\-]?\s*([0-9]{5,}(?:-[0-9]{3,})+)/i) ||
    cleanHtml.match(/#\s*([0-9]{5,}(?:-[0-9]{3,})+)/);

  return m ? m[1].trim() : "UNKNOWN";
}

// --------------------
// GRUBHUB PARSE
// --------------------
function parseGrubHub(html) {
  const $ = cheerio.load(html);

  const hidden = $('[data-section="grubhub-order-data"]');

  const orderId = extractOrderId(html);
  console.log("PARSED ORDER ID:", orderId);

  const phone =
    hidden.find('[data-field="phone"]').text().trim() ||
    $('a[href^="tel:"]').first().text().trim() ||
    "";

  const service = hidden.find('[data-field="service-type"]').text().trim();
  const orderType =
    service.toLowerCase().includes("delivery") ? "GrubHub Delivery" :
    service.toLowerCase().includes("pickup") ? "GrubHub Pickup" :
    $('div:contains("Deliver to:")').length ? "GrubHub Delivery" :
    $('div:contains("Pickup by:")').length ? "GrubHub Pickup" :
    "GrubHub Pickup";

  let customer = "UNKNOWN";
  const deliverLabel = $('div').filter((i, el) => $(el).text().trim() === "Deliver to:").first();
  if (deliverLabel.length) {
    customer = deliverLabel.next("div").text().trim() || customer;
  } else {
    const pickupLabel = $('div').filter((i, el) => $(el).text().trim() === "Pickup by:").first();
    if (pickupLabel.length) customer = pickupLabel.next("div").text().trim() || customer;
  }

  let totalItems = "0";
  const totalP = $("p")
    .filter((i, el) => /\b\d+\s*item\b/i.test($(el).text().replace(/\s+/g, " ").trim()))
    .first();

  if (totalP.length) {
    const mm = totalP.text().replace(/\s+/g, " ").match(/(\d+)\s*item/i);
    if (mm) totalItems = mm[1];
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

    // group duplicates -> "2x ___"
    const counter = {};
    for (const m of currentItem.modifiers) counter[m] = (counter[m] || 0) + 1;
    currentItem.modifiers = Object.entries(counter).map(([n, q]) =>
      q === 1 ? n : `${q}x ${n}`
    );

    items.push(currentItem);
  });

  return { customer, orderType, phone, totalItems, orderId, items };
}

// --------------------
// BUILD STARPRNT JOB
// --------------------
function buildReceipt(customer, orderType, phone, totalItems, items, orderId) {
  const buffers = [];
  buffers.push(Buffer.from([0x1B, 0x40])); // ESC @ init

  // customer
  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" " + customer + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  // order type
  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" " + orderType + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  // phone
  if (phone) {
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" " + phone + "\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x00]));
  }

  // order id (DO NOT BLOCK PRINTING if unknown)
  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from(" Order: " + (orderId || "UNKNOWN") + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  // total items
  buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
  buffers.push(Buffer.from("Total Items: " + totalItems + "\n"));
  buffers.push(Buffer.from([0x1B, 0x45, 0x00]));

  for (const order of items) {
    buffers.push(Buffer.from("\n"));
    buffers.push(Buffer.from([0x1B, 0x45, 0x01]));
    buffers.push(Buffer.from(" "));
    buffers.push(Buffer.from([0x1B, 0x2D, 0x01])); // underline on
    buffers.push(Buffer.from(order.item + "\n"));
    buffers.push(Buffer.from([0x1B, 0x2D, 0x00])); // underline off
    buffers.push(Buffer.from([0x1B, 0x21, 0x00]));
    for (const mod of order.modifiers) {
      buffers.push(Buffer.from("    " + mod + "\n"));
    }
  }

  buffers.push(Buffer.from("\n"));
  buffers.push(Buffer.from([0x1B, 0x64, 0x03])); // feed 3
  buffers.push(Buffer.from([0x1D, 0x56, 0x00])); // cut

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
      maxResults: 1,
    });

    if (!gh.data.messages?.length) return;

    const messageId = gh.data.messages[0].id;
    console.log("EMAIL FOUND: GH", messageId);

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    let body = getBody(msg.data.payload);
    body = body
      .replace(/\u00A0/g, " ")
      .replace(/\t/g, " ")
      .replace(/\r/g, "");

    const parsed = parseGrubHub(body);

    const receipt = buildReceipt(
      parsed.customer,
      parsed.orderType,
      parsed.phone,
      parsed.totalItems,
      parsed.items,
      parsed.orderId
    );

    enqueueJob(receipt);

    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });

    console.log("PRINT JOB ADDED");
  } catch (e) {
    console.log("CHECK EMAIL ERROR:", e.message);
  }
}

// --------------------
// TEST ROUTE
// --------------------
app.get("/createjob", (req, res) => {
  const test = Buffer.from([
    0x1b, 0x40,
    0x1b, 0x61, 0x01,
    0x1b, 0x21, 0x30,
    0x54, 0x45, 0x53, 0x54,
    0x0a, 0x0a,
    0x1b, 0x64, 0x03,
    0x1d, 0x56, 0x00,
  ]);

  const token = enqueueJob(test);
  res.send("Test job created: " + token);
});

// --------------------
// STAR CLOUDPRNT ENDPOINTS
// --------------------
app.post("/starcloudprnt", (req, res) => {
  const token = pending.length ? pending[0] : "";

  // IMPORTANT: jobToken is returned in POST, printer will request GET ?token=jobToken
  res.json({
    jobReady: !!token,
    mediaTypes: ["application/vnd.star.starprnt"],
    jobToken: token,
  });
});

app.get("/starcloudprnt", (req, res) => {
  // Most Star clients use `token`. Some might use `jobToken`.
  const token = req.query.token || req.query.jobToken || "";

  console.log("PRINTER REQUESTED:", token);
  console.log("PENDING:", pending.length);

  if (token && jobs.has(token)) {
    const job = jobs.get(token);

    jobs.delete(token);
    // remove ONLY the first matching token (FIFO safe)
    const idx = pending.indexOf(token);
    if (idx >= 0) pending.splice(idx, 1);

    res.setHeader("Content-Type", "application/vnd.star.starprnt");
    res.setHeader("Content-Length", job.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(job);
  }

  return res.status(204).send();
});

// --------------------
// LOOP
// --------------------
setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});