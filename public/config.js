/*
 * Settings for a copy of Hopline that is published on a web site. This file ships empty: a local run, a file:// copy and any copy
 * you host yourself behave as the open edition (nothing is counted, Tor is offered, the session is kept in the browser by default).
 * tools/build_site.py writes the hosted values into the copy it builds; edit this file only to run the same settings by hand.
 *
 *   hosted  true: no Tor choice, and the session is not kept in the browser unless the visitor ticks "Keep this session in this browser"
 *   stats   { endpoint: 'https://CODE.goatcounter.com/count' }: count visits by page and feature name (see js/hopline-stats.js)
 */
window.HOPLINE_CONFIG = window.HOPLINE_CONFIG || {};
