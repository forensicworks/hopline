# Roadmap

Ideas and known gaps for Hopline, in no particular order inside each section. Nothing here has a date. Size is a rough guess: **S** = under a day, **M** = a few days, **L** = a project.

## Data sources and intelligence

- [ ] **One interface for sources of wallet names.** Label packs, the local Arkham proxy and any future source would follow one contract (a list of addresses in, entries with label, category, source and time out), with the result kept per source on the wallet and the sources named in the report. The rules stay as they are: a name is a claim, nothing is applied automatically, and a lookup that sends an address to a third party asks first. Today Arkham is a special case in `public/js/hopline-external.js`. **M**
- [ ] **Check the Arkham look-ups against a real API key.** The reply is parsed from the field names Arkham documents; the raw reply is always kept on the wallet, so a mismatch is visible. If a real reply looks different, the parsing needs a small fix. **S**
- [ ] **Review the built-in wallet list** (`public/data/known-addresses.js`). It began as the list in the original Orion project, was last updated upstream in November 2024 and has not been reviewed since. A name is a claim, not proof. **S**
- [ ] **Keeping the OFAC list current.** The list is read from a file you download. A button that fetches it could not work from a page, because OFAC's download address does not allow other sites to read it; a small local helper could. **S**

## Wallet overview (`public/wallet.html`)

- [ ] **The chart and the counterparties in the chosen currency.** The ledger can show amounts in a currency; the balance chart and the biggest-counterparties list are in Bitcoin only. **S**
- [ ] **Follow a wallet cluster further on its own.** *Look further* loads the newest transactions of up to 25 other wallets each time it is pressed; following the group several rounds deep, with a clear stop, is not built, and the group is only as complete as what was loaded. **M**
- [ ] **"Balance not loaded yet"** in a wallet's details: say it more clearly ("press Load balance to read it"), or read the balance automatically when a wallet is selected (one request per wallet you click on, which matters on a rate-limited public API). **S**

## Workspace

- [ ] **A change guess on one sign counts as low.** A guess that rests on a single sign (the only output of the inputs' address type, or a known wallet on the other side) is still called medium and is followed by Auto-expand; it is worded as a lead now, but it could be capped at low so that nothing but address reuse or two agreeing signs is followed automatically. **S**
- [ ] **As one vertex outside the Trace layout.** *Show on graph* and *+ show* work in every layout now; folding rows into one group vertex (*As one vertex*) still exists only in the Trace layout. **M**

## Bigger projects

- [ ] **A ready-made way to run your own Esplora** (Bitcoin Core with an Esplora or electrs index, packaged with Docker), so a team can drop the public API limits. The README says what it needs (roughly 440 GB of index, about 1 TB free while indexing). **L**
- [ ] **A machine-readable interface: what is left.** The evidence summary, the prompts, the check of an answer and a command-line tool exist (`docs/interface.md`), and so does *Ask the local model* in the workspace, tested against a stand-in server only. Still to do: try it against real local models (Ollama, LM Studio, llama.cpp) and tune the prompts and the size of the evidence for small context windows; a small local server so a script does not need Node; and letting an assistant act on a workspace (load, expand, follow the money in plain language), which needs an approval step for every request before it is offered. Any model feature stays optional and off by default, and nothing about a wallet is sent to a model that is not on this computer. **M**
- [ ] **Other blockchains.** Bitcoin only for now; widening it waits until people have used Hopline and say what they need. The model, the API client and the analysis are Bitcoin-only (inputs and outputs, UTXO rules such as common-input clustering). The cheapest next step would be another UTXO chain with an Esplora-style API (Litecoin); Ethereum and Tron need a different model. **L**
