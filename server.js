const express = require('express');
const app = express();

app.use(express.raw({ type: '*/*' }));

app.get('/', (req, res) => {
  res.send('OK');
});

app.post('/starcloudprnt', (req, res) => {
  console.log("PRINTER POLLED");

  const receipt =
  "\x1b\x40" +
  "HOWARD'S DONUTS\n" +
  "CloudPRNT Working!\n\n" +
  "Time: " + new Date() + "\n\n\n\n\n" +
  "\x1b\x64\x02" +
  "\x1b\x69";

  res.set({
    "Content-Type": "application/vnd.star.starprnt",
    "X-Star-CloudPRNT-Job": "true",
    "X-Star-CloudPRNT-StatusCode": "200"
  });

  res.send(receipt);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running");
});
