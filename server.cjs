const cheerio = require("cheerio");
const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.raw({ type: "*/*" }));

// --------------------
// PRINT JOB QUEUE
// --------------------
let jobs = new Map();
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

function parseItems(body) {
  const lines = body.split("\n");

  const output = [];
  let currentItem = null;

  for (let raw of lines) {
    let line = (raw || "").trim();
    if (!line) continue;

    // ITEM like "2x Chocolate Donut"  (no space between qty and x)
    if (/^\d+x\s+/.test(line)) {
      currentItem = { item: line, modifiers: [] };
      output.push(currentItem);
      continue;
    }

    // MODIFIER like "+ Extra Glaze" or "+ 2x Sprinkles"
    if (line.startsWith("+") && currentItem) {
      let mod = line.replace(/^\+\s*/, "").trim();


      currentItem.modifiers.push(mod);
    }
  }

  return output;
}

function parseGrubHub(html) {
  const $ = cheerio.load(html);

  // ---------- Hidden POS block (best for phone + service type) ----------
  const hidden = $('[data-section="grubhub-order-data"]');

  let orderId = "UNKNOWN";

  const orderMatch = html.match(/Order\s*#\s*([\d\-]+)/i);

if(orderMatch){
  orderId = orderMatch[1].replace(/\s/g,'');
}

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

  return { customer, orderType, phone, totalItems, orderId, items };
}
// --------------------
// BUILD STARPRNT JOB (Buffer)
// Uses "highlight" (inverted) for:
// - customer
// - orderType
// - EVERY modifier
// --------------------
function buildReceipt(customer, orderType, phone, totalItems, items, orderId) {

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
  // BOLD Phone
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01])); // bold on
  buffers.push(Buffer.from(" " + phone + "\n")); 
  buffers.push(Buffer.from([0x1B,0x45,0x00])); // bold off

// --------------------
  // BOLD Order Id
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01])); // bold on
  buffers.push(Buffer.from(" " + orderId + "\n")); 
  buffers.push(Buffer.from([0x1B,0x45,0x00])); // bold off

  // --------------------
  // Total Items (BOLD ONLY)
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01]));
  buffers.push(Buffer.from("Total Items: " + totalItems + "\n"));
  buffers.push(Buffer.from([0x1B,0x45,0x00]));
  
  
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

    let messageId = null;
    let platform = null;

    if (gh.data.messages) {
      messageId = gh.data.messages[0].id;
      platform = "GH";
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
    let orderId="";

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
      orderId = ghParsed.orderId;
    }

    const receipt = buildReceipt(customer, orderType, phone, totalItems, items, orderId);

jobs.set(orderId, receipt);
pending.push(orderId);

    await gmail.users.messages.modify({
      userId:"me",
      id:messageId,
      requestBody:{ removeLabelIds:["UNREAD"] }
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
// STAR CLOUDPRNT ENDPOINTS
// --------------------
app.post("/starcloudprnt", (req, res) => {

  const token = pending.length ? pending[0] : null;

  res.json({
    jobReady: token !== null,
    mediaTypes: ["application/vnd.star.starprnt"],
    jobToken: token
  });

});

app.get("/starcloudprnt", (req, res) => {

  const token = req.query.jobToken;

  if(token && jobs.has(token)){

    const job = jobs.get(token);

    jobs.delete(token);
    pending.shift();

    res.setHeader("Content-Type","application/vnd.star.starprnt");
    return res.send(job);
  }

  res.status(204).send();
});

// --------------------
// LOOP
// --------------------
setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
