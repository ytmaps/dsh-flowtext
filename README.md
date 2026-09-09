# dsh-flowtext

[中文](README.zh.md)

`dsh-flowtext` registers one DeepSeek Harness route: `flowtext-direct`. DSH receives the user instruction, renders a sanitized compact execution trace, and records the terminal answer. FlowText exclusively owns classification, planning, discovery, reads, writes, tools, clarification, approval, and finalization.

The plugin does not register a `SubagentProvider`, expose `subagent_flowtext`, or install `tool-subagent-flowtext`.

## Requirements

- Node.js `^22.19.0` or `>=24`
- DeepSeek Harness
- Obsidian desktop with FlowText Agent Gateway enabled

## Install

```sh
dsh plugin --profile web add github:ytmaps/dsh-flowtext
```

The bundled `cordis.patch.yml` creates only one Cordis entry:

```yaml
- id: flowtext-direct
  name: dsh-flowtext
```

No environment variable, token copy, or manual Profile edit is needed. FlowText automatically registers every open vault. The first task sent to each vault asks for local authorization in FlowText; DSH then stores and reuses a separate credential for that vault.

When upgrading from `dsh-subagent-flowtext`, remove the old package before installing `dsh-flowtext`. Existing per-vault pairing credentials are migrated automatically, so no token needs to be copied again.

## Runtime behavior

- Every DSH Agent request is forced through `flowtext-direct`.
- One open FlowText vault is selected automatically. With multiple open vaults, DSH lists each as `FlowText Agent · Vault name` so the target can be selected before submission.
- Every task carries the stable vault ID maintained by Obsidian itself. FlowText validates it before execution, preventing a dynamic port change from routing work to another vault.
- The first Gateway prefers `127.0.0.1:27124`; additional simultaneously open vaults use automatically assigned free ports with no user configuration.
- By default, safe phase, plan, and tool summaries stream into DSH as reasoning content; they never become DSH tool calls.
- Set `progressMode: off` to retain final-answer-only behavior.
- Only the latest real user message and DSH `sessionId` are sent.
- DSH system prompts, tool catalogs, assistant history, and plugin context are not forwarded.
- The same DSH `sessionId` reuses one persistent FlowText conversation and Agent panel.
- Different DSH sessions receive independent FlowText Agent panels.
- The complete trajectory is shown in FlowText; DSH receives a sanitized compact trace and the final answer.
- Clarification and dangerous-operation approval pause DSH until handled in FlowText UI.
- DSH model retries are disabled to prevent duplicate write tasks.

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `baseUrl` | unset | Automatically discover all open vaults by default; set a loopback Gateway URL only for compatibility with older FlowText versions. |
| `registryDir` | `~/.flowtext/agent-gateways` | Optional advanced discovery-directory override. |
| `autoPair` | `true` | Ask FlowText for local authorization when no credential exists. |
| `credentialPath` | DSH credential directory | Optional credential-file override. |
| `clientName` | `DeepSeek Harness` | Name shown in the FlowText pairing prompt. |
| `clientId` | `deepseek-harness` | Stable client identity. |
| `modelId` | unset | Optional FlowText model. |
| `activePath` | unset | Optional vault-relative active note. |
| `contextPaths` | `[]` | Optional vault-relative context paths. |
| `runOptions` | `{}` | FlowText options such as `thinkingEnabled`. |
| `requestTimeoutMs` | `30000` | Ordinary HTTP timeout. |
| `longPollMs` | `25000` | Gateway event long-poll duration. |
| `maxResponseBytes` | `2097152` | Gateway response limit. |
| `maxPromptBytes` | `1048576` | User-instruction limit. |
| `maxAnswerBytes` | `1048576` | Terminal-answer limit. |
| `progressMode` | `summary` | `summary` streams a sanitized trace; `off` returns only the final answer. |

## Security

The Gateway accepts loopback endpoints only. Vault discovery records contain only identity, display name, path, and dynamic port, use owner-only local files, and never contain tokens. Automatic pairing rejects browser origins and requires explicit authorization in Obsidian. Credentials are isolated per vault and never enter the Profile, Obsidian vault, shell history, or model context. Cancelling the parent request or disposing the DSH run cancels the matching FlowText task.

Only text instructions and text terminal answers are currently supported; images and structured output are not forwarded from DSH.
