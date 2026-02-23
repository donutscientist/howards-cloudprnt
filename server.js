const express = require('express');
const app = express();

app.use(express.raw({ type: '*/*' }));

app.get('/', (req, res) => {
  res.send('OK');
});

let jobPending = true;

app.post('/starcloudprnt', (req, res) => {

  console.log("PRINTER POLLED");

  res.writeHead(200, {
    "Content-Type": "application/json"
  });

  res.end('{"jobReady":true}');
});
app.get('/starcloudprnt', (req, res) => {

  console.log("PRINTER REQUESTED JOB");

  const receipt = Buffer.from([
    0x1B, 0x40,              // Initialize printer
    0x1B, 0x61, 0x01,        // Center
    ...Buffer.from("HOWARD'S DONUTS\n\n"),
    0x1B, 0x61, 0x00,        // Left align
    ...Buffer.from("TEST PRINT SUCCESS\n\n"),
    0x1D, 0x56, 0x41, 0x10   // Cut paper
  ]);

  res.setHeader("Content-Type", "application/octet-stream");
  res.status(200).send(receipt);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
