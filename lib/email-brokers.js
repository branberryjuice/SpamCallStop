'use strict';

/**
 * Data brokers that accept opt-out / deletion requests by EMAIL (not just a web
 * form or phone). Source: BADBOOL (Big-Ass Data Broker Opt-Out List) + each
 * broker's published opt-out method, as of 2026-06.
 *
 * `covers` = additional brands the same request removes (one Intelius /
 * PeopleConnect request sweeps ~17 owned sites). `requires` = the info the
 * broker needs to find the record. Expand this list over time.
 *
 * Form-only / phone-only brokers (BeenVerified, Spokeo, Whitepages, ClustrMaps,
 * FastPeopleSearch, ...) are intentionally NOT here — they need form automation,
 * which is a later phase.
 */

const EMAIL_BROKERS = [
  {
    key: 'intelius',
    name: 'Intelius / PeopleConnect',
    email: 'support@mailer.intelius.com',
    requires: ['name', 'phone'],
    covers: ['TruthFinder', 'Instant Checkmate', 'US Search', 'ZabaSearch', 'PeopleFinder',
      'Classmates', 'iSearch', 'LookUpAnyone', 'Addresses.com', 'AnyWho', 'DateCheck'],
    note: 'One request sweeps the PeopleConnect family of ~17 sites.',
  },
  { key: 'mylife',   name: 'MyLife',   email: 'privacy@mylife.com',           requires: ['name', 'phone'], covers: [], note: 'Include a profile link if known.' },
  { key: 'nuwber',   name: 'Nuwber',   email: 'support@nuwber.com',           requires: ['name', 'phone'], covers: [], note: '' },
  { key: 'radaris',  name: 'Radaris',  email: 'customer-service@radaris.com', requires: ['name', 'phone'], covers: [], note: 'May reply pointing to their form; flag for follow-up.' },
  { key: 'ancestry', name: 'Ancestry', email: 'privacy@ancestry.com',         requires: ['name'],          covers: [], note: '' },
  { key: 'spyfly',   name: 'SpyFly',   email: 'support@spyfly.com',           requires: ['name', 'phone'], covers: [], note: '' },
];

function listEmailBrokers() { return EMAIL_BROKERS.slice(); }
function getBroker(key) { return EMAIL_BROKERS.find((b) => b.key === key) || null; }

module.exports = { EMAIL_BROKERS, listEmailBrokers, getBroker };
