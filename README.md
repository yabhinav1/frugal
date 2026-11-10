# frugal

A coding agent that gets the job done on the fewest tokens. It runs in your terminal like `claude` or `codex`, and in your browser, with the same engine behind both. Every model call goes through a [Bifrost](https://github.com/maximhq/bifrost) gateway, and web search uses [Tavily](https://tavily.com).

Built for the Global AI Hackathon, problem statement 01.

## Install

Requires Node 20 or newer.

```bash
npm install -g github:yabhinav1/frugal
frugal init        # creates ~/.frugal/.env and tells you what to put in it
frugal doctor      # checks gateway, models, keys and policy
```

One free key from Google AI Studio or Groq is enough. [Ollama](https://ollama.com) is optional: it is needed for confidential repositories and as the offline fallback (`ollama pull qwen2.5-coder:3b`).

Then, inside any repository:

```bash
frugal                          # chat
frugal "fix the failing test"   # one task, then exit
frugal web                      # the same agent in your browser
frugal -c                       # continue the last session here
```

Bifrost starts by itself in the background the first time, and restarts by itself when your keys, users or budgets change. The agent has no runtime dependencies.

## The four guarantees

Each rule is enforced in code at a single choke point. None of them depends on what the prompt says, and each is attacked by `frugal redteam`.

| Requirement | How it is enforced | Where |
|---|---|---|
| **Reliability** | Bifrost fails over between providers and between pooled keys. If every provider or the gateway itself is down, the session continues on the local model. The session is saved after every step, and you are told whenever the answering model changes. | `src/gateway/router.ts`, `src/session.ts` |
| **Budget** | Before every model call, its worst-case cost is checked against the user's ledger; a call that would cross the limit is never sent. You then choose: continue on the free local model, raise the limit, or stop with the session saved. Each user also has their own Bifrost virtual key carrying the same budget. | `src/budget.ts`, `src/gateway/bifrost.ts` |
| **Code privacy** | A confidential repo gets a gateway key that can only reach Ollama, a candidate list containing only the local model, and no web search. A cloud answer would be discarded. The mark is stored outside the repo, so nothing in the repo can remove it. | `src/policy.ts`, `src/gateway/router.ts` |
| **Action approval** | Reads run freely. Every write, shell command and git operation stops at one gate and waits for a person. Tool arguments, file contents and model output are never consulted, so there is nothing for a prompt to override. | `src/approval.ts`, `src/tools.ts` |

Mark a repository confidential with `frugal repo mark`, or commit a `.frugal/policy.json` containing `{"confidential": true}`.

### Red team

```bash
frugal redteam
```

Runs 16 attacks against the real enforcement code, with the model played by a script that does what a hijacked model would do. No tokens are spent and the result is the same on every run. It covers injected "approvals are disabled" instructions, approval flags smuggled into tool arguments, an upload appended to a pre-approved command, a hidden `git push`, a planted git hook, path escapes, credential reads, cloud routing from a confidential repo, a deleted confidentiality marker, code pasted into web search, a gateway moved to another machine, spending past the limit, edits to the agent's own ledger, and cross-site requests to the web UI.

## How it saves tokens

Almost all of the cost of an agent session is the conversation being resent on every model call. So the savers do two things: cut the number of calls, and keep stale or useless text out of each one.

- **Files named in the task are attached up front.** Mention a failing test and the agent reads it, and the source files it imports, before the first model call. Reads are free under the approval rules, so this needs no prompt.
- **Repo map instead of file dumps.** A compact index of files and top-level symbols with line numbers sits in the stable prompt prefix, so the model goes to line ranges rather than reading files to find out what is in them.
- **No repeated reads.** Re-reading an unchanged range returns a one-line pointer to the copy already in context.
- **Small edits.** Changes are exact old-text to new-text replacements, not rewritten files.
- **Trimmed command output.** Test output is cut to the failures: passing lines, runner banners, duplicated reports and stack frames inside Node or dependencies are dropped.
- **Stale output dropped.** When a command is run again, the output of its earlier runs is replaced by a one-line stub.
- **Batching.** The model is told that every reply resends the conversation, and to put independent tool calls in one reply.
- **Compaction without a model call.** Old tool results are replaced by one-line stubs when the conversation grows.
- **Cheap model first.** The stronger model is brought in only after the cheap one fails repeatedly.
- **Seven one-line tool descriptions**, and unavailable tools are not sent at all.
- **Loop cut-off.** A model repeating a failing step is stopped instead of burning tokens.

Correctness is guarded separately: a model that says it is done after changing code, with no passing command since, is sent back to run the tests.

## Benchmark

```bash
npm run bench -- --runs 3                    # shop suite: 12 tasks in a small project
npm run bench -- --suite self                # self suite: 8 regressions planted in this agent's own source
npm run bench -- --variants frugal,no-attach # ablation: one saver switched off
npm run bench -- --verify                    # no model: confirm every task starts from failing tests
```

Both agents run the same tasks, on the same model, through the same gateway. "naive" is the same loop with the token-saving behaviour switched off: no repo map, whole-file reads and writes, no re-read pointers, untrimmed output. A task counts as solved only if the project's whole test suite passes afterwards, with the test files restored to their original content first, so editing a test to make it pass does not count. The model under test is pinned: when its provider is overloaded the run waits rather than switching models.

<!-- RESULTS -->

## Tests

```bash
npm test          # approvals, prompt injection, confidential routing, budget, failover, streaming, token savers
npm run typecheck
```

## Configuration

State lives in `~/.frugal` (override with `FRUGAL_HOME`): keys in `.env`, `config.json`, the spending ledger, saved sessions, the confidential-repo registry and Bifrost's data.

- `frugal budget set 0.50 day` sets the default limit; add `--user name` for one person's limit.
- Several keys for one provider are pooled: name them `GEMINI_API_KEY`, `GEMINI_API_KEY_2`, and so on. `frugal keys` tests each one and keeps dead keys out of the pool.
- Model chains and list prices are in `src/config.ts` and can be overridden in `config.json`. Spend is metered at list price even on free tiers, so the budget means something.

## Limits

- The local model is a 3B model sized for a 4 GB GPU. It handles small single-file fixes and is there for privacy and outages, not as a peer of the cloud models.
- Cost figures use a price table in this repo, not provider invoices.
- The verification guard treats any passing command as verification; it does not know which command is the test suite.
