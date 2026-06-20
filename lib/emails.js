'use strict';

/**
 * Customer email templates (plain text + simple HTML). Kept simple and
 * reassuring, no broker names — matching the dashboard's tone.
 */

function firstNameOf(c) {
  return (c && c.name ? String(c.name).trim().split(/\s+/)[0] : '') || 'there';
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
function wrap(lines, linkUrl) {
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">' +
    lines.map(function (l) {
      if (l === '') return '<br>';
      if (linkUrl && l === linkUrl) return '<div style="margin:6px 0"><a href="' + esc(l) + '" style="color:#1F7A4D;font-weight:bold">View your dashboard</a></div>';
      return '<div>' + esc(l) + '</div>';
    }).join('') + '</div>';
  return { text: lines.join('\n'), html: html };
}

function welcomeEmail(customer, dashboardUrl) {
  const name = firstNameOf(customer);
  const lines = [
    'Hi ' + name + ',',
    '',
    "Thanks for joining SpamCallStop. We've started taking your phone number off the lists that spammers and scammers buy, and we'll keep checking every day and remove any new ones. You don't have to do anything.",
    '',
    'You can see your progress any time here:',
    dashboardUrl,
    '',
    'We will keep working in the background. Questions? Just reply to this email.',
    '',
    'SpamCallStop',
  ];
  const body = wrap(lines, dashboardUrl);
  return { subject: "You're protected. We've started removing your number.", text: body.text, html: body.html };
}

function loginLinkEmail(customer, dashboardUrl) {
  const name = firstNameOf(customer);
  const lines = [
    'Hi ' + name + ',',
    '',
    "Here's your private link to see your removal progress:",
    dashboardUrl,
    '',
    'This link is just for you. SpamCallStop',
  ];
  const body = wrap(lines, dashboardUrl);
  return { subject: 'Your SpamCallStop dashboard link', text: body.text, html: body.html };
}

// Abandoned-checkout recovery: emailed to someone who started checkout but didn't
// finish. `recoveryUrl` is Stripe's one-click resume link (valid ~30 days).
function recoveryEmail(recoveryUrl) {
  const lines = [
    'Hi there,',
    '',
    "You started removing your phone number from the data-broker sites that feed spam and scam calls, but it looks like you didn't finish.",
    '',
    'Your spot is saved. You can pick up right where you left off in one click:',
    recoveryUrl,
    '',
    'It takes about a minute, and we start working within 24 to 48 hours.',
    '',
    'SpamCallStop',
  ];
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#111">' +
    lines.map(function (l) {
      if (l === '') return '<br>';
      if (l === recoveryUrl) return '<div style="margin:10px 0"><a href="' + esc(l) + '" style="background:#1F7A4D;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Finish removing my number</a></div>';
      return '<div>' + esc(l) + '</div>';
    }).join('') + '</div>';
  return { subject: 'You started removing your number — finish in one click', text: lines.join('\n'), html: html };
}

// Trial-ending reminder: Stripe fires `customer.subscription.trial_will_end`
// ~3 days before the first charge. The paywall PROMISES "we'll email you before
// your first charge," so this email makes good on that (and keeps us on the right
// side of FTC negative-option / auto-renewal rules). `priceLabel` like "$14.99/mo",
// `chargeDate` like "June 27, 2026", `dashboardUrl` is where they cancel.
function trialEndingEmail(customer, dashboardUrl, priceLabel, chargeDate) {
  const name = firstNameOf(customer);
  const price = priceLabel ? String(priceLabel) : 'your plan price';
  const when = chargeDate ? (' on ' + String(chargeDate)) : ' soon';
  const lines = [
    'Hi ' + name + ',',
    '',
    'Quick heads-up: your 7-day free trial of SpamCallStop is ending, so your subscription (' + price + ') will begin' + when + ' unless you cancel before then.',
    '',
    "There's nothing you need to do to continue — we'll keep your number off the data-broker lists automatically.",
    '',
    'If you\'d like to cancel, you can do it any time in one click from your dashboard:',
    dashboardUrl,
    '',
    'Questions? Just reply to this email. SpamCallStop',
  ];
  const body = wrap(lines, dashboardUrl);
  return { subject: 'Your free trial ends soon — ' + price + ' starts' + when, text: body.text, html: body.html };
}

module.exports = { welcomeEmail, loginLinkEmail, recoveryEmail, trialEndingEmail };
