const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.raw({ type: "*/*" }));

// --------------------
// PRINT JOB QUEUE
// --------------------
let jobs = [];

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
function getBody(payload) {
  // Walk parts (plain/text preferred)
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf8");
      }
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64")
          .toString("utf8")
          .replace(/<[^>]+>/g, "");
      }

      // Sometimes payload is nested (parts inside parts)
      if (part.parts) {
        const nested = getBody(part);
        if (nested) return nested;
      }
    }
  }

  // Fallback to payload.body.data
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf8");
  }

  return "";
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

function parseGrubHub(body){

  let customer = "UNKNOWN";
  let orderType = "GrubHub Pickup";
  let totalItems = "0";

  // --------------------
  // NAME + TYPE
  // --------------------
  let deliverMatch = body.match(/Deliver to:\s*(.+)/i);
  let pickupMatch  = body.match(/Pickup by:\s*(.+)/i);

  if(deliverMatch){
    customer = deliverMatch[1].trim();
    orderType = "GrubHub Delivery";
  }
  else if(pickupMatch){
    customer = pickupMatch[1].trim();
    orderType = "GrubHub Pickup";
  }

  // --------------------
  // TOTAL ITEMS
  // --------------------
  let totalMatch = body.match(/(\d+)\s*items?/i);
  if(totalMatch)
    totalItems = totalMatch[1];

  // --------------------
  // ITEMS + MODIFIERS
  // --------------------
  let lines = body.split("\n");
  let items = [];
  let currentItem = null;

  for(let raw of lines){

    let line = raw.trim();

    // ITEM → 2 x Kolache
    let itemMatch = line.match(/^(\d+)\s*x\s*(.+)$/i);

    if(itemMatch){
      currentItem = {
        item: itemMatch[1] + "x " + itemMatch[2].trim(),
        modifiers:[]
      };
      items.push(currentItem);
      continue;
    }

    // MODIFIER → ▪️ Coconut
    if(line.includes("▪️") && currentItem){
      let mod = line.split("▪️")[1].trim();
      currentItem.modifiers.push(mod);
    }
  }

  // --------------------
  // GROUP + SORT MODS
  // --------------------
  for(let order of items){

    let counter = {};

    for(let m of order.modifiers)
      counter[m] = (counter[m]||0)+1;

    order.modifiers = Object.entries(counter)
      .sort((a,b)=>a[1]-b[1])
      .map(([name,qty])=>{
        if(qty===1) return name;
        return qty+"x "+name;
      });
  }

  return {
    customer,
    orderType,
    totalItems,
    items
  };
}
// --------------------
// BUILD STARPRNT JOB (Buffer)
// Uses "highlight" (inverted) for:
// - customer
// - orderType
// - EVERY modifier
// --------------------
function buildReceipt(customer, orderType, items) {

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
async function checkEmail(){

  try{

    // -------------------------
    // CHECK LABELS
    // -------------------------

    const gh = await gmail.users.messages.list({
      userId:"me",
      q:"is:unread label:GH_PRINT",
      maxResults:1
    });

    const dd = await gmail.users.messages.list({
      userId:"me",
      q:"is:unread label:DD_PRINT",
      maxResults:1
    });

    const ue = await gmail.users.messages.list({
      userId:"me",
      q:"is:unread label:UE_PRINT",
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
    else if(dd.data.messages){
      messageId = dd.data.messages[0].id;
      platform = "DD";
    }
    else if(ue.data.messages){
      messageId = ue.data.messages[0].id;
      platform = "UE";
    }
    else if(sq.data.messages){
      messageId = sq.data.messages[0].id;
      platform = "SQ";
    }

    if(!messageId) return;

    console.log("EMAIL FOUND:",platform);

    const msg = await gmail.users.messages.get({
      userId:"me",
      id:messageId,
      format:"full"
    });

    const body = getBody(msg.data.payload);
    let totalItems = "";

if(platform==="GH"){

  const totalMatch =
    body.match(/Total items:\s*(\d+)/i) ||
    body.match(/\b(\d+)\s+items\b/i);

  if(totalMatch)
    totalItems = totalMatch[1];

}

   let customer = "UNKNOWN";
let orderType = "UNKNOWN";
let items = [];

// -------------------------
// PLATFORM PARSER
// -------------------------

if(platform==="GH"){

  const gh = parseGrubHub(body);

  customer  = gh.customer;
  orderType = gh.orderType;

  items = gh.items;

  if(gh.totalItems){
    items.unshift({
      item:`Total items: ${gh.totalItems}`,
      modifiers:[]
    });
  }

}else{

  // future DD / UE / SQ
  items = parseItems(body);

  const nameMatch = body.match(/Customer:\s*(.+)/i);
  if(nameMatch) customer=nameMatch[1].trim();

  if(/pickup/i.test(body)) orderType="Pickup";
  if(/delivery/i.test(body)) orderType="Delivery";
}

jobs.push(buildReceipt(customer,orderType,items));

    await gmail.users.messages.modify({
      userId:"me",
      id:messageId,
      requestBody:{ removeLabelIds:["UNREAD"] }
    });

  }catch(e){
    console.log("GMAIL ERROR:",e.message);
  }

}

    // Optional (recommended): also remove AUTO_PRINT to avoid accidental reprocessing later
    // await gmail.users.messages.modify({
    //   userId: "me",
    //   id: messageId,
    //   requestBody: { removeLabelIds: ["AUTO_PRINT", "UNREAD"] },
    // });

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
  console.log("PRINTER POLLED");

  res.setHeader("Content-Type", "application/json");
  res.send({
    jobReady: jobs.length > 0,
    mediaTypes: ["application/vnd.star.starprnt"],
    jobToken: "12345",
  });
});

app.get("/starcloudprnt", (req, res) => {
  if (jobs.length > 0) {
    console.log("PRINTER REQUESTED JOB");

    const nextJob = jobs.shift();
    res.setHeader("Content-Type", "application/vnd.star.starprnt");
    res.send(nextJob);
  } else {
    res.status(204).send();
  }
});

// --------------------
// LOOP
// --------------------
setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
