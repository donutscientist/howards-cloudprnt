const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.raw({ type: "*/*" }));

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
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data)
        return Buffer.from(part.body.data, "base64").toString("utf8");

      if (part.mimeType === "text/html" && part.body?.data)
        return Buffer.from(part.body.data, "base64")
          .toString("utf8")
          .replace(/<[^>]+>/g, "");

      if (part.parts) {
        const nested = getBody(part);
        if (nested) return nested;
      }
    }
  }
  if (payload.body?.data)
    return Buffer.from(payload.body.data, "base64").toString("utf8");

  return "";
}

// --------------------
// PARSE ITEMS
// --------------------
function parseItems(body) {
  const lines = body.split("\n");
  const output = [];
  let currentItem = null;

  for (let raw of lines) {
    let line = raw.trim();
    if (!line) continue;

    if (/^\d+x\s+/.test(line)) {
      currentItem = { item: line, modifiers: [] };
      output.push(currentItem);
      continue;
    }

    if (line.startsWith("+") && currentItem) {
      let mod = line.replace(/^\+\s*/, "").trim();

      // REMOVE 1x IF QTY IS 1
      if (/^1x\s+/i.test(mod))
        mod = mod.replace(/^1x\s+/i, "");

      currentItem.modifiers.push(mod);
    }
  }
  return output;
}

// --------------------
// BUILD RECEIPT
// --------------------
function buildReceipt(customer, orderType, items) {

  const buffers = [];

  // INIT PRINTER
  buffers.push(Buffer.from([0x1B,0x40]));

  // --------------------
  // CUSTOMER (INVERTED)
  // --------------------
  buffers.push(Buffer.from([0x1B,0x34]));        // INVERT ON
  buffers.push(Buffer.from(customer,"ascii"));   // TEXT
  buffers.push(Buffer.from([0x1B,0x35]));        // INVERT OFF
  buffers.push(Buffer.from("\n","ascii"));

  // --------------------
  // ORDER TYPE (INVERTED)
  // --------------------
  buffers.push(Buffer.from([0x1B,0x34]));
  buffers.push(Buffer.from(orderType,"ascii"));
  buffers.push(Buffer.from([0x1B,0x35]));
  buffers.push(Buffer.from("\n\n","ascii"));

  // --------------------
  // ITEMS + MODIFIERS
  // --------------------
  for (const order of items) {

    // ITEM NORMAL
    buffers.push(Buffer.from(order.item + "\n","ascii"));

    for (let mod of order.modifiers) {

      // REMOVE 1x IF QTY IS 1
      mod = mod.replace(/^1x\s+/i,"");

      // 1 SPACE INDENT (NOT INVERTED)
      buffers.push(Buffer.from(" ","ascii"));

      // MODIFIER INVERTED FROM TEXT ONLY
      buffers.push(Buffer.from([0x1B,0x34]));    // INVERT ON
      buffers.push(Buffer.from(mod,"ascii"));
      buffers.push(Buffer.from([0x1B,0x35]));    // INVERT OFF

      buffers.push(Buffer.from("\n","ascii"));
    }
  }

  // FEED + CUT
  buffers.push(Buffer.from("\n","ascii"));
  buffers.push(Buffer.from([0x1B,0x64,0x03]));
  buffers.push(Buffer.from([0x1D,0x56,0x00]));

  return Buffer.concat(buffers);
}

// --------------------
// CHECK EMAIL
// --------------------
async function checkEmail() {

  try {

    const res = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread label:AUTO_PRINT",
      maxResults: 1,
    });

    if (!res.data.messages) return;

    const messageId = res.data.messages[0].id;

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const body = getBody(msg.data.payload);
    const items = parseItems(body);

    let customer = "UNKNOWN";
    let orderType = "UNKNOWN";

    const nameMatch = body.match(/Customer:\s*(.+)/i);
    if (nameMatch) customer = nameMatch[1].trim();

    if (/pickup/i.test(body)) orderType = "PICKUP";
    if (/delivery/i.test(body)) orderType = "DELIVERY";

    jobs.push(buildReceipt(customer, orderType, items));

    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });

  } catch (e) {
    console.log("GMAIL ERROR:", e.message);
  }
}

// --------------------
// STAR CLOUDPRNT
// --------------------
app.post("/starcloudprnt",(req,res)=>{
  res.setHeader("Content-Type","application/json");
  res.send({
    jobReady: jobs.length > 0,
    mediaTypes:["application/vnd.star.starprnt"],
    jobToken:"12345"
  });
});

app.get("/starcloudprnt",(req,res)=>{
  if(jobs.length > 0){
    const nextJob = jobs.shift();
    res.setHeader("Content-Type","application/vnd.star.starprnt");
    res.send(nextJob);
  }else{
    res.status(204).send();
  }
});

setInterval(checkEmail,5000);

app.listen(process.env.PORT || 3000,()=>{
  console.log("Server running");
});
