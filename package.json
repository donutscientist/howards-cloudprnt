import express from "express";
import fetch from "node-fetch";

const app = express();

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

let accessToken = "";
let job = "";

async function refreshAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:
      `client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}` +
      `&refresh_token=${REFRESH_TOKEN}&grant_type=refresh_token`,
  });

  const data = await res.json();
  accessToken = data.access_token;
}

async function checkGmail() {
  await refreshAccessToken();

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=in:inbox subject:\"New Order\" -label:Printed newer_than:2d",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const data = await res.json();

  if (!data.messages) return;

  const id = data.messages[0].id;

  const msg = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const full = await msg.json();

  const body = Buffer.from(
    full.payload.parts[0].body.data,
    "base64"
  ).toString("utf8");

  job =
    "HOWARD'S DONUTS\n" +
    "-------------------------\n" +
    body +
    "\n\n\n";

  await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ addLabelIds: ["Label_Printed"] }),
    }
  );
}

setInterval(checkGmail, 10000);

// ====== CLOUDPRNT ======

app.get("/", (req, res) => {
  res.setHeader("X-Star-CloudPRNT-Job", job ? "true" : "false");
  res.status(200).send("OK");
});

app.post("/", (req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(job);
  job = "";
});

app.listen(3000);
