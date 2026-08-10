(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrderAlarm = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ORDER_ALARM_REPEAT_MS = 2500;

  function createOrderAlarmController(play, timers = globalThis) {
    let alarmTimer = null;

    function stop() {
      if (alarmTimer === null) return;
      timers.clearInterval(alarmTimer);
      alarmTimer = null;
    }

    function update(orders, visible = true) {
      const shouldAlarm = visible && orders.some(order => order.status === "active" && !order.acknowledged);
      if (!shouldAlarm) return stop();
      if (alarmTimer !== null) return;
      play();
      alarmTimer = timers.setInterval(play, ORDER_ALARM_REPEAT_MS);
    }

    return { update, stop, isRunning: () => alarmTimer !== null };
  }

  return { ORDER_ALARM_REPEAT_MS, createOrderAlarmController };
});
