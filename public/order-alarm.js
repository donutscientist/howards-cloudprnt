(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrderAlarm = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ORDER_ALARM_URL = "/order-alarm.wav";
  const ORDER_ALARM_REPEAT_DELAY_MS = 1500;
  const ORDER_ALARM_VOLUME = 1;

  function createOrderAlarmController(playEntireAlarm, resetPlayback, timers = globalThis) {
    let repeatTimer = null;
    let running = false;
    let generation = 0;

    function stop() {
      generation++;
      running = false;
      if (repeatTimer !== null) timers.clearTimeout(repeatTimer);
      repeatTimer = null;
      resetPlayback();
    }

    async function playCycle(currentGeneration) {
      try { await playEntireAlarm(); } catch {}
      if (!running || generation !== currentGeneration) return;
      repeatTimer = timers.setTimeout(() => {
        repeatTimer = null;
        void playCycle(currentGeneration);
      }, ORDER_ALARM_REPEAT_DELAY_MS);
    }

    function update(orders, canPlay = true) {
      const shouldAlarm = canPlay && orders.some(order => order.status === "active" && !order.acknowledged);
      if (!shouldAlarm) {
        if (running || repeatTimer !== null) stop();
        return;
      }
      if (running) return;
      running = true;
      const currentGeneration = ++generation;
      void playCycle(currentGeneration);
    }

    return { update, stop, isRunning: () => running };
  }

  return { ORDER_ALARM_URL, ORDER_ALARM_REPEAT_DELAY_MS, ORDER_ALARM_VOLUME, createOrderAlarmController };
});
