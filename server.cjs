const cheerio = require("cheerio");
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

function parseGrubHub(html){

  const $ = cheerio.load(html);

  let customer = "UNKNOWN";
  let orderType = "GrubHub Pickup";
  let totalItems = "0";
  let items = [];

  // ------------------
  // CUSTOMER NAME
  // ------------------

  let deliver = $('*')
    .filter((i,el)=>$(el).text().includes("Deliver to:"))
    .text();

  let pickup = $('*')
    .filter((i,el)=>$(el).text().includes("Pickup by:"))
    .text();

  if(deliver){
    customer = deliver.replace("Deliver to:","").trim();
    orderType="GrubHub Delivery";
  }

  if(pickup){
    customer = pickup.replace("Pickup by:","").trim();
    orderType="GrubHub Pickup";
  }

  // ------------------
  // TOTAL ITEMS
  // ------------------

  $('*').each((i,el)=>{

    let t = $(el).text();

    if(t.match(/(\d+)\s+items?/i))
      totalItems = t.match(/(\d+)/)[1];
  });

  // ------------------
  // ITEMS
  // ------------------

  $('[data-field="menu-item-name"]').each((i,el)=>{

    let name = $(el).text().trim();

    let qty = $(el)
      .closest('[data-section="menu-item"]')
      .find('[data-field="quantity"]')
      .text()
      .trim();

    let currentItem = {
      item: qty + "x " + name,
      modifiers:[]
    };

    // ------------------
    // MODIFIERS
    // ------------------

    $(el)
      .closest('[data-section="menu-item"]')
      .find('li')
      .each((j,li)=>{

        let mod = $(li).text().replace("▪","").trim();

        let m = mod.match(/^(\d+)\s+(.+)/);

        if(m){
          for(let k=0;k<parseInt(m[1]);k++)
            currentItem.modifiers.push(m[2]);
        }else{
          currentItem.modifiers.push(mod);
        }

      });

    items.push(currentItem);
  });

  // ------------------
  // GROUP MODIFIERS
  // ------------------

  for(let order of items){

    let counter={};

    for(let m of order.modifiers)
      counter[m]=(counter[m]||0)+1;

    order.modifiers = Object.entries(counter)
      .sort((a,b)=>a[1]-b[1])
      .map(([n,q])=> q===1 ? n : q+"x "+n);
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
    let items=[];

    if (platform === "GH") {
      body = body
        .replace(/\u00A0/g," ")
        .replace(/\t/g," ")
        .replace(/\r/g,"")
        .replace(/[ ]+/g," ");

      const ghParsed = parseGrubHub(body);
      customer = ghParsed.customer;
      orderType = ghParsed.orderType;
      items = ghParsed.items;

      if (ghParsed.totalItems) {
        items.unshift({
          item:`Total Items: ${ghParsed.totalItems}`,
          modifiers:[]
        });
      }
    }

    jobs.push(buildReceipt(customer, orderType, items));

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
