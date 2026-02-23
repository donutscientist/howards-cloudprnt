const express = require('express');
const app = express();

app.use(express.raw({ type: '*/*' }));

app.get('/', (req, res) => {
  res.send('OK');
});

app.post('/starcloudprnt', (req, res) => {
  console.log("🖨️ PRINTER POLLED");

  const receipt = `
^XA
^FO50,50^ADN,36,20^FDHOWARD'S DONUTS TEST^FS
^XZ
`;

  res.set({
    "Content-Type": "text/plain",
    "X-Star-CloudPRNT-Job": "true",
    "X-Star-CloudPRNT-StatusCode": "200"
  });

  res.send(receipt);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
