/* SpamCallStop funnel analytics beacon — anonymous visitor id, best-effort.
   Never blocks or breaks the page; failures are swallowed silently. */
(function () {
  function vid() {
    try {
      var k = 'scstop_vid', v = localStorage.getItem(k);
      if (!v) { v = Date.now().toString(36) + Math.random().toString(36).slice(2, 10); localStorage.setItem(k, v); }
      return v;
    } catch (e) { return ''; }
  }
  window.scstopVid = vid;
  window.scstopTrack = function (event, extra) {
    try {
      var body = { visitor_id: vid(), event: event };
      if (extra) { for (var k in extra) { if (extra[k] != null) body[k] = extra[k]; } }
      var data = JSON.stringify(body);
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/track', new Blob([data], { type: 'application/json' }));
      } else {
        fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: data, keepalive: true }).catch(function () {});
      }
    } catch (e) {}
  };
})();
