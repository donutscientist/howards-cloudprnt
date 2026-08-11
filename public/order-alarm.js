(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.OrderAlarm = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ORDER_ALARM_REPEAT_MS = 1800;
  const ORDER_ALARM_GAIN = 1;
  const ORDER_ALARM_PATTERN = Object.freeze([
    Object.freeze({ frequency: 1000, duration: 0.25 }),
    Object.freeze({ frequency: 1500, duration: 0.25 }),
    Object.freeze({ frequency: 1000, duration: 0.25 }),
    Object.freeze({ frequency: 1500, duration: 0.4 })
  ]);

  function playAttentionTone(audioContext, output) {
    const start = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const envelope = audioContext.createGain();
    let offset = 0;
    oscillator.type = "square";
    for (const tone of ORDER_ALARM_PATTERN) {
      oscillator.frequency.setValueAtTime(tone.frequency, start + offset);
      offset += tone.duration;
    }
    envelope.gain.setValueAtTime(0.001, start);
    envelope.gain.linearRampToValueAtTime(1, start + 0.01);
    envelope.gain.setValueAtTime(1, start + offset - 0.015);
    envelope.gain.linearRampToValueAtTime(0.001, start + offset);
    oscillator.connect(envelope).connect(output);
    oscillator.start(start);
    oscillator.stop(start + offset);
  }

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

  return { ORDER_ALARM_REPEAT_MS, ORDER_ALARM_GAIN, ORDER_ALARM_PATTERN, playAttentionTone, createOrderAlarmController };
});
