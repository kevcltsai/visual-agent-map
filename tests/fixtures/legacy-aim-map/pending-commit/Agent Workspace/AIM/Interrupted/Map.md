---
visual-agent-map: true
---

# Interrupted

This file stores the mind map structure. Full content lives in the topic notes. Choose Open as mind map from the file menu.

```agent-map
{
  "version": 1,
  "id": "7735482e-c2f1-4baf-9d1b-96d8f310bd76",
  "title": "Interrupted",
  "nodes": [
    {
      "id": "375aa24d-5036-4084-8a9b-1b296eb06b3f",
      "path": "Agent Workspace/AIM/Interrupted/Notes/Interrupted.md",
      "parentId": null,
      "x": 80,
      "y": 80,
      "collapsed": false,
      "aimKind": "topic"
    },
    {
      "id": "0967e27e-281f-467f-92a7-13a84c372d12",
      "path": "Agent Workspace/AIM/Interrupted/Notes/Question.md",
      "parentId": null,
      "x": 80,
      "y": 80,
      "collapsed": false
    },
    {
      "id": "c5d1ece1-68ca-41ac-a7d9-5a9b0fb93e8a",
      "path": "Agent Workspace/AIM/Interrupted/Notes/Pending result.md",
      "parentId": "0967e27e-281f-467f-92a7-13a84c372d12",
      "x": 440,
      "y": 260,
      "collapsed": false,
      "aimKind": "research"
    }
  ],
  "viewport": {
    "x": 40,
    "y": 40,
    "zoom": 1
  },
  "aim": {
    "version": 1,
    "creationId": "req-run",
    "contentLanguage": "en",
    "minimumAnswersBeforeConclusion": 3,
    "branches": [
      {
        "id": "b007cbc4-f713-4df2-af12-9d8515ee7867",
        "sourceQuestionNodeId": "0967e27e-281f-467f-92a7-13a84c372d12",
        "questionNodeId": "0967e27e-281f-467f-92a7-13a84c372d12",
        "parentBranchId": null,
        "answerSnapshot": {
          "selections": [],
          "freeText": "x"
        },
        "inputSnapshot": {
          "topic": "Interrupted",
          "conditions": {},
          "upstreamResults": []
        },
        "createdAt": "2026-11-10T13:29:10.035Z",
        "results": []
      }
    ],
    "runs": [
      {
        "id": "run-pending",
        "branchId": "b007cbc4-f713-4df2-af12-9d8515ee7867",
        "currentAttemptId": "attempt-1",
        "attempts": [
          {
            "id": "attempt-1",
            "inputSnapshotHash": "c302a7744047b069b75f5d1bc4cdd478f0c05d72aff0c36477aac3f516832edc",
            "status": "running"
          }
        ]
      }
    ],
    "resultDrafts": [
      {
        "id": "cdf8eef9-7054-4f30-8098-ef1a4b60fddb",
        "branchId": "b007cbc4-f713-4df2-af12-9d8515ee7867",
        "nodeId": "c5d1ece1-68ca-41ac-a7d9-5a9b0fb93e8a",
        "notePath": "Agent Workspace/AIM/Interrupted/Notes/Pending result.md",
        "title": "Pending result",
        "status": "ready",
        "runId": "run-pending",
        "attemptId": "attempt-1",
        "inputSnapshotHash": "c302a7744047b069b75f5d1bc4cdd478f0c05d72aff0c36477aac3f516832edc",
        "kind": "research"
      }
    ],
    "pendingCommits": []
  },
  "outputLanguage": "same-as-input"
}
```
