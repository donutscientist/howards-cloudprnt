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
function parseSquare(body){

  // ⭐ CUT OFF RECEIPT FOOTER FIRST
body = body.split("Reply to this email")[0];

body = body
  .replace(/\r/g,"")
  .replace(/\u00A0/g," ")
  .replace(/[ ]+/g," ");
const lines = body
  .split("\n")
  .map(l=>l.trim())
  .filter(Boolean);
  // --------------------
  // ESTIMATE + ORDER TYPE
  // --------------------
  let estimate="";
  let orderType="Square Pickup";

  for(let i=0;i<lines.length;i++){

  if(lines[i].includes("Estimated Pickup Time")){
    estimate=lines[i+1]||"";
    orderType="Square Pickup";
  }

  if(lines[i].includes("Estimated Delivery Time")){
    estimate=lines[i+1]||"";
    orderType="Square Delivery";
  }
}

  // --------------------
  // NOTE
  // --------------------
  let note="";
  const noteIndex=lines.findIndex(l=>l==="Notes");
  if(noteIndex!==-1){
    note=lines[noteIndex+1]||"";
  }

  // --------------------
  // CUSTOMER + PHONE (BOTTOM BLOCK)
  // --------------------
  let phone="";
  let customer="UNKNOWN";

  const phoneRegex=/\(\d{3}\)\s*\d{3}-\d{4}/;

  for(let i=lines.length-1;i>=0;i--){
    if(phoneRegex.test(lines[i])){
      phone=lines[i];
      customer=lines[i-1]||"UNKNOWN";
      break;
    }
  }

  // --------------------
  // ITEMS
  // --------------------
  const items=[];
let start = lines.findIndex(l=>l==="Order Summary");

if(start === -1) return {
  customer,
  orderType,
  phone,
  totalItems:"0",
  estimate,
  note,
  items:[]
};

for(let i=start;i<lines.length;i++){

  const l = lines[i];

  if(
    !l.startsWith("$") &&
    !l.includes("Estimated") &&
    !l.includes("Pickup") &&
    !l.includes("Delivery") &&
    !l.includes("Savings") &&
    !l.includes("Total") &&
    !l.includes("Notes") &&
    !l.includes("Customer") &&
    !l.includes("Phone") &&
    !l.includes("Reply") &&
    !l.includes("View") &&
    !l.includes("http") &&
    !phoneRegex.test(l) &&
    l.length > 3 &&
    !l.match(/^\d+$/) &&
    lines[i+1]?.startsWith("$")
  ){
    items.push({
      item:`1x ${l}`,
      modifiers:[]
    });
  }
}

    if(
      current &&
      (
        l.startsWith("▪") ||
        l.startsWith("➕") ||
        l.startsWith("+")
      )
    ){

      current.modifiers.push(
        l.replace(/^[▪➕+]\s*/,"").trim()
      );continue;
    }
  }

  return{
    customer,
    orderType,
    phone,
    totalItems:items.length.toString(),
    estimate,
    note,
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
      // Use text/plain for Square (THIS FIXES YOUR WRONG INFO ISSUE)
      const plain = getPlainBody(msg.data.payload);
      parsed = parseSquare(
  decodeQuotedPrintable(plain)
);
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