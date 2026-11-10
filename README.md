# frugal

A coding agent that gets the job done on the fewest tokens. It runs in your terminal like `claude` or `codex`, and in your browser with the same engine behind both. Every model call goes through a [Bifrost](https://github.com/maximhq/bifrost) gateway.

Built for the Global AI Hackathon, problem statement 01.

## Quick start

Requires Node 23.6 or newer and [Ollama](https://ollama.com).

```bash
ollama pull qwen2.5-coder:3b        # the local model (about 2 GB)
npm install && npm link             # puts the `frugal` command on your PATH
cp .env.example .env                # add your free API keys
frugal doctor                       # checks gateway, models, keys and policy
```

Then, inside any repository:

```bash
frugal                              # chat
frugal "fix the failing test"       # one task, then exit
frugal web                          # the same agent in your browser
frugal -c                           # continue the last session here
```

Bifrost starts by itself in the background the first time you run `frugal`. There is no build step: Node runs the TypeScript directly, and the agent has no runtime dependencies.

## The four guarantees

Each rule is enforced in code, at one choke point, and covered by tests in `test/`. None of them depends on what the prompt says.

| Requirement | How it is enforced | Where |
|---|---|---|
| **Reliability** | Bifrost fails over between providers. If every provider or the gateway itself is down, the session continues on the local model. The session is saved after every step, and you are told whenever the answering model changes. | `src/gateway/router.ts`, `src/session.ts` |
| **Budget** | Before every model call, its worst-case cost is checked against the user's ledger. A call that would cross the limit is never sent. You then choose: continue on the free local model, raise the limit, or stop with the session saved. Bifrost enforces the same limit on the user's virtual key. | `src/budget.ts` |
| **Code privacy** | A confidential repo gets a gateway key that can only reach Ollama, a candidate list containing only the local model, and no web search. A cloud answer would be discarded. The mark is stored outside the repo, so nothing in the repo can remove it. | `src/policy.ts`, `src/gateway/router.ts` |
| **Action approval** | Reads run freely. Every write, shell command and git operation stops at one gate and waits for a person. Tool arguments, file contents and model output are never consulted, so there is nothing for a prompt to override. | `src/approval.ts`, `src/tools.ts` |

Mark a repository confidential with `frugal repo mark`, or commit a `.frugal/policy.json` containing `{"confidential": true}`.

## How it saves tokens

- **Repo map instead of file dumps.** A compact index of files and top-level symbols with line numbers sits in the stable prompt prefix, so the model reads line ranges, not whole files.
- **No repeated reads.** Re-reading an unchanged range returns a one-line pointer to the copy already in context.
- **Small edits.** Changes are exact old-text to new-text replacements, not rewritten files.
- **Trimmed tool output.** Long command output keeps its head and tail.
- **Compaction without a model call.** Old tool results are replaced by one-line stubs when the conversation grows.
- **Cheap model first.** The stronger model is brought in only after the cheap one fails repeatedly.
- **Seven one-line tool descriptions**, and unavailable tools are not sent at all.
- **Loop cut-off.** A model repeating a failing step is stopped instead of burning tokens.

## Tests

```bash
npm test          # 32 tests: approvals, prompt injection, confidential routing, budget, failover
npm run typecheck
```

## Configuration

State lives in `~/.frugal` (override with `FRUGAL_HOME`): `config.json`, the spending ledger, saved sessions, the confidential-repo registry and Bifrost's data. Set a limit with `frugal budget set 0.50 day`. Model chains and prices are in `src/config.ts` and can be overridden in `config.json`.
