const express = require('express');
const app = express();

app.use(express.raw({ type: '*/*' }));

let job = null;

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


// Printer polls this
app.post('/starcloudprnt', (req, res) => {

  console.log("PRINTER POLLED");

  res.setHeader("Content-Type", "application/json");

  res.send({
    jobReady: job !== null,
    mediaTypes: ["application/vnd.star.starprnt"],
    jobToken: "12345"
  });
});


// Printer downloads job here
app.get('/starcloudprnt', (req, res) => {

  if(job){

    console.log("PRINTER REQUESTED JOB");

    res.setHeader("Content-Type", "application/vnd.star.starprnt");
    res.send(job);

    job = null;   // 🔥🔥🔥 THIS STOPS INFINITE PRINTING

  } else {

    res.status(204).send();

  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
