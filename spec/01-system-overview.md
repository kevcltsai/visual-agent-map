# System Overview

Visual Agent Map 是一個 Obsidian 桌面外掛：圖面結構由 `Map.md` 管理，議題內容由 Markdown 筆記管理，AI 任務透過本機已登入的 Codex / Claude 工具執行。

```mermaid
flowchart LR
  User([User])

  subgraph Plugin[Visual Agent Map Plugin]
    View[Map View UI]
    Repo[Repository]
    History[Undo / Redo]
  end

  subgraph Vault[Obsidian Vault]
    Map[Map.md\nstructure authority]
    Notes[Topic Notes\ncontent authority]
    Metadata[Reference Metadata\nderived data]
    Folders[Topics / Inbox / Archive]
  end

  subgraph AI[Local AI Providers]
    ACP[codex-acp\nprimary gpt-* provider]
    Codex[codex exec\nadvanced fallback]
    Claude[Claude Code CLI\nclaude:* models]
  end

  User --> View
  View --> Repo
  View --> History
  Repo <--> Map
  Repo <--> Notes
  Repo --> Metadata
  Repo <--> Folders
  View --> ACP
  ACP -. failure .-> Codex
  View --> Claude
```

## Responsibilities

- `Map.md`：唯一決定節點、座標、父子關係、收合與 viewport 的結構來源。
- Topic Notes：保存議題、目前理解、AI 規則、User Notes、Detail、Model 與 ownership。
- Repository：負責資料讀寫、遷移、reference metadata 重建與 topic lifecycle。
- AI providers：`gpt-*` 預設走 `codex-acp`；ACP 失敗時才使用 `codex exec` fallback；`claude:*` 走 Claude Code CLI。
