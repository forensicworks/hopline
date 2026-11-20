# Plan: timing and habits in the evidence summary

Status: **step 1 of the assistant plan is built** (this document describes what it does; the first try on a real local model is next). Steps 2 to 4 are at the end.

## Why

The facts that linked two wallets in a real comparison were not in the evidence a model gets: when two transactions were first seen (a gap of 58 seconds between two sweeps), the habits of whoever signed them (version, locktime, sequence, fee rate, shape), the hour of day each group moves money, and two unrelated transactions confirmed in the same block. A person found them with scripts over the JSON file. A model reading the evidence summary could not, and a local model is unreliable at doing that arithmetic itself.

The rule stays the one in `docs/interface.md`: **the facts come from code, never from a model.** Code computes the facts, puts them in the summary with their ids, and the model reads, ranks and words them; every id it cites is checked afterwards.

## What goes in: a `timing` block

One new top-level object in the evidence summary (`summary.timing`, `null` when there is nothing to say). It holds four parts, all derived from what is loaded. Nothing here is a finding, and the legend says so.

1. **`firstSeen.rows[]`**: for a transaction that a service (BlockCypher, Blockchain.com) was asked about: `txid`, `blockTime`, `firstSeen` (the earliest the services recorded), `sources[]`, `waitSeconds` (block time minus first seen), `relayRecorded` (yes or no: the peer itself only with the option below). A first-seen time is a **service's claim** about when its node first saw the transaction, not the time it was broadcast.
2. **`pairs[]`**: transactions of **different signing groups** that sit close in time: in the same block with no wallet in common (the common-block rule of `hopline-sameblock.js`), or first seen within 120 seconds of each other. Each has `txids`, `why`, `gapSeconds`, `height`, and the groups, plus `expectedByChance` for the whole canvas.
3. **`habits.groups[]`**: for each signing group (the owner the analysis gives the inputs: a cluster, or one wallet) with at least three signed transactions: how many, first and last time, and counts by `version`, `locktime` kind, `sequence`, input and output shape, script types, round outputs, the share of whole-number fee rates, the **switch points** (a feature that changes from one value to another, with the dates on either side), and `hoursUtc` (24 counts of when the group's transactions happened, first-seen time where known, else block time).
4. **`habits.compare[]`**: for the most alike pairs of groups: the features that agree and the ones that differ, each marked `common` when ordinary wallets share it (`AN.fingerprint` already says which keys are common), so a model does not weigh a default setting like a rare one.

## What it is built from

| Part | Source in the workspace | Module |
|---|---|---|
| first seen, sources | `node.ext.<service>` (kept only after the person ticked the box and asked) | `hopline-external.js` (`firstSeen`, `timeRows`) |
| signing groups | the clusters of the analysis, else the single wallet | `hopline-analysis.js` |
| habits | `version`, `locktime`, `seqs`, `bip69`, `fee`, `vsize`, `nIn`, `nOut`, output types | `AN.fingerprint` and the transaction itself |
| common block | loaded, confirmed, complete transactions | `hopline-sameblock.js` |

A new pure module, `public/js/hopline-timing.js` (`build(graph, analysis, opts)`), does the work. The page and `tools/hopline-cli.js` both call it and pass the result to `summary()`, as they do for the trace (`opts.timing`); `summary()` cleans and caps it.

## Privacy and consent

- First-seen data exists only where the person asked a service, behind a box they ticked. Building the block asks nobody anything.
- **The relay peer is left out by default** (an IP address is sensitive; the report leaves it out the same way). `opts.peers: true` includes it, as `IP:port`, marked as untrusted text. The model only ever hears from a service on this machine (`localEndpoint`), but the summary can also be copied or written to a file.
- Labels and tags used to name a group are cleaned like every other text from outside.

## Size

The summary grows, so every list has a cap and says when it was cut (the `limits` list the summary already has): 80 first-seen rows, 40 pairs, 12 groups, 20 comparisons. The prompt's size estimate and the warning before a send count the new block, and `maxRows` trimming covers it, so a small context fails loudly (as today) and not silently.

## The model's side

- The legend explains each part (a first-seen time is a claim and a lag; a habit is a setting, many wallets share the common ones; a coincidence is not a link).
- The notes add: weigh by **rarity**, say how strong a link is and what would change it, never name an operator, and treat `expectedByChance` as a yardstick.
- Every txid in the block is in the checked set, so a citation of one is accepted and a made-up one is not.
- **The habits of a linking pair are in the pair** (`habitsOfTheTwoGroups`, worked out by code from the pair's own two groups): the same, differ, mixed and not-known lists, the changes both made the same way, or `comparable: false` and which group has too few signed transactions. Added after a test in which a model, asked whether two starting points were one operator, used the comparison of two groups of one starting point as support (the only habit comparison it had) and called a mixed feature a difference. The rule also says that no wallet in common says nothing about who owns the wallets.
- **Each shared habit change names the group each window belongs to** (`sharedHabitChanges`: "version v1 to v2: <group> between ... and ..., <group> between ... and ...; the windows overlap from ..."), because a model swapped two windows that were only called "one group" and "the other". The rule also says that a tag is the investigator's own mark (two wallets with the same tag are not thereby linked), that only relations the evidence lists may be described (a model once said two starting points "converged on the same group"), and that a habit not marked `common` is not for that reason unusual: `common` marks the default combination of version, locktime and sequence as a whole.
- **`sameBlock.expected` is said to cover all the loaded blocks together.** In a test a model read 0.348 (the pairs a random spread would give over every loaded block) as the figure for one block. The legend, the rule and an `expectedIs` note beside the number now say it is one number for the whole set, to compare with `sameBlock.pairs`, which counts the pairs in all of them. The summary keeps its own field names.
- **The signing groups named in the timing block are in the evidence set** (the groups of a pair, of the habits and of a link, and the starting points of a link; the name of a cluster is not an address), so *Check ids* says "in the evidence" for a group address the model copied from it.

## Tests

- **Node:** made-up graphs for each part: first-seen rows (one service, two services, none), the 120 second pair and its edges, the common-block pair, groups of two and of three transactions, a switch point, a feature that is common, the caps and their `limits` text, the peer left out and put in, citations of the new ids, and the prompt carrying the block.
- **Browser:** the Assistant's preview carries the block (with first-seen data loaded through the existing mocks), and a stand-in model server answers a question about two sweeps from it.
- **Deliberate breakages**, each caught by a test, as for every feature.

## Not in step 1

The model still only reads. It does not load, select or write anything on the canvas.

## The steps after it

2. **Compare two groups**, a deterministic function and a panel: pairs between two chosen groups, first-seen gaps (asked with the ticked services), whether the shapes match, and the chance expectation for those two groups. It is in `ROADMAP.md`.
3. **Propose, don't act:** the model returns actions from a fixed list (load a transaction, follow forward or backward, select, ring, compare these groups, add a note marked as an assistant suggestion); the person sees a checklist and presses Apply. Each is a normal canvas action in the activity log with Undo. It never starts a lookup that sends an id to a third party.
4. **Bounded multi-step runs** with a request budget and an approval per batch (the existing roadmap item).

## Defaults I chose, to change if they are wrong

- Relay peers out; 120 seconds for a close pair; three signed transactions for a group; the caps above.
- The signing group of a transaction is the owner of its inputs; a transaction that looks like a CoinJoin has none.
