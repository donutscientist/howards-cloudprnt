const express = require('express');
const app = express();

app.use(express.raw({ type: '*/*' }));

app.get('/', (req, res) => {
  res.send('OK');
});

let jobPending = true;

app.post('/starcloudprnt', (req, res) => {

  console.log("PRINTER POLLED");

  res.setHeader("Content-Type", "application/json");

  res.send({
    "jobReady": true,
    "mediaTypes": ["application/vnd.star.starprnt"],
    "jobToken": "12345"
  });

});

app.get('/starcloudprnt', (req, res) => {

  console.log("PRINTER REQUESTED JOB");

  const job = Buffer.from([
    0x1b, 0x40,                   // Initialize
    0x1b, 0x61, 0x01,             // Center align
    0x1b, 0x21, 0x30,             // Double size
    0x48, 0x6f, 0x77, 0x61, 0x72,
    0x64, 0x27, 0x73, 0x20, 0x44,
    0x6f, 0x6e, 0x75, 0x74, 0x73,
    0x0a,
    0x0a,
    0x1b, 0x64, 0x03,             // Feed 3
    0x1d, 0x56, 0x00              // Cut
  ]);

  res.setHeader("Content-Type", "application/vnd.star.starprnt");
  res.send(job);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
