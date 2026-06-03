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

module.exports = { welcomeEmail, loginLinkEmail };
