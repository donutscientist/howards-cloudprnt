(() => {
  const shop = Number(location.pathname.match(/^\/alert(\d+)/)?.[1]);
  const key = new URLSearchParams(location.search).get("key") || "";
  const api = () => `/api/alert${shop}?key=${encodeURIComponent(key)}`;
  let alerts = [], openedOrder = "";
  const $ = (id) => document.getElementById(id);
  const escape = (s) => String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function render() {
    $("alerts").innerHTML = alerts.length ? alerts.map(a => `<article class="alert"><h2>${escape(a.customer || "Customer")}</h2><div class="meta">${escape(a.source)} - ${escape(a.type)}</div><div class="actions"><button data-view="${a.id}">VIEW DETAILS</button></div></article>`).join("") : '<div class="empty">No orders in today’s history.</div>';
  }
  async function refresh() {
    try {
      const response = await fetch(api(), { cache: "no-store" });
      if (!response.ok) throw Error(response.status);
      alerts = (await response.json()).alerts;
      $("status").textContent = "CONNECTED"; $("status").className = "status connected"; render();
      const requested = new URLSearchParams(location.search).get("order");
      if (requested && requested !== openedOrder) view(requested);
    } catch {
      $("status").textContent = navigator.onLine ? "RECONNECTING" : "OFFLINE";
      $("status").className = "status " + (navigator.onLine ? "reconnecting" : "offline");
    }
  }
  function view(id) {
    const a = alerts.find(x => x.id === id); if (!a) return; openedOrder = id;
    $("listView").classList.add("hidden"); $("detailView").classList.remove("hidden");
    $("detailBody").innerHTML = `<h2>${escape(a.customer || "Customer")}</h2><p><strong>Source:</strong> ${escape(a.source)}</p><p><strong>Type:</strong> ${escape(a.type)}</p>${a.reference ? `<p><strong>Order:</strong> ${escape(a.reference)}</p>` : ""}<p><strong>Ordered on:</strong> ${escape(a.orderedTime || a.receivedTime)}</p>${a.scheduleType ? `<p><strong>Schedule:</strong> ${escape(a.scheduleType)}</p>` : ""}${a.scheduledTime ? `<p><strong>Scheduled time:</strong> ${escape(a.scheduledTime)}</p>` : ""}<h2>Items</h2><ul>${a.items.map(i => `<li>${escape(i.item)}${i.modifiers.length ? `<ul class="mods">${i.modifiers.map(m => `<li>${escape(m)}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ul>${a.customerNote ? `<p><strong>Customer note:</strong> ${escape(a.customerNote)}</p>` : ""}${a.fulfillmentNote ? `<p><strong>Order note:</strong> ${escape(a.fulfillmentNote)}</p>` : ""}`;
  }
  $("alerts").onclick = e => { if (e.target.dataset.view) view(e.target.dataset.view); };
  $("back").onclick = () => { openedOrder = ""; $("detailView").classList.add("hidden"); $("listView").classList.remove("hidden"); history.replaceState(null, "", `/alert${shop}?key=${encodeURIComponent(key)}`); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  window.addEventListener("online", refresh); $("shop").textContent = `Shop #${shop}`;
  document.querySelector('link[rel="manifest"]').href = `/alert${shop}/manifest.webmanifest?key=${encodeURIComponent(key)}`;
  navigator.serviceWorker?.register('/alert-sw.js'); refresh(); setInterval(refresh, 3000);
})();
