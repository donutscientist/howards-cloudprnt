const crypto = require("crypto");
const https = require("https");

const b64url = (value) => Buffer.from(value).toString("base64url");
const fromB64url = (value) => Buffer.from(value, "base64url");
const hkdfExtract = (salt, input) => crypto.createHmac("sha256", salt).update(input).digest();
function hkdfExpand(prk, info, length) {
  let output = Buffer.alloc(0), previous = Buffer.alloc(0), counter = 1;
  while (output.length < length) {
    previous = crypto.createHmac("sha256", prk).update(Buffer.concat([previous, info, Buffer.from([counter++])])).digest();
    output = Buffer.concat([output, previous]);
  }
  return output.subarray(0, length);
}

function vapidKeys() {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY;
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const rawPublic = fromB64url(publicKey);
  if (rawPublic.length !== 65 || rawPublic[0] !== 4 || fromB64url(privateKey).length !== 32) throw new Error("Invalid VAPID keys");
  const key = crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", x: b64url(rawPublic.subarray(1, 33)), y: b64url(rawPublic.subarray(33)), d: b64url(fromB64url(privateKey)) }, format: "jwk" });
  return { publicKey, rawPublic, key };
}

function encryptPayload(subscription, payload) {
  const clientPublic = fromB64url(subscription.keys.p256dh);
  const auth = fromB64url(subscription.keys.auth);
  if (clientPublic.length !== 65 || auth.length !== 16) throw new Error("Invalid push subscription keys");
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(clientPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPublic, serverPublic]);
  const ikm = hkdfExpand(hkdfExtract(auth, shared), keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = serverPublic.length;
  return Buffer.concat([header, serverPublic, encrypted]);
}

function send(subscription, payload) {
  const keys = vapidKeys();
  if (!keys) return Promise.resolve({ skipped: true });
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:") return Promise.reject(new Error("Push endpoint must use HTTPS"));
  const now = Math.floor(Date.now() / 1000);
  const jwtHeader = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const jwtBody = b64url(JSON.stringify({ aud: endpoint.origin, exp: now + 12 * 60 * 60, sub: process.env.WEB_PUSH_SUBJECT || `mailto:webmaster@${endpoint.hostname}` }));
  const unsigned = `${jwtHeader}.${jwtBody}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key: keys.key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const body = encryptPayload(subscription, JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, { method: "POST", headers: { TTL: "300", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${unsigned}.${signature}, k=${keys.publicKey}`, "Content-Length": body.length } }, (res) => {
      res.resume(); res.on("end", () => resolve({ statusCode: res.statusCode }));
    });
    req.on("error", reject); req.end(body);
  });
}

module.exports = { send, vapidKeys, encryptPayload };
