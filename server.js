let job = null;
let jobSent = false;

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


async function checkEmail() {

  try {

    const res = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 1
    });
    

if (res.data.messages && !job) {

  console.log("EMAIL FOUND - CREATING JOB");

  const messageId = res.data.messages[0].id;   // 🔥🔥🔥 THIS IS THE FIX

  job = Buffer.from([
    0x1b, 0x40,
    0x1b, 0x61, 0x01,
    0x1b, 0x21, 0x30,
    0x4e,0x45,0x57,0x20,0x4f,0x52,0x44,0x45,0x52,
    0x0a,
    0x1b, 0x64, 0x03,
    0x1d, 0x56, 0x00
  ]);

  jobsent = false;

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

  job = Buffer.from([
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
    jobReady: job !== null && !jobSent,
    mediaTypes:["application/vnd.star.starprnt"],
    jobToken:"12345"
  });

});


// Printer downloads job here
app.get('/starcloudprnt',(req,res)=>{

  if(job && !jobSent){

    console.log("PRINTER REQUESTED JOB");

    jobSent = true;

    res.setHeader("Content-Type","application/vnd.star.starprnt");
    res.send(job);

  }else{

    res.status(204).send();

  }

});

setInterval(checkEmail, 5000);

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
