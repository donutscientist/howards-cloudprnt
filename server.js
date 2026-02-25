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

// --------------------
// PARSE ITEMS + MODIFIERS
// - Item line: "2x Chocolate Donut"
// - Modifier line: "+ Extra Glaze" or "+ 2x Sprinkles"
// Output: [{ item: "2x ...", modifiers: ["1x ...", "2x ..."] }]
// --------------------
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

// --------------------
// BUILD STARPRNT JOB (Buffer)
// Uses "highlight" (inverted) for:
// - customer
// - orderType
// - EVERY modifier
// --------------------
function buildReceipt(customer, orderType, items) {

  const buffers = [];

  // INIT PRINTER
  buffers.push(Buffer.from([0x1B,0x40]));
  // 1 SPACE INDENT (NOT INVERTED)
  buffers.push(Buffer.from(" ","ascii"));
  // --------------------
  // CUSTOMER (BOLD)
  // --------------------
  buffers.push(Buffer.from([0x1B,0x45,0x01])); // BOLD
  buffers.push(Buffer.from(customer,"ascii"));
  buffers.push(Buffer.from([0x1B,0x45,0x00])); // BOLD OFF
  buffers.push(Buffer.from("\n","ascii"));
  // 1 SPACE INDENT (NOT INVERTED)
  buffers.push(Buffer.from(" ","ascii"));
  // --------------------
  // ORDER TYPE (BOLD)
  // --------------------
  buffers.push(Buffer.from(orderType,"ascii"));
  buffers.push(Buffer.from("\n\n","ascii"));

  // --------------------
  // ITEMS + MODIFIERS
  // --------------------
for (const order of items) {

  // --------------------
  // ITEM (UNDERLINE ONLY)
  // --------------------
  // 1 SPACE INDENT (NOT INVERTED)
  
  buffers.push(Buffer.from(" ","ascii"));
  buffers.push(Buffer.from([0x1B,0x21,0x10])); // double height
  buffers.push(Buffer.from([0x1B,0x45,0x01])); // BOLD
  buffers.push(Buffer.from([0x1B,0x2D,0x01]));  // UNDERLINE ON
  buffers.push(Buffer.from(order.item, "\n","ascii"));
  buffers.push(Buffer.from([0x1B,0x2D,0x00]));  // UNDERLINE OFF
  buffers.push(Buffer.from([0x1B,0x45,0x00])); // BOLD OFF
  buffers.push(Buffer.from([0x1B,0x21,0x00])); // double height
  buffers.push(Buffer.from("\n","ascii"));

  for (let mod of order.modifiers) {

  // 1 SPACE LEFT INDENT (NORMAL TEXT)
  buffers.push(Buffer.from("    " + mod + "\n","ascii"));
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

    if (!res.data.messages || res.data.messages.length === 0) return;

    const messageId = res.data.messages[0].id;
    console.log("EMAIL FOUND - CREATING JOB:", messageId);

    // Fetch message
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const body = getBody(msg.data.payload);
    const items = parseItems(body);

    // basic extraction placeholders (you’ll refine later)
    let customer = "UNKNOWN";
    let orderType = "UNKNOWN";

    const nameMatch = body.match(/Customer:\s*(.+)/i);
    if (nameMatch) customer = nameMatch[1].trim();

    if (/pickup/i.test(body)) orderType = "PICKUP";
    if (/delivery/i.test(body)) orderType = "DELIVERY";

    // Push print job into queue
    jobs.push(buildReceipt(customer, orderType, items));

    // Mark email read so it won't re-trigger
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });

    // Optional (recommended): also remove AUTO_PRINT to avoid accidental reprocessing later
    // await gmail.users.messages.modify({
    //   userId: "me",
    //   id: messageId,
    //   requestBody: { removeLabelIds: ["AUTO_PRINT", "UNREAD"] },
    // });

  } catch (e) {
    console.log("GMAIL ERROR:", e.message);
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
