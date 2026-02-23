const express = require('express');
const app = express();
app.use(express.text({ type: '*/*' }));

app.post('/starcloudprnt', (req, res) => {
  console.log("PRINTER POLLED");

  const receipt = `
^XA
^FO50,50^ADN,36,20^FDHELLO HOWARDS DONUTS^FS
^XZ
`;

  res.set('Content-Type', 'text/plain');
  res.set('X-Star-CloudPRNT-Job', 'true');
  res.status(200).send(receipt);
});

app.get('/', (req, res) => {
  res.send('OK');
});

app.listen(process.env.PORT || 3000);
