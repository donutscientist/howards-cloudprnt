const cheerio = require("cheerio");
const express = require("express");
const { google } = require("googleapis");
const pdfParse = require("pdf-parse"); // NEW

const app = express();
app.use(express.raw({ type: "*/*" }));

let activeJobs = new Map();
let pending = [];

const auth = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);

auth.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth });

function decodeBase64Url(data) {
  return Buffer.from(
    data.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(data.length + (4 - (data.length % 4)) % 4, "="),
    "base64"
  ).toString("utf8");
}

function decodeQuotedPrintable(input) {
  if (!input) return "";
  let s = input.replace(/=\r?\n/g, "");
  s = s.replace(/=([A-Fa-f0-9]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  return s;
}

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

////////////////////////////////////////////////////
// DOORDASH PDF EXTRACTOR (NEW)
////////////////////////////////////////////////////
async function getDoorDashPDF(message) {

  function findPDF(part) {
    if (!part) return null;

    if (part.filename && part.filename.toLowerCase().endsWith(".pdf")) {
      return part.body.attachmentId;
    }

    if (part.parts) {
      for (const p of part.parts) {
        const r = findPDF(p);
        if (r) return r;
      }
    }

    return null;
  }

  const attachmentId = findPDF(message.payload);

  if (!attachmentId) return "";

  const attachment = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: message.id,
    id: attachmentId
  });

  const pdfBuffer = Buffer.from(attachment.data.data, "base64");

  const data = await pdfParse(pdfBuffer);

  return data.text;
}

////////////////////////////////////////////////////
// DOORDASH PARSER (NEW)
////////////////////////////////////////////////////
function parseDoorDash(text){

  const lines = text.split("\n").map(l=>l.trim()).filter(Boolean)

  let customer = "UNKNOWN"
  let phone = ""
  let orderType = "DoorDash"

  const items=[]
  let current=null

  for(const line of lines){

    if(/\(\d{3}\)\s*\d{3}-\d{4}/.test(line)){
      phone=line
    }

    if(line.startsWith("Customer")){
      customer=line.replace("Customer","").trim()
    }

    if(/^\d+\s*x/i.test(line)){

      const parts=line.split("x")

      const qty=parts[0].trim()
      const name=parts.slice(1).join("x").trim()

      current={item:`${qty}x ${name}`,modifiers:[]}

      items.push(current)

      continue
    }

    if(line.startsWith("+") && current){
      current.modifiers.push(line.replace("+","").trim())
    }
  }

  const totalItems=String(items.length)

  return {customer,orderType,phone,totalItems,items,estimate:"",note:""}
}

////////////////////////////////////////////////////
// EXISTING PARSERS (UNCHANGED)
////////////////////////////////////////////////////
/* KEEP ALL YOUR EXISTING parseGrubHub(), parseSquareHTML(), receipt builder etc */

////////////////////////////////////////////////////
// CHECK EMAIL
////////////////////////////////////////////////////
async function checkEmail() {
  try {

    const gh = await gmail.users.messages.list({
      userId:"me",
      q:"is:unread label:GH_PRINT",
      maxResults:1
    })

    const sq = await gmail.users.messages.list({
      userId:"me",
      q:"is:unread label:SQ_PRINT",
      maxResults:1
    })

    const dd = await gmail.users.messages.list({
      userId:"me",
      q:"is:unread label:DD_PRINT",
      maxResults:1
    })

    let messageId=null
    let platform=null

    if(gh.data.messages?.length){
      messageId=gh.data.messages[0].id
      platform="GH"
    }
    else if(sq.data.messages?.length){
      messageId=sq.data.messages[0].id
      platform="SQ"
    }
    else if(dd.data.messages?.length){
      messageId=dd.data.messages[0].id
      platform="DD"
    }
    else{
      return
    }

    console.log("EMAIL FOUND:",platform)

    const msg = await gmail.users.messages.get({
      userId:"me",
      id:messageId,
      format:"full"
    })

    let parsed=null

    if(platform==="GH"){
      const html=getHtmlBody(msg.data.payload)
      parsed=parseGrubHub(html)
    }

    if(platform==="SQ"){
      const html=getHtmlBody(msg.data.payload)
      parsed=parseSquareHTML(html)
    }

    ////////////////////////////////////////////////////
    // DOORDASH PDF PARSE
    ////////////////////////////////////////////////////
    if(platform==="DD"){

      const pdfText = await getDoorDashPDF(msg)

      parsed = parseDoorDash(pdfText)
    }

    if(!parsed) return

    const id=Math.random().toString(36).substring(2,10)

    const jobBuf = buildReceipt(
      parsed.customer,
      parsed.orderType,
      parsed.phone,
      parsed.totalItems,
      parsed.items,
      parsed.estimate,
      parsed.note
    )

    activeJobs.set(id,jobBuf)
    pending.push(id)

    console.log("QUEUE ADDED:",id)

    await gmail.users.messages.modify({
      userId:"me",
      id:messageId,
      requestBody:{removeLabelIds:["UNREAD"]}
    })

    console.log("PRINT JOB ADDED")

  } catch(e){
    console.log("CHECK EMAIL ERROR:",e.message)
  }
}