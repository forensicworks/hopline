# Security policy

Hopline runs in your browser and keeps your work on your machine. There is no server of ours that stores a case. That decides what counts as a vulnerability here, so please read "What is in scope" before you report.

## Supported versions

Only the latest commit on `master`, and the live site built from it, get fixes. There are no numbered releases yet.

## How to report a vulnerability

Please report it privately. Open the **Security** tab of this repository and choose **Report a vulnerability** (GitHub's private reporting). Please do not open a public pull request, discussion or issue about it before it is fixed.

A good report says:

- what you found and why it matters;
- where it is: the page or file, and the commit (or the date) you tried it on;
- how to reproduce it, with the smallest example you can: a transaction id, an address, or a workspace or label file built from public data;
- what someone could do with it.

Please do not send real case data, client names, API keys or private keys. Public chain data is enough to show a problem.

## What to expect

Hopline is maintained by one person, so this is best effort. I aim to reply within 7 days, to say whether I can reproduce the problem, and to fix real ones as soon as I can. I will credit you in the fix's commit message unless you ask me not to. There is no bounty.

Please give a reasonable time to fix a problem before you publish it. 90 days is a common standard; tell me if you need more or less.

## What is in scope

- **Script or HTML injection** from anything the app shows: names and notes in a label list or a workspace file, a reply from an explorer, a generated report. Everything is meant to be shown as text, and the report escapes what it writes.
- **A crafted file that hangs the page or uses far too much memory:** a workspace file, a label pack, or an OFAC list (XML or zip, see `public/js/hopline-ofac.js`, which refuses oversized files).
- **A report that still verifies after its evidence was changed** (see `tools/verify_report.py`).
- **The helper programs:** `tools/arkham_proxy.py` (loopback only, needs its token), `tools/serve.py` and `tools/hopline-cli.js` (which never opens a connection).
- **A page sending something it should not.** An address, transaction id, label or note must only go to the data source the visitor chose. On the live site, the visit counter may send page and feature names and nothing else (see `public/js/hopline-stats.js`).
- **The live site's configuration:** its headers and its hosted mode (`public/config.js`).

## What is not

- **Wrong or missing wallet names, and the analysis itself.** A name is somebody's claim, and clusters, change guesses and patterns are heuristics. Report those as ordinary bugs in a pull request, not as vulnerabilities.
- **Problems in services Hopline calls:** mempool.space, Blockstream.info, Cloudflare, GoatCounter, Arkham. Please report those to them.
- **Findings that need a malicious browser extension or an already compromised computer.**
- **Load or denial-of-service testing,** automated scans of the live site, and spam.
- **Missing security headers or "best practices" with no demonstrated effect.**

## Testing safely

Test on your own copy (`python tools/serve.py`) and with public data. Please do not run scanners or load against the live site.
