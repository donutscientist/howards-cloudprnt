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
      return decodeBase64Url(part.body.data);
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

// --------------------
// PARSE GRUBHUB EMAIL
// --------------------
function parseGrubHub(html){

  const $ = cheerio.load(html);

  const cleanHtml = html
    .replace(/&nbsp;/gi,' ')
    .replace(/\u00A0/g,' ')
    .replace(/\s+/g,' ');

  let orderId = "UNKNOWN";

  // better regex (GH changed format)
  const match = cleanHtml.match(/Order\s*(ID|#)?\s*[:\-]?\s*(\d{6,}(-\d{2,})?)/i);
  if(match) orderId = match[2];

  let phone =
    $('a[href^="tel:"]').first().text().trim() || "";

  let customer = "UNKNOWN";

  const deliverLabel = $('div')
    .filter((i, el) => $(el).text().trim() === "Deliver to:")
    .first();

  if (deliverLabel.length) {
    customer = deliverLabel.next('div').text().trim() || customer;
  }

  let totalItems = "0";
  const totalP = $('p')
    .filter((i, el) =>
      /\b\d+\s*item\b/i.test($(el).text().replace(/\s+/g," ").trim())
    ).first();

  if (totalP.length) {
    const m = totalP.text().match(/(\d+)/);
    if (m) totalItems = m[1];
  }

  let orderType =
    $('div:contains("Deliver to:")').length ? "GrubHub Delivery" :
    $('div:contains("Pickup by:")').length  ? "GrubHub Pickup"  :
    "GrubHub Pickup";

  const items = [];

  $('tr').each((i, tr) => {
    const tds = $(tr).find('td');
    if (tds.length < 3) return;

    const qty = $(tds[0]).text().trim();
    const x   = $(tds[1]).text().trim();
    const name= $(tds[2]).text().trim();

    if (!/^\d+$/.test(qty)) return;
    if (x.toLowerCase() !== "x") return;
    if (!name) return;

    items.push({
      item: `${qty}x ${name}`,
      modifiers:[]
    });
  });

  console.log("PARSED ORDER ID:",orderId);

  return { customer, orderType, phone, totalItems, items, orderId };
}

// --------------------
// BUILD RECEIPT
// --------------------
function buildReceipt(customer, orderType, phone, totalItems, items, orderId){

  const buffers=[];

  buffers.push(Buffer.from([0x1B,0x40]));
  buffers.push(Buffer.from([0x1B,0x45,0x01]));
  buffers.push(Buffer.from(customer+"\n"));
  buffers.push(Buffer.from(orderType+"\n"));
  buffers.push(Buffer.from(phone+"\n"));
  buffers.push(Buffer.from(orderId+"\n"));
  buffers.push(Buffer.from("Items: "+totalItems+"\n"));
  buffers.push(Buffer.from([0x1B,0x45,0x00]));

  for(const order of items){
    buffers.push(Buffer.from(order.item+"\n"));
  }

  buffers.push(Buffer.from("\n"));
  buffers.push(Buffer.from([0x1B,0x64,0x03]));
  buffers.push(Buffer.from([0x1D,0x56,0x00]));

  return Buffer.concat(buffers);
}

// --------------------
// CHECK EMAIL LOOP
// --------------------
async function checkEmail(){

  try{

    const gh = await gmail.users.messages.list({
      userId:"me",
      q:"is:unread label:GH_PRINT",
      maxResults:1
    });

    if(!gh.data.messages) return;

    const messageId = gh.data.messages[0].id;

    const msg = await gmail.users.messages.get({
      userId:"me",
      id:messageId,
      format:"full"
    });

    const html = getBody(msg.data.payload);
    const parsed = parseGrubHub(html);

    const queueId =
      "JOB-"+Date.now()+"-"+Math.random().toString(36).slice(2,7);

    const receipt = buildReceipt(
      parsed.customer,
      parsed.orderType,
      parsed.phone,
      parsed.totalItems,
      parsed.items,
      parsed.orderId
    );

    jobs.set(queueId,receipt);
    pending.push(queueId);

    console.log("QUEUE ADDED:",queueId);

    await gmail.users.messages.modify({
      userId:"me",
      id:messageId,
      requestBody:{ removeLabelIds:["UNREAD"] }
    });

  }catch(e){
    console.log("EMAIL ERROR:",e.message);
  }
}

// --------------------
// CLOUDPRNT HANDSHAKE
// --------------------
app.post("/starcloudprnt",(req,res)=>{

  if(!pending.length){
    return res.json({jobReady:false});
  }

  const token=pending[0];

  return res.json({
    jobReady:true,
    jobToken:token,
    mediaTypes:["application/vnd.star.starprnt"]
  });

});

// --------------------
// CLOUDPRNT GET JOB
// --------------------
app.get("/starcloudprnt",(req,res)=>{

  const token=req.query.jobToken;

  if(token && jobs.has(token)){

    const job=jobs.get(token);

    jobs.delete(token);
    pending=pending.filter(t=>t!==token);

    res.setHeader(
      "Content-Type",
      "application/vnd.star.starprnt"
    );
    return res.send(job);
  }

  res.status(204).send();
});

// --------------------
// TEST JOB
// --------------------
app.get("/createjob",(req,res)=>{

  const id="TEST-"+Date.now();

  const test=Buffer.from([
    0x1b,0x40,
    0x54,0x45,0x53,0x54,
    0x0a,
    0x1b,0x64,0x03,
    0x1d,0x56,0x00
  ]);

  jobs.set(id,test);
  pending.push(id);

  res.send("TEST CREATED");
});

// --------------------
// LOOP
// --------------------
setInterval(checkEmail,5000);

app.listen(process.env.PORT||3000,()=>{
  console.log("Server running");
});