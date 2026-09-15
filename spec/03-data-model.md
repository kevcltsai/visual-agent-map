# Data Model

`MapDocument` 決定圖面結構；`Note` 保存研究內容；reference metadata 是可重建的衍生資料。

```mermaid
erDiagram
  TOPIC {
    string id
    string title
    string root
    string mapPath
  }

  MAP_DOCUMENT {
    string id
    string title
    json viewport
  }

  MAP_NODE {
    string id
    string path
    string parentId
    number x
    number y
    boolean collapsed
  }

  NOTE {
    string title
    string summary
    string prompt
    string rules
    string userNotes
    string detail
    string model
    string status
    string mapId
    string topicId
    string topicState
  }

  REFERENCE_METADATA {
    string topic
    string map
    string parent
    string children
    string state
  }

  AI_TASK {
    string type
    string reasoning
    string task
    string context
    string model
  }

  AI_RESULT {
    string summary
    string detail
    json suggestions
    json visualReferences
  }

  TOPIC ||--|| MAP_DOCUMENT : owns
  TOPIC ||--o{ NOTE : contains
  MAP_DOCUMENT ||--o{ MAP_NODE : contains
  MAP_NODE ||--|| NOTE : references
  MAP_NODE ||--o| MAP_NODE : parent_of
  NOTE ||--o| REFERENCE_METADATA : derives
  NOTE ||--o{ AI_TASK : provides_context
  AI_TASK ||--|| AI_RESULT : produces
  AI_RESULT ||--|| NOTE : writes_back_to
```

## Core Fields

- `Status`: `idea`, `running`, `completed`, `error`
- `TopicState`: `active`, `unassigned`, `archived`, `inbox`
- `ModelSource`: `workspace`, `inherited`, `manual`
- `Settings`: 保存 workspace 路徑、provider 路徑、預設 model、model menu 與 hover preview scale。
- `Detail`: 保存固定六段知識頁；視覺參考寫入 Detail 內的「視覺參考」段落。
- `User Notes`: 使用者自由編輯區，AI 任務不得覆蓋。
