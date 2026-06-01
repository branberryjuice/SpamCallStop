'use strict';

/**
 * SpamCallStop — Tier 1 broker list.
 *
 * These are the real data-broker / people-search sites our service removes
 * customers from. This list is the single source of truth used by:
 *   - the scan endpoint (to honestly state how many sites we cover), and
 *   - the removal queue (to know where to submit opt-outs).
 *
 * `group` marks shared suppression backends: one opt-out submission often
 * clears every site in the same group. Verify ownership/URLs at build time.
 */

const BROKERS = [
  { name: 'Spokeo',                    optOutUrl: 'https://www.spokeo.com/optout',                     group: null,             findBy: 'name'  },
  { name: 'BeenVerified',              optOutUrl: 'https://www.beenverified.com/app/optout/search',    group: 'beenverified',   findBy: 'name'  },
  { name: 'PeopleLooker',              optOutUrl: 'https://www.peoplelooker.com/f/optout/search',      group: 'beenverified',   findBy: 'name'  },
  { name: 'NeighborWho',               optOutUrl: 'https://www.neighborwho.com/optout',                group: 'beenverified',   findBy: 'name'  },
  { name: 'Ownerly',                   optOutUrl: 'https://www.ownerly.com/',                          group: 'beenverified',   findBy: 'name'  },
  { name: 'Intelius',                  optOutUrl: 'https://www.intelius.com/opt-out',                  group: 'peopleconnect',  findBy: 'name'  },
  { name: 'TruthFinder',               optOutUrl: 'https://www.truthfinder.com/opt-out',               group: 'peopleconnect',  findBy: 'name'  },
  { name: 'Instant Checkmate',         optOutUrl: 'https://www.instantcheckmate.com/opt-out',          group: 'peopleconnect',  findBy: 'name'  },
  { name: 'US Search',                 optOutUrl: 'https://www.ussearch.com/opt-out',                  group: 'peopleconnect',  findBy: 'name'  },
  { name: 'ZabaSearch',                optOutUrl: 'https://www.zabasearch.com/block_records',          group: 'peopleconnect',  findBy: 'name'  },
  { name: 'PeopleFinders',             optOutUrl: 'https://www.peoplefinders.com/opt-out',             group: 'peoplefinders',  findBy: 'name'  },
  { name: 'ClustrMaps',                optOutUrl: 'https://clustrmaps.com/bl/opt-out',                  group: null,             findBy: 'name'  },
  { name: 'ThatsThem',                 optOutUrl: 'https://thatsthem.com/optout',                       group: null,             findBy: 'name'  },
  { name: 'Nuwber',                    optOutUrl: 'https://nuwber.com/removal/link',                    group: null,             findBy: 'name'  },
  { name: 'PeekYou',                   optOutUrl: 'https://www.peekyou.com/about/contact/optout',      group: null,             findBy: 'name'  },
  { name: 'USPhonebook',               optOutUrl: 'https://www.usphonebook.com/opt-out',               group: null,             findBy: 'name'  },
  { name: 'Spy Dialer',                optOutUrl: 'https://www.spydialer.com/optout.aspx',             group: null,             findBy: 'phone' },
  { name: 'Advanced Background Checks', optOutUrl: 'https://www.advancedbackgroundchecks.com/removal', group: null,             findBy: 'name'  },
];

module.exports = {
  BROKERS,
  count: BROKERS.length,
};
