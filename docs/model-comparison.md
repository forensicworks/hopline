# Comparing models

The assistant's prompts, rules and checks were tuned against one model. `tools/compare-models.js` asks several models **the same questions about the same workspace**, with the prompt the workspace itself makes, and scores every answer by code. It is how to find out which of the rules and checks help every model and which only help one.

It runs on the computer that has the model server (Ollama, LM Studio, the llama.cpp server). Only a model on this computer is accepted, as in the workspace: `localhost`, `127.0.0.1` or `::1`. Nothing about a wallet is sent to another machine. Node.js 18 or newer, and no package.

## Running it

```sh
node tools/compare-models.js --list                                  # the models the server has
node tools/compare-models.js workspace.json --models gpt-oss:20b,llama3.1:8b,qwen2.5:14b
node tools/compare-models.js workspace.json --models gpt-oss:20b,llama3.1:8b --runs 3 --actions --questions questions.txt --expect expect.json
```

`workspace.json` is a file made by **Export > JSON** in the workspace. Before the first run raise the context window of the server (in Ollama, `OLLAMA_CONTEXT_LENGTH=32768`): a prompt is 13,000 to 17,000 tokens with a real case loaded, and the answer needs room too. A model that cannot read it all answers from the first part only, or is cut off (the summary says how large the largest prompt is, and counts the answers that were cut off).

The models are asked one after the other, each question `--runs` times (the default is 1). A 20B model can take a minute or several per answer, and the first answer of each model also loads it, so a run of 3 models, 6 questions and 3 runs each is an evening, not a coffee. Try `--runs 1` and the built-in questions first. A model that is not there, or that fails, is counted as failed runs and the others go on.

| Option | Meaning |
|---|---|
| `--models a,b,c` | the models to ask, as `--list` shows them |
| `--runs N` | ask each model each question N times; a model varies from run to run, so one run is a sample and three or more says something |
| `--questions FILE` | one question per line; a line `task:next` asks for the list of next steps; `#` starts a comment. Without it: three questions that name no id (which findings first, what would make the strongest finding wrong, where the open ends lead), and the next-steps question with `--actions` |
| `--expect FILE` | phrases to look for (below) |
| `--actions` | let the models propose actions, as the workspace setting *Let the model propose actions* does, and score the block they return |
| `--out FOLDER` | where the answers, `results.json` and `summary.md` go; by default a new folder next to the workspace file |
| `--endpoint URL` | the server; default `http://127.0.0.1:11434/v1` |
| `--stream` | ask for the answer as it is written. Node gives up on a server that sends nothing for 5 minutes, which a slow answer to a big prompt can do (the failed run then says `UND_ERR_HEADERS_TIMEOUT`); with `--stream` the words keep arriving. The answers and the scores are the same |
| `--retries N`, `--retry-wait S` | ask again, up to N times (0 to 5, default 0), after S seconds (default 5), when the connection to the server fails (refused or dropped, for example while it loads a model). Not after a timeout or an error the server sent |
| `--max-rows N`, `--timeout-min N`, `--temperature X` | pattern rows in the prompt (60, as in the workspace), minutes to wait for one answer (10), sampling temperature (the workspace's, 0.2) |

## What is scored

Every answer goes through the checks the workspace has, by running `tools/hopline-cli.js`:

- **Invented ids.** A transaction id or an address in the answer that is not in the workspace: made up, or copied wrongly (a 20B model garbles long addresses). The most serious slip in a forensic answer. **Copy slips** are the ones one or two characters away from a real id; **cited nothing** is an answer with no id to check, which is unsupported.
- **Cut off.** The model ran out of room and stopped mid-answer.
- **Actions** (with `--actions`, and for a `task:next` question): whether the answer holds a block of actions Hopline can read, how many of the proposals survive the checks (a made-up id, an unknown action, a vertex that is not loaded are dropped), and how many are dropped.
- **Phrases**, from `--expect`, a JSON file. Keys are question numbers (the first question is `1`); `defaults` applies to every question. Each entry lists regular expressions (case does not matter) that the answer **must contain** or **must not contain**:

```json
{
  "defaults": { "mustNotContain": ["distinct owners", "converged"] },
  "5": { "mustContain": ["57\\.282"] }
}
```

A phrase check is crude on purpose: it is for a number you know, or a claim the evidence cannot support. Whatever a model writes between `<think>` tags is not scored, only what follows.

What it does **not** score is whether the reasoning is good. It narrows a long answer down to the ones worth reading, and the answers are all in the output folder.

## What it writes

- `summary.md`: a table with a row per model (failed runs, cut off, mean seconds, runs with an invented id, phrases held, actions accepted and dropped), a **Failed runs** list (which model, how many, after how many seconds, and why: a model that is not pulled says `model 'x' not found`, a refused connection says so with its code), then a table per question. It is also printed.
- `results.json`: every run with its numbers.
- `<model>/q<N>-run<K>.txt`: every answer, as the model wrote it.

It prints counts only, never an id. The answers may hold your real ids, so keep the output folder out of any repository.

## Reading the result

- Compare models on the **same workspace, questions and settings**, and run each at least three times before trusting a difference.
- A rule that helps one model and not another is a candidate to be shortened or dropped; a check that catches a slip in every model is working. Use two or three different workspaces before deciding anything: a model that wins on one case can lose on another.
- The table says who invented an id or ran out of room. It does not say who understood the question. Read the answers of the ones that look good.
