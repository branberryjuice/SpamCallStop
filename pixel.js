'use strict';

/*
 * SpamCallStop ad + analytics tag (Google Ads conversion tracking + GA4).
 *
 * >>> SET YOUR THREE IDS BELOW <<<  (get them from your Google Ads + GA4 accounts)
 *   GA4_ID                    -> "G-XXXXXXXXXX"   (GA4 Measurement ID, optional)
 *   GOOGLE_ADS_ID             -> "AW-XXXXXXXXX"   (Google Ads conversion ID)
 *   GOOGLE_ADS_PURCHASE_LABEL -> "abcdEFGhIJ"     (the purchase conversion action's label)
 *
 * Until you replace the placeholders, this loads nothing and tracks nothing — the
 * site is unaffected. Google Ads attribution works because this tag is on the
 * landing page (captures the ad click) and the purchase fires on thank-you.html.
 */
(function () {
  var GA4_ID = 'G-XXXXXXXXXX';
  var GOOGLE_ADS_ID = 'AW-XXXXXXXXX';
  var GOOGLE_ADS_PURCHASE_LABEL = 'PASTE_LABEL';

  function isSet(v) { return !!v && v.indexOf('XXXX') === -1 && v.indexOf('PASTE_') === -1; }
  var adsOn = isSet(GOOGLE_ADS_ID);
  var ga4On = isSet(GA4_ID);

  // Always expose the purchase tracker (it no-ops safely if tags aren't configured).
  window.scstopTrackPurchase = function (value, currency, txnId) {
    if (typeof window.gtag !== 'function') return;
    currency = currency || 'USD';
    if (adsOn && isSet(GOOGLE_ADS_PURCHASE_LABEL)) {
      var conv = { send_to: GOOGLE_ADS_ID + '/' + GOOGLE_ADS_PURCHASE_LABEL };
      if (typeof value === 'number') { conv.value = value; conv.currency = currency; }
      if (txnId) { conv.transaction_id = txnId; }
      window.gtag('event', 'conversion', conv);
    }
    if (ga4On) {
      var pur = { currency: currency };
      if (typeof value === 'number') pur.value = value;
      if (txnId) pur.transaction_id = txnId;
      window.gtag('event', 'purchase', pur);
    }
  };

  if (!adsOn && !ga4On) return; // nothing configured yet — load nothing

  // Load gtag.js once (async) and configure GA4 and/or Google Ads.
  var primary = ga4On ? GA4_ID : GOOGLE_ADS_ID;
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(primary);
  (document.head || document.documentElement).appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  if (ga4On) window.gtag('config', GA4_ID);
  if (adsOn) window.gtag('config', GOOGLE_ADS_ID);
})();
