const express = require('express');
const app = express();

app.use(express.raw({ type: '*/*' }));

app.get('/', (req, res) => {
  res.send('OK');
});

let jobPending = true;

app.post('/starcloudprnt', (req, res) => {
  console.log("PRINTER POLLED");

  res.set("Content-Type", "application/json");
  res.status(200).send({
    jobReady: jobPending
  });
});

app.get('/starcloudprnt', (req, res) => {

  if(!jobPending){
    return res.status(204).end();
  }

  console.log("PRINTER REQUESTED JOB");

  const receipt = Buffer.from([
    0x1b,0x40,
    0x48,0x4f,0x57,0x41,0x52,0x44,0x27,0x53,0x20,0x44,0x4f,0x4e,0x55,0x54,0x53,0x0a,
    0x43,0x4c,0x4f,0x55,0x44,0x50,0x52,0x4e,0x54,0x20,0x57,0x4f,0x52,0x4b,0x53,0x21,0x0a,
    0x0a,
    0x1b,0x64,0x02,
    0x1b,0x69
  ]);

  jobPending = false;

  res.set({
    "Content-Type": "application/vnd.star.starprnt",
    "Content-Length": receipt.length,
    "X-Star-CloudPRNT-Job": "true",
    "X-Star-CloudPRNT-StatusCode": "200"
  });

  res.status(200).send(receipt);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
