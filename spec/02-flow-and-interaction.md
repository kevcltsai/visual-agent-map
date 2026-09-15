# Flow and Interaction

本文件合併使用者流程與 AI 任務互動。重點是：圖面操作必須保護 Markdown 內容；AI 成功才寫回，失敗只改狀態。

## User Flow

```mermaid
flowchart TD
  Start([開啟 Obsidian]) --> OpenPlugin[開啟 Visual Agent Map]
  OpenPlugin --> Topic{已有研究主題?}
  Topic -- 否 --> CreateTopic[建立 Topic 資料夾與 Map.md]
  Topic -- 是 --> OpenMap[開啟既有 Map.md]

  CreateTopic --> Edit[新增或編輯議題]
  OpenMap --> Edit
  Edit --> Next{下一步}

  Next -- 一般任務 --> Confirm[確認任務與 AI 規則]
  Next -- 拆解議題 --> Decompose[產生子議題提案]
  Next -- 整合子議題 --> Synthesize[整合直屬子議題]
  Next -- 手動子議題 --> Child[建立子議題]

  Confirm --> RunAI[執行 AI]
  RunAI --> Result{成功?}
  Result -- 是 --> WriteDetail[更新目前理解與 Detail]
  Result -- 否 --> Error[狀態改為 error，不改內容]

  Decompose --> Suggestions[顯示查看建議入口]
  Suggestions --> CreateChildren[使用者確認後建立子議題]
  Synthesize --> WriteParent[直接更新母議題]

  Edit --> Integrate[多選建立整合議題]
  Integrate --> NewRoot[AI 建立新根議題並保存來源]

  Edit --> Organize{整理}
  Organize -- 移除 --> Unassigned[移至 Unassigned]
  Organize -- 封存 --> Archive[移至 Archive]
  Organize -- 跨主題 --> MoveTopic[移至其他 Topic]
```

## AI Interaction

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant View as Map View
  participant Repo as Repository
  participant Note as Topic Note
  participant ACP as codex-acp
  participant Codex as codex exec fallback
  participant Claude as Claude Code CLI

  User->>View: 執行一般任務 / Decompose / Synthesize
  View->>Repo: readNote + read task context
  Repo->>Note: 讀取 frontmatter 與 sections
  Note-->>Repo: note content
  Repo-->>View: current note + ancestors/sources/children
  View->>View: 組裝 TaskContext 與 JSON schema

  alt claude:* model
    View->>Claude: claude --model --json-schema
    Claude-->>View: structured JSON
  else gpt-* model
    View->>ACP: initialize/session/prompt
    alt ACP success
      ACP-->>View: structured JSON
    else ACP failure
      View->>Codex: codex exec --output-schema --sandbox read-only
      Codex-->>View: structured JSON
    end
  end

  alt success
    View->>Repo: update summary/detail/status
    Repo->>Note: write managed fields only
  else failure
    View->>Repo: update status=error
    Repo->>Note: preserve user content
  end
```

## Task Types

| Type | Context | Reasoning | Writeback |
|---|---|---:|---|
| General task | current note + ancestors + saved sources | low | 更新 summary / Detail；suggestions 只暫存 |
| Decompose | current note + light context | low | 不改內容；只產生待確認子議題提案 |
| Synthesize | parent + direct children | high | 直接更新母議題 summary / Detail |
