(() => {
  const shop = Number(location.pathname.match(/^\/alert(\d+)/)?.[1]);
  const key = new URLSearchParams(location.search).get("key") || "";
  const api = () => `/api/alert${shop}?key=${encodeURIComponent(key)}`;
  let alerts = [], openedOrder = "", selectedTab = "active", serviceWorkerRegistration, audioContext, audioUnlocked = false;
  const $ = (id) => document.getElementById(id);
  const escape = (s) => String(s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const itemQuantity = (item) => Number(String(item || "").match(/^\s*(\d+(?:\.\d+)?)x\b/i)?.[1] || 0);
  const orderedTime = (alert) => String(alert.orderedTime || alert.receivedTime || "").match(/\b\d{1,2}:\d{2}\s*[AP]M\b/i)?.[0] || alert.orderedTime || alert.receivedTime || "";
  const applicationServerKey = (value) => { const padding = "=".repeat((4 - value.length % 4) % 4); return Uint8Array.from(atob((value + padding).replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)); };
  function playOrderTone() {
    if (!audioUnlocked || !audioContext || audioContext.state !== "running") return;
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(.35, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .65);
    oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + .65);
  }
  const orderAlarm = OrderAlarm.createOrderAlarmController(playOrderTone);
  function syncAlarm() { orderAlarm.update(alerts, document.visibilityState !== "hidden"); }
  function unlockAudio() {
    if (audioUnlocked) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      const resumed = audioContext.resume();
      Promise.resolve(resumed).then(() => { audioUnlocked = audioContext.state === "running"; }).catch(() => {});
    } catch {}
  }

  function render() {
    const activeCount = alerts.filter(a => a.status === "active").length;
    const completeCount = alerts.filter(a => a.status === "complete").length;
    const records = alerts.filter(a => a.status === selectedTab).sort((a, b) => new Date(selectedTab === "complete" ? b.completedAt : b.createdAt) - new Date(selectedTab === "complete" ? a.completedAt : a.createdAt));
    $("orderTabs").querySelector('[data-tab="active"]').textContent = `Active (${activeCount})`;
    $("orderTabs").querySelector('[data-tab="complete"]').textContent = `Complete (${completeCount})`;
    $("orderTabs").querySelectorAll("button").forEach(button => button.classList.toggle("selected", button.dataset.tab === selectedTab));
    $("alerts").innerHTML = records.length ? records.map(a => `<article class="alert${!a.acknowledged ? " unacknowledged" : ""}" data-order="${a.id}" tabindex="0" role="button" aria-label="Open order for ${escape(a.customer || "Customer")}"><h2>${escape(a.customer || "Customer")} - ${escape(orderedTime(a))}</h2><div class="meta">${escape(a.source)} - ${escape(a.type)}</div><div class="actions"><button data-status="${selectedTab === "active" ? "complete" : "active"}" data-id="${a.id}">${selectedTab === "active" ? "PICKED UP" : "UNDO"}</button></div></article>`).join("") : `<div class="empty">No ${selectedTab} orders.</div>`;
    syncAlarm();
  }
  async function refresh() {
    try {
      const response = await fetch(api(), { cache: "no-store" });
      if (!response.ok) throw Error(response.status);
      alerts = (await response.json()).alerts;
      $("status").textContent = "CONNECTED"; $("status").className = "status connected"; render();
      const requested = new URLSearchParams(location.search).get("order");
      if (requested && requested !== openedOrder) void openOrder(requested);
    } catch {
      $("status").textContent = navigator.onLine ? "RECONNECTING" : "OFFLINE";
      $("status").className = "status " + (navigator.onLine ? "reconnecting" : "offline");
    }
  }
  function view(id) {
    const a = alerts.find(x => x.id === id); if (!a) return; openedOrder = id;
    $("listView").classList.add("hidden"); $("detailView").classList.remove("hidden");
    $("detailAction").textContent = a.status === "active" ? "PICKED UP" : "UNDO";
    $("detailAction").dataset.status = a.status === "active" ? "complete" : "active";
    $("detailAction").dataset.id = a.id;
    const totalItems = a.items.reduce((total, item) => total + itemQuantity(item.item), 0);
    $("detailBody").innerHTML = `<div class="customer-details"><h2 class="customer-name">${escape(a.customer || "Customer")}</h2><div class="detail-meta"><p>${escape(a.source)} - ${escape(a.type)}</p><p>Ordered on: ${escape(a.orderedTime || a.receivedTime)}</p>${a.reference ? `<p>Order ID: ${escape(a.reference)}</p>` : ""}${a.scheduledTime || a.scheduleType ? `<p>Schedule: ${escape(a.scheduledTime || a.scheduleType)}</p>` : ""}</div><hr class="detail-separator"></div><h2 class="items-heading">Total: ${escape(totalItems)} Items</h2><div class="item-list">${a.items.map(i => `<div class="item"><div class="item-name">${escape(i.item)}</div>${i.modifiers.length ? `<div class="modifiers">${i.modifiers.map(m => `<div class="modifier">${escape(m)}</div>`).join("")}</div>` : ""}</div>`).join("")}</div>${a.customerNote ? `<p><strong>Customer note:</strong> ${escape(a.customerNote)}</p>` : ""}${a.fulfillmentNote ? `<p><strong>Order note:</strong> ${escape(a.fulfillmentNote)}</p>` : ""}`;
  }
  async function acknowledge(id) {
    const current = alerts.find(a => a.id === id);
    if (!current || current.acknowledged) return;
    const response = await fetch(`/api/alert${shop}/${encodeURIComponent(id)}/acknowledge?key=${encodeURIComponent(key)}`, { method: "POST" });
    if (!response.ok) throw Error(response.status);
    const updated = (await response.json()).alert;
    alerts = alerts.map(alert => alert.id === id ? updated : alert); render();
  }
  async function openOrder(id) { try { await acknowledge(id); view(id); } catch { await refresh(); } }
  function closeDetail() {
    openedOrder = ""; $("detailView").classList.add("hidden"); $("listView").classList.remove("hidden");
    history.replaceState(null, "", `/alert${shop}?key=${encodeURIComponent(key)}`);
  }
  async function setStatus(id, status) {
    const response = await fetch(`/api/alert${shop}/${encodeURIComponent(id)}/${status}?key=${encodeURIComponent(key)}`, { method: "POST" });
    if (!response.ok) throw Error(response.status);
    const updated = (await response.json()).alert;
    alerts = alerts.map(alert => alert.id === id ? updated : alert); render();
  }
  async function ensurePushSubscription() {
    if (!serviceWorkerRegistration || !("PushManager" in window) || !("Notification" in window) || Notification.permission !== "granted") return;
    let subscription = await serviceWorkerRegistration.pushManager.getSubscription();
    if (!subscription) {
    const response = await fetch(`/api/alert${shop}/push-key?key=${encodeURIComponent(key)}`, { cache: "no-store" });
    const publicKey = (await response.json()).publicKey;
    if (!publicKey) throw Error("Web Push is not configured");
      subscription = await serviceWorkerRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
    }
    const saved = await fetch(`/api/alert${shop}/push-subscription?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription) });
    if (!saved.ok) throw Error(saved.status);
  }
  $("alerts").onclick = e => {
    const action = e.target.closest("button[data-status]");
    if (action) { e.stopPropagation(); void setStatus(action.dataset.id, action.dataset.status); return; }
    const card = e.target.closest("[data-order]"); if (card) void openOrder(card.dataset.order);
  };
  $("alerts").onkeydown = e => { if ((e.key === "Enter" || e.key === " ") && !e.target.closest("button") && e.target.dataset.order) { e.preventDefault(); void openOrder(e.target.dataset.order); } };
  $("orderTabs").onclick = e => { if (!e.target.dataset.tab) return; selectedTab = e.target.dataset.tab; closeDetail(); render(); };
  $("detailAction").onclick = async e => { await setStatus(e.target.dataset.id, e.target.dataset.status); selectedTab = e.target.dataset.status; closeDetail(); render(); };
  navigator.serviceWorker?.addEventListener("message", event => { if (event.data?.type === "open-order" && event.data.shop === shop) { history.replaceState(null, "", `/alert${shop}?key=${encodeURIComponent(key)}&order=${encodeURIComponent(event.data.order)}`); void refresh(); } });
  document.addEventListener("visibilitychange", () => { syncAlarm(); if (document.visibilityState === "visible") void refresh(); });
  window.addEventListener("pageshow", () => { syncAlarm(); void refresh(); });
  window.addEventListener("focus", syncAlarm);
  document.addEventListener("pointerdown", unlockAudio, { capture: true });
  document.addEventListener("keydown", unlockAudio, { capture: true });
  window.addEventListener("online", refresh);
  document.querySelector('link[rel="manifest"]').href = `/alert${shop}/manifest.webmanifest?key=${encodeURIComponent(key)}`;
  navigator.serviceWorker?.register("/alert-sw.js").then(() => navigator.serviceWorker.ready).then(registration => { serviceWorkerRegistration = registration; registration.active?.postMessage({ type: "configure-shop", shop, appUrl: location.href }); return ensurePushSubscription(); }).catch(() => {});
  refresh(); setInterval(refresh, 3000);
})();
