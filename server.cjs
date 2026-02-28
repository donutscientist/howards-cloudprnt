const cheerio = require("cheerio");
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.raw({ type: "*/*" }));

// --------------------
// PRINT JOB QUEUE
// --------------------
let activeJobs = new Map();
let pending = [];

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
function decodeBase64Url(data){
  return Buffer.from(
    data
      .replace(/-/g,'+')
      .replace(/_/g,'/')
      .padEnd(data.length + (4 - data.length % 4) % 4,'='),
    'base64'
  ).toString('utf8');
}

function getBody(payload){

  function walk(part){

    if(!part) return "";

    if(part.mimeType==="text/html" && part.body?.data){

      return Buffer
        .from(part.body.data,"base64")
        .toString("utf8");
    }

    if(part.parts){
      for(const p of part.parts){
        const result = walk(p);
        if(result) return result;
      }
    }

    return "";
  }

  return walk(payload);
}

function parseSquare(body){

  body = body
    .replace(/\r/g,"")
    .replace(/\u00A0/g," ")
    .replace(/[ ]+/g," ");

  // --------------------
  // CUSTOMER
  // --------------------
  const custMatch = body.match(/\n\s*([A-Z][a-z]+\s[A-Z][a-z]+)\s*\n/);
  const customer = custMatch ? custMatch[1] : "UNKNOWN";

  // --------------------
  // PHONE
  // --------------------
  const phoneMatch = body.match(/\(\d{3}\)\s*\d{3}-\d{4}/);
  const phone = phoneMatch ? phoneMatch[0] : "";

  // --------------------
  // ESTIMATED TIME
  // --------------------
  let estimate = "";
  let orderType = "Square Pickup";

  const pickup = body.match(/Pickup\s+time\s*:\s*(.+)/i);
  const delivery = body.match(/Delivery\s+time\s*:\s*(.+)/i);

  if(pickup){
    estimate = pickup[1].trim();
    orderType = "Square Pickup";
  }

  if(delivery){
    estimate = delivery[1].trim();
    orderType = "Square Delivery";
  }

  // --------------------
  // NOTE
  // --------------------
  let note = "";

  const noteMatch = body.match(/Note\s*:\s*(.+)/i);
  if(noteMatch){
    note = noteMatch[1].trim();
  }

  // --------------------
  // ITEMS
  // --------------------
  const items = [];

  const lines = body.split("\n");

  let currentItem = null;

  for(let i=0;i<lines.length;i++){

    let line = lines[i].trim();

    if(!line) continue;

    // ITEM BLOCK:
    // 1
    // x
    // Dozen Box
    if(/^\d+$/.test(line) && lines[i+1]?.trim().toLowerCase() === "x"){

      let qty = line;
      let name = (lines[i+2] || "").trim();

      if(name){

        currentItem = {
          item:`${qty}x ${name}`,
          modifiers:[]
        };

        items.push(currentItem);
      }

      continue;
    }

    // MODIFIER
    if(line.startsWith("▪") && currentItem){

      let mod = line.replace(/^▪️?/,'').trim();
      if(mod) currentItem.modifiers.push(mod);
    }
  }

  return {
    customer,
    orderType,
    phone,
    totalItems:items.length.toString(),
    estimate,
    note,
    items
  };
}

function parseGrubHub(html) {
  const $ = cheerio.load(html);

  // ---------- Hidden POS block (best for phone + service type) ----------
  const hidden = $('[data-section="grubhub-order-data"]');

  let phone =
    hidden.find('[data-field="phone"]').text().trim() ||
    $('a[href^="tel:"]').first().text().trim();

  let service = hidden.find('[data-field="service-type"]').text().trim(); // "Delivery" / "Pickup"
  let orderType =
    service.toLowerCase().includes("delivery") ? "GrubHub Delivery" :
    service.toLowerCase().includes("pickup")   ? "GrubHub Pickup" :
    // fallback if hidden missing:
    $('div:contains("Deliver to:")').length ? "GrubHub Delivery" :
    $('div:contains("Pickup by:")').length  ? "GrubHub Pickup"  :
    "GrubHub Pickup";

  // ---------- Customer name from the visible “Deliver to:” line ----------
  let customer = "UNKNOWN";
  const deliverLabel = $('div').filter((i, el) => $(el).text().trim() === "Deliver to:").first();
  if (deliverLabel.length) {
    customer = deliverLabel.next('div').text().trim() || customer;
  } else {
    const pickupLabel = $('div').filter((i, el) => $(el).text().trim() === "Pickup by:").first();
    if (pickupLabel.length) customer = pickupLabel.next('div').text().trim() || customer;
  }

  // ---------- Total items from “1   item” ----------
  let totalItems = "0";
  const totalP = $('p').filter((i, el) => /\b\d+\s*item\b/i.test($(el).text().replace(/\s+/g, " ").trim())).first();
  if (totalP.length) {
    const m = totalP.text().replace(/\s+/g, " ").match(/(\d+)\s*item/i);
    if (m) totalItems = m[1];
  }

  // ---------- Items + modifiers from visible receipt table ----------
  const items = [];

  // Find item rows that look like: [qty td] [x td] [name td with bold div]
  $('tr').each((i, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;

    const qtyTxt = $(tds[0]).text().replace(/\s+/g, " ").trim();
    const xTxt   = $(tds[1]).text().replace(/\s+/g, " ").trim();
    const name   = $(tds[2]).text().replace(/\s+/g, " ").trim();

    if (!/^\d+$/.test(qtyTxt)) return;
    if (xTxt.toLowerCase() !== "x") return;
    if (!name) return;

    const currentItem = { item: `${qtyTxt}x ${name}`, modifiers: [] };

    // modifiers are in the NEXT row, inside <li> like: "▪️12 Glazed Iced"
    const next = $(tr).next('tr');
    next.find('li').each((j, li) => {
      let mod = $(li).text().replace(/\s+/g, " ").trim();
      mod = mod.replace(/^▪️/,'').replace(/^▪/,'').trim(); // remove bullet only
      if (mod) currentItem.modifiers.push(mod); // keep FULL string like "12 Glazed Iced"
    });

    // group modifiers by counting duplicates
    const counter = {};
    for (const m of currentItem.modifiers) counter[m] = (counter[m] || 0) + 1;
    currentItem.modifiers = Object.entries(counter)
      .map(([n, q]) => (q === 1 ? n : `${q}x ${n}`));

    items.push(currentItem);
  });

  return { customer, orderType, phone, totalItems, items };
}
// --------------------
// BUILD STARPRNT JOB (Buffer)
// Uses "highlight" (inverted) for:
// - customer
// - orderType
// - EVERY modifier
// --------------------
function buildReceipt(customer, orderType, phone, totalItems, items, estimate="", note="") {

  const buffers = [];

  // --------------------
  // INIT
  // --------------------
  buffers.push(Buffer.from([0x1B,0x40])); // ESC @

  // --------------------
  // BOLD CUSTOMER NAME
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01])); // bold on
  buffers.push(Buffer.from(" " + customer + "\n")); 
  buffers.push(Buffer.from([0x1B,0x45,0x00])); // bold off

  // --------------------
  // ORDER TYPE (BOLD ONLY)
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01]));
  buffers.push(Buffer.from(" " + orderType + "\n"));
  buffers.push(Buffer.from([0x1B,0x45,0x00]));

  // --------------------
  // Phone
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01])); // bold on
  buffers.push(Buffer.from(" " + phone + "\n")); 
  buffers.push(Buffer.from([0x1B,0x45,0x00])); // bold off

  // --------------------
  // Total Items (BOLD ONLY)
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01]));
  buffers.push(Buffer.from(" " + "Total Items:" + " " + totalItems + "\n"));
  buffers.push(Buffer.from([0x1B,0x45,0x00]));
  
  // --------------------
// ESTIMATED TIME
// --------------------
if(estimate){
  buffers.push(Buffer.from([0x1B,0x45,0x01]));
  buffers.push(Buffer.from(" " + estimate + "\n"));
  buffers.push(Buffer.from([0x1B,0x45,0x00]));
}

// --------------------
// NOTE (ONLY IF EXISTS)
// --------------------
if(note){
  buffers.push(Buffer.from([0x1B,0x45,0x01]));
  buffers.push(Buffer.from(" NOTE: " + note + "\n"));
  buffers.push(Buffer.from([0x1B,0x45,0x00]));
}
  
  // --------------------
  // ITEMS + MODIFIERS
  // --------------------
  for (const order of items) {

    // ITEM (UNDERLINE ONLY)
    buffers.push(Buffer.from("\n"));
    buffers.push(Buffer.from([0x1B,0x45,0x01]));
    buffers.push(Buffer.from(" "));
    buffers.push(Buffer.from([0x1B,0x2D,0x01])); // underline on
    buffers.push(Buffer.from(order.item + "\n"));
    buffers.push(Buffer.from([0x1B,0x2D,0x00])); // underline off
    buffers.push(Buffer.from([0x1B,0x21,0x00]));
    // MODIFIERS (NORMAL)
    for (let mod of order.modifiers) {
      buffers.push(Buffer.from("    " + mod + "\n"));
    }
  }

  // --------------------
  // FEED + CUT
  // --------------------
  buffers.push(Buffer.from("\n"));
  buffers.push(Buffer.from([0x1B,0x64,0x03])); // feed 3
  buffers.push(Buffer.from([0x1D,0x56,0x00])); // cut

  return Buffer.concat(buffers);
}

// --------------------
// CHECK EMAIL
// --------------------
async function checkEmail() {
  try {

    // -------------------------
    // CHECK LABELS
    // -------------------------

    const gh = await gmail.users.messages.list({
  userId:"me",
  q:"is:unread label:GH_PRINT",
  maxResults:1
});

const sq = await gmail.users.messages.list({
  userId:"me",
  q:"is:unread label:SQ_PRINT",
  maxResults:1
});

    let messageId = null;
let platform = null;

if(gh.data.messages){
  messageId = gh.data.messages[0].id;
  platform = "GH";
}
else if(sq.data.messages){
  messageId = sq.data.messages[0].id;
  platform = "SQ";
}

    if (!messageId) return;

    console.log("EMAIL FOUND:", platform);

    const msg = await gmail.users.messages.get({
      userId:"me",
      id:messageId,
      format:"full"
    });

    let body = getBody(msg.data.payload);

    let customer="UNKNOWN";
let orderType="UNKNOWN";
let phone="";
let totalItems="";
let items=[];
let estimate="";
let note="";

    if (platform === "GH") {
      body = body
        .replace(/\u00A0/g," ")
        .replace(/\t/g," ")
        .replace(/\r/g,"")
        .replace(/[ ]+/g," ");

      const ghParsed = parseGrubHub(body);
customer = ghParsed.customer;
orderType = ghParsed.orderType;
phone = ghParsed.phone;
totalItems = ghParsed.totalItems;
items = ghParsed.items;

    const id = Date.now().toString();

activeJobs.set(id, buildReceipt(customer, orderType, phone, totalItems, items, estimate, note));
pending.push(id);


console.log("QUEUE ADDED:", id);

    await gmail.users.messages.modify({
      userId:"me",
      id:messageId,
      requestBody:{ removeLabelIds:["UNREAD"] }
    });

    console.log("PRINT JOB ADDED");}

  } catch (e) {
    console.log("CHECK EMAIL ERROR:", e.message);
  }
}
    

// --------------------
// TEST ROUTE
// --------------------
app.get("/createjob", (req, res) => {
  // Fixed syntax: Buffer.from([...]) then push, then close properly
  jobs.push(
    Buffer.from([
      0x1b, 0x40,
      0x1b, 0x61, 0x01,
      0x1b, 0x21, 0x30,
      0x48, 0x6f, 0x77, 0x61, 0x72,
      0x64, 0x27, 0x73, 0x20, 0x44,
      0x6f, 0x6e, 0x75, 0x74, 0x73,
      0x0a, 0x0a,
      0x1b, 0x64, 0x03,
      0x1d, 0x56, 0x00,
    ])
  );

  console.log("JOB CREATED");
  res.send("Job created");
});

// --------------------
// ADVANCED CLOUDPRNT
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

  res.json({ jobReady:false });
});

app.get("/starcloudprnt", (req, res) => {

  const token =
    req.query.token ||
    req.query.jobToken ||
    req.query.jobid;

  console.log("PRINTER REQUESTED:", token);
  console.log("PENDING:", pending);

  if (!token || !activeJobs.has(token)) {
    return res.status(204).send();
  }

  const job = activeJobs.get(token);

  // ⭐ SEND FIRST
  res.setHeader("Content-Type","application/vnd.star.starprnt");
  res.setHeader("Content-Length", job.length);
  res.setHeader("Cache-Control","no-store");

  res.send(job);

  // ⭐ DELETE AFTER SEND
  activeJobs.delete(token);
  pending = pending.filter(t => t !== token);

  console.log("PRINTED:", token);
});

// --------------------
// LOOP
// --------------------
setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});