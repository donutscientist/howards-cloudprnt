const assert = require("assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

process.env.CLEAR_KEY = "alert-test-key";
process.env.BUSINESS_TZ = "UTC";
process.env.ROUTE_1 = "print1";
process.env.ROUTE_2 = "print2";
process.env.CLIENT_ID = "test";
process.env.CLIENT_SECRET = "test";
process.env.REFRESH_TOKEN = "test";

const { app, enqueueReceipt, getRouteQueue, alertSystem } = require("../server.cjs");
const server = app.listen(0);
const port = server.address().port;
function request(method, url) { return new Promise((resolve, reject) => { const req=http.request({port,method,path:url},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}))});req.on("error",reject);req.end() }) }

(async () => {
  try {
    alertSystem._clearForTests();
    const q1=getRouteQueue("print1"),q2=getRouteQueue("print2");
    const token1=enqueueReceipt(Buffer.from("one"),"print1");
    const first=alertSystem.createShopAlert({shop:1,jobReference:token1,source:"UberEats",type:"Delivery",customer:"Pat",reference:"A1",orderedTime:"07/28/2026 6:18 AM",scheduleType:"ASAP",customerPhone:"+1 901-555-1234",courierPhone:"+1 312-555-5678",customerNote:"Payment card 4242",items:[{item:"2x Burger $12.00",modifiers:["3x Pickle"]},{item:"1x Shake",modifiers:["2x Cherry"]}]});
    assert.strictEqual(alertSystem.createShopAlert({shop:1,jobReference:token1,source:"UberEats",type:"Delivery"}).id,first.id);
    const token2=enqueueReceipt(Buffer.from("two"),"print2");
    const second=alertSystem.createShopAlert({shop:2,jobReference:token2,source:"DoorDash",type:"Pickup",items:[{item:"1x Donut",modifiers:[]}]});
    assert.strictEqual(alertSystem.getShopAlerts(1).length,1);
    assert.strictEqual(alertSystem.getShopAlerts(2).length,1);
    assert.strictEqual(first.acknowledged,false);
    assert.strictEqual((await request("GET","/api/alert1?key=wrong")).status,401);
    const shop1=await request("GET","/api/alert1?key=alert-test-key");
    assert.strictEqual(shop1.status,200);assert.doesNotMatch(shop1.body,new RegExp(second.id));
    const detail=JSON.parse(shop1.body).alerts[0];
    assert.deepStrictEqual(detail.items,[{item:"2x Burger",modifiers:["3x Pickle"]},{item:"1x Shake",modifiers:["2x Cherry"]}]);
    assert.doesNotMatch(shop1.body,/price|subtotal|tax|tip|total|tender|payment|card/i);
    alertSystem.acknowledgeShopAlert(1,first.id);
    assert.strictEqual(alertSystem.getShopAlerts(1)[0].acknowledged,true);
    assert.strictEqual(alertSystem.getShopAlerts(2)[0].acknowledged,false);
    assert.ok(q1.activeJobs.has(token1));assert.ok(q2.activeJobs.has(token2));
    const third=alertSystem.createShopAlert({shop:1,jobReference:"three",source:"GrubHub",type:"Pickup"});
    const fourth=alertSystem.createShopAlert({shop:1,jobReference:"four",source:"UberEats",type:"Pickup"});
    assert.strictEqual(alertSystem.getShopAlerts(1).filter(a=>!a.acknowledged).length,2);
    alertSystem.acknowledgeShopAlert(1,third.id);
    assert.strictEqual(alertSystem.getShopAlerts(1).some(a=>!a.acknowledged),true);
    alertSystem.acknowledgeShopAlert(1,fourth.id);
    assert.strictEqual(alertSystem.getShopAlerts(1).some(a=>!a.acknowledged),false);
    assert.strictEqual(JSON.parse((await request("GET","/api/alert1?key=alert-test-key")).body).alerts.length,3);
    alertSystem.createShopAlert({shop:1,jobReference:"old",source:"UberEats",type:"Pickup",createdAt:new Date(Date.now()-25*60*60*1000).toISOString()});
    alertSystem.pruneOldAlerts();assert.strictEqual(alertSystem.getShopAlerts(1).length,3);
    const pendingBefore=q1.pending.length;
    assert.strictEqual(alertSystem.runAlertMaintenance(new Date("2026-08-07T01:00:10Z"),"UTC"),true);
    assert.strictEqual(alertSystem.getShopAlerts(1).length,0);assert.strictEqual(q1.pending.length,pendingBefore);
    const manifestResponse=await request("GET","/alert1/manifest.webmanifest?key=alert-test-key");
    const manifest=JSON.parse(manifestResponse.body);assert.strictEqual(manifest.display,"standalone");assert.match(manifest.start_url,/^\/alert1\?key=/);assert.ok(manifest.icons.length);
    const page=await request("GET","/alert1?key=alert-test-key");assert.strictEqual(page.status,200);assert.match(page.body,/alert-app\.js/);assert.doesNotMatch(page.body,/ENABLE SOUND|TEST SOUND|ACKNOWLEDGE/i);
    const client=fs.readFileSync(path.join(__dirname,"../public/alert-app.js"),"utf8");assert.match(client,/serviceWorker\?\.register\('\/alert-sw\.js'\)/);assert.match(client,/setInterval\(refresh, 3000\)/);assert.match(client,/VIEW DETAILS/);assert.match(client,/a\.customer \|\| "Customer"/);assert.match(client,/new URLSearchParams\(location\.search\)\.get\("order"\)/);assert.match(client,/Total: \$\{escape\(totalItems\)\} Items/);assert.match(client,/reduce\(\(total, item\) => total \+ itemQuantity\(item\.item\), 0\)/);assert.doesNotMatch(client,/<ul>|<li>|•|○|Online Order|AudioContext|Oscillator|vibrate|acknowledge|tone|alarm/i);
    const styles=fs.readFileSync(path.join(__dirname,"../public/alert-app.css"),"utf8");assert.match(styles,/grid-template-areas:"name actions" "meta actions"/);assert.match(styles,/padding:16px 18px/);assert.match(styles,/\.details\{[^}]*padding:11px[^}]*font-size:14px/);assert.match(styles,/\.modifiers\{[^}]*margin-left:1\.5em/);
    process.env.PUSHOVER_DEVICE_1="front-counter";process.env.PUSHOVER_DEVICE_2="kitchen-tablet";
    const push=alertSystem.buildPushoverValues(first,"token","user");assert.strictEqual(push.priority,"2");assert.strictEqual(push.retry,"60");assert.strictEqual(push.expire,"1800");assert.strictEqual(Object.hasOwn(push,"title"),false);assert.strictEqual(push.message,"Pat\nUberEats - Delivery");assert.strictEqual(push.device,"front-counter");assert.notStrictEqual(push.device,process.env.PUSHOVER_DEVICE_2);assert.doesNotMatch(push.message,/Burger|Pickle|Shake|Cherry|A1|901|312|Schedule|Ordered/i);assert.match(push.url,new RegExp(`/alert1\\?key=alert-test-key&order=${first.id}$`));assert.strictEqual(push.url_title,"View Details");assert.doesNotMatch(push.url,new RegExp(`${token1}|A1`));
    const example=alertSystem.createShopAlert({shop:1,jobReference:"title-example",source:"DoorDash",type:"Delivery",customer:"Tristan G."});assert.strictEqual(alertSystem.buildPushoverValues(example,"token","user").message,"Tristan G.\nDoorDash - Delivery");
    const push2=alertSystem.buildPushoverValues(second,"token","user");assert.strictEqual(push2.message,"Customer\nDoorDash - Pickup");assert.match(push2.url,new RegExp(`/alert2\\?key=alert-test-key&order=${second.id}$`));assert.strictEqual(push2.device,"kitchen-tablet");assert.notStrictEqual(push2.device,process.env.PUSHOVER_DEVICE_1);
    delete process.env.PUSHOVER_DEVICE_1;const fallback=alertSystem.buildPushoverValues(first,"token","user");assert.strictEqual(fallback.user,"user");assert.strictEqual(Object.hasOwn(fallback,"device"),false);delete process.env.PUSHOVER_DEVICE_2;
    const generic=alertSystem.createShopAlert({shop:1,jobReference:"generic",source:"UberEats",type:"Pickup",customer:"Online Order"});assert.strictEqual(alertSystem.buildPushoverValues(generic,"token","user").message,"Customer\nUberEats - Pickup");
    const pushoverSource=fs.readFileSync(path.join(__dirname,"../alert-system.cjs"),"utf8");assert.doesNotMatch(pushoverSource,/New Order - Shop|View Order/);
    delete process.env.CLEAR_KEY;assert.strictEqual((await request("GET","/alert1?key=alert-test-key")).status,404);
    console.log("Alert system verification passed");
  } finally { server.close(); }
  process.exit(0);
})().catch(err=>{console.error(err);server.close();process.exit(1)});
