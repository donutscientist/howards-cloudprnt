const express = require("express");
const { google } = require("googleapis");

const app = express();
app.use(express.text());

const PORT = process.env.PORT || 3000;

const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/gmail.modify"],
});

async function getNewOrder() {
  const client = await auth.getClient();
  const gmail = google.gmail({ version: "v1", auth: client });

  const res = await gmail.users.messages.list({
    userId: "me",
    q: 'in:inbox subject:"New Order" -label:Printed',
    maxResults: 1,
  });

  if (!res.data.messages) return null;

  const msg = await gmail.users.messages.get({
    userId: "me",
    id: res.data.messages[0].id,
  });

  const body = Buffer.from(
    msg.data.payload.parts[0].body.data,
    "base64"
  ).toString("utf-8");

  await gmail.users.messages.modify({
    userId: "me",
    id: res.data.messages[0].id,
    requestBody: {
      addLabelIds: ["Printed"],
    },
  });

  return body;
}

app.get("/cloudprnt", async (req, res) => {
  const order = await getNewOrder();

  if (!order) {
    res.set("X-Star-CloudPRNT-StatusCode", "204");
    return res.send("");
  }

  const receipt =
    "HOWARD'S DONUTS\n" +
    "----------------------\n" +
    order +
    "\n\n\n\n";

  res.set("X-Star-CloudPRNT-Job", "true");
  res.set("X-Star-CloudPRNT-StatusCode", "200");
  res.send(receipt);
});

app.listen(PORT, () => console.log("Server running"));
