let jobs = [];

const { google } = require('googleapis');

const auth = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET
);

auth.setCredentials({
  refresh_token: process.env.REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth });

const express = require('express');
const app = express();

function getBody(payload){

  if(payload.parts){
    for(let part of payload.parts){

      if(part.mimeType === "text/plain"){
        return Buffer.from(part.body.data,'base64').toString();
      }

      if(part.mimeType === "text/html"){
        return Buffer.from(part.body.data,'base64')
        .toString()
        .replace(/<[^>]+>/g,"");
      }

    }
  }

  return Buffer.from(payload.body.data,'base64').toString();

}

function parseItems(body){

  const lines = body.split("\n");

  let output = [];
  let currentItem = null;

  for(let line of lines){

    line = line.trim();

    // ITEM like "2x Chocolate Donut"
    if(line.match(/^\d+x\s/)){

      currentItem = {
        item: line,
        modifiers:[]
      };

      output.push(currentItem);
    }

    // MODIFIER like "+ Extra Glaze"
    else if(line.startsWith("+") && currentItem){

      let mod = line.replace("+","").trim();

      if(!mod.match(/^\d+x\s/)){
        mod = "1x " + mod;
      }

      currentItem.modifiers.push(mod);
    }
  }

  return output;
}
function buildReceipt(customer, orderType, items){

  let buffers = [];

  buffers.push(Buffer.from([0x1b,0x40])); // init

  buffers.push(Buffer.from("\nNEW ORDER\n\n"));

  // CUSTOMER HIGHLIGHT
  buffers.push(Buffer.from([0x1d,0x42,0x01]));
  buffers.push(Buffer.from(customer + "\n"));
  buffers.push(Buffer.from([0x1d,0x42,0x00]));

  // ORDER TYPE HIGHLIGHT
  buffers.push(Buffer.from([0x1d,0x42,0x01]));
  buffers.push(Buffer.from(orderType + "\n\n"));
  buffers.push(Buffer.from([0x1d,0x42,0x00]));

  for(let order of items){

    // ITEM NORMAL
    buffers.push(Buffer.from(order.item + "\n"));

    for(let mod of order.modifiers){

      // MODIFIER HIGHLIGHT + INDENT
      buffers.push(Buffer.from([0x1d,0x42,0x01]));
      buffers.push(Buffer.from("   " + mod + "\n"));
      buffers.push(Buffer.from([0x1d,0x42,0x00]));
    }

  }

  buffers.push(Buffer.from("\n\n"));
  buffers.push(Buffer.from([0x1b,0x64,0x03]));
  buffers.push(Buffer.from([0x1d,0x56,0x00]));

  return Buffer.concat(buffers);
}
async function checkEmail() {

  try {

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread label:AUTO_PRINT',
      maxResults: 1
    });
    

if (res.data.messages) {

  console.log("EMAIL FOUND - CREATING JOB");

  const messageId = res.data.messages[0].id;   // 🔥🔥🔥 THIS IS THE FIX

  const msg = await gmail.users.messages.get({
  userId:'me',
  id:messageId
});

const body = getBody(msg.data.payload);

const items = parseItems(body);

// CUSTOMER NAME
let customer = "UNKNOWN";
let orderType = "UNKNOWN";

const nameMatch = body.match(/Customer:\s(.+)/i);
if(nameMatch) customer = nameMatch[1];

// ORDER TYPE
if(body.includes("Pickup")) orderType = "PICKUP";
if(body.includes("Delivery")) orderType = "DELIVERY";


jobs.push(
  buildReceipt(customer, orderType, items)
);

  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: {
      removeLabelIds: ['UNREAD']
    }
  });


    }

  } catch(e) {
    console.log("GMAIL ERROR:", e.message);
  }

}

// TEST route to manually create job
app.get('/createjob', (req, res) => {

  jobs.push(Buffer.from([
    0x1b, 0x40,
    0x1b, 0x61, 0x01,
    0x1b, 0x21, 0x30,
    0x48, 0x6f, 0x77, 0x61, 0x72,
    0x64, 0x27, 0x73, 0x20, 0x44,
    0x6f, 0x6e, 0x75, 0x74, 0x73,
    0x0a,
    0x0a,
    0x1b, 0x64, 0x03,
    0x1d, 0x56, 0x00
  ]);

  console.log("JOB CREATED");
  res.send("Job created");
});

app.post('/starcloudprnt',(req,res)=>{

  console.log("PRINTER POLLED");

  res.setHeader("Content-Type","application/json");

  res.send({
    jobReady: jobs.length > 0,
    mediaTypes:["application/vnd.star.starprnt"],
    jobToken:"12345"
  });

});


// Printer downloads job here
app.get('/starcloudprnt',(req,res)=>{

if(jobs.length > 0){

  const nextJob = jobs.shift();

  res.setHeader("Content-Type","application/vnd.star.starprnt");
  res.send(nextJob);

}else{

  res.status(204).send();

}

});

setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
