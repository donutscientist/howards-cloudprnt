(() => {
  const shop = Number(location.pathname.match(/^\/alert(\d+)/)?.[1]);
  const key = new URLSearchParams(location.search).get("key") || "";
  const api = () => `/api/alert${shop}?key=${encodeURIComponent(key)}`;
  let alerts = [], openedOrder = "", selectedTab = "active";
  const $ = (id) => document.getElementById(id);
  const escape = (s) => String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const itemQuantity = (item) => Number(String(item || "").match(/^\s*(\d+(?:\.\d+)?)x\b/i)?.[1] || 0);
  function render() {
    const activeCount = alerts.filter(a => a.status === "active").length;
    const completeCount = alerts.filter(a => a.status === "complete").length;
    const records = alerts.filter(a => a.status === selectedTab).sort((a, b) => new Date(selectedTab === "complete" ? b.completedAt : b.createdAt) - new Date(selectedTab === "complete" ? a.completedAt : a.createdAt));
    $("orderTabs").querySelector('[data-tab="active"]').textContent = `Active (${activeCount})`;
    $("orderTabs").querySelector('[data-tab="complete"]').textContent = `Complete (${completeCount})`;
    $("orderTabs").querySelectorAll("button").forEach(button => button.classList.toggle("selected", button.dataset.tab === selectedTab));
    $("alerts").innerHTML = records.length ? records.map(a => `<article class="alert" data-order="${a.id}" tabindex="0" role="button" aria-label="Open order for ${escape(a.customer || "Customer")}"><h2>${escape(a.customer || "Customer")}</h2><div class="meta">${escape(a.source)} - ${escape(a.type)}</div><div class="actions"><button data-status="${selectedTab === "active" ? "complete" : "active"}" data-id="${a.id}">${selectedTab === "active" ? "PICKED UP" : "UNDO"}</button></div></article>`).join("") : `<div class="empty">No ${selectedTab} orders.</div>`;
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
    const totalItems = a.items.reduce((total, item) => total + itemQuantity(item.item), 0);
    $("detailBody").innerHTML = `<h2 class="customer-name">${escape(a.customer || "Customer")}</h2><div class="detail-meta"><p><strong>Source:</strong> ${escape(a.source)}</p><p><strong>Type:</strong> ${escape(a.type)}</p>${a.reference ? `<p><strong>Order:</strong> ${escape(a.reference)}</p>` : ""}<p><strong>Ordered on:</strong> ${escape(a.orderedTime || a.receivedTime)}</p>${a.scheduleType ? `<p><strong>Schedule:</strong> ${escape(a.scheduleType)}</p>` : ""}${a.scheduledTime ? `<p><strong>Scheduled time:</strong> ${escape(a.scheduledTime)}</p>` : ""}${a.customerPhone ? `<p><strong>Customer phone:</strong> ${escape(a.customerPhone)}</p>` : ""}${a.courierPhone ? `<p><strong>Courier phone:</strong> ${escape(a.courierPhone)}</p>` : ""}</div><h2 class="items-heading">Total: ${escape(totalItems)} Items</h2><div class="item-list">${a.items.map(i => `<div class="item"><div class="item-name">${escape(i.item)}</div>${i.modifiers.length ? `<div class="modifiers">${i.modifiers.map(m => `<div class="modifier">${escape(m)}</div>`).join("")}</div>` : ""}</div>`).join("")}</div>${a.customerNote ? `<p><strong>Customer note:</strong> ${escape(a.customerNote)}</p>` : ""}${a.fulfillmentNote ? `<p><strong>Order note:</strong> ${escape(a.fulfillmentNote)}</p>` : ""}`;
  }
  async function setStatus(id, status) {
    const response = await fetch(`/api/alert${shop}/${encodeURIComponent(id)}/${status}?key=${encodeURIComponent(key)}`, { method: "POST" });
    if (!response.ok) throw Error(response.status);
    const updated = (await response.json()).alert;
    alerts = alerts.map(alert => alert.id === id ? updated : alert);
    render();
  }
  $("alerts").onclick = e => {
    const action = e.target.closest("button[data-status]");
    if (action) { e.stopPropagation(); void setStatus(action.dataset.id, action.dataset.status); return; }
    const card = e.target.closest("[data-order]"); if (card) view(card.dataset.order);
  };
  $("alerts").onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button") && e.target.dataset.order) { e.preventDefault(); view(e.target.dataset.order); } };
  $("orderTabs").onclick = e => { if (!e.target.dataset.tab) return; selectedTab = e.target.dataset.tab; render(); };
  $("back").onclick = () => { openedOrder = ""; $("detailView").classList.add("hidden"); $("listView").classList.remove("hidden"); history.replaceState(null, "", `/alert${shop}?key=${encodeURIComponent(key)}`); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  window.addEventListener("online", refresh); $("shop").textContent = `Shop #${shop}`;
  document.querySelector('link[rel="manifest"]').href = `/alert${shop}/manifest.webmanifest?key=${encodeURIComponent(key)}`;
  navigator.serviceWorker?.register('/alert-sw.js'); refresh(); setInterval(refresh, 3000);
})();
