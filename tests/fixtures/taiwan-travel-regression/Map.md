---
visual-agent-map: true
sample-content-version: 2
---

# 範例：台灣旅行規劃

這是可由 Visual Agent Map 正常解析的官方範例 Topic。

```agent-map
{
  "version": 1,
  "id": "builtin-taiwan-travel",
  "title": "範例：台灣旅行規劃",
  "viewport": { "x": 40, "y": 60, "zoom": 0.62 },
  "nodes": [
    { "id": "explore", "path": "Notes/explore.md", "parentId": null, "x": 20, "y": 300, "collapsed": false },
    { "id": "constraints", "path": "Notes/constraints.md", "parentId": "explore", "x": 350, "y": 0, "collapsed": false },
    { "id": "budget", "path": "Notes/budget.md", "parentId": "constraints", "x": 690, "y": 0, "collapsed": false },
    { "id": "companions", "path": "Notes/companions.md", "parentId": "constraints", "x": 690, "y": 170, "collapsed": false },
    { "id": "transport", "path": "Notes/transport.md", "parentId": "explore", "x": 350, "y": 250, "collapsed": false },
    { "id": "rail-car", "path": "Notes/rail-car.md", "parentId": "transport", "x": 690, "y": 340, "collapsed": false },
    { "id": "food", "path": "Notes/food.md", "parentId": "explore", "x": 350, "y": 500, "collapsed": false },
    { "id": "nature", "path": "Notes/nature.md", "parentId": "explore", "x": 350, "y": 750, "collapsed": false },
    { "id": "weather", "path": "Notes/weather.md", "parentId": "nature", "x": 690, "y": 750, "collapsed": false },
    { "id": "lodging", "path": "Notes/lodging.md", "parentId": "explore", "x": 350, "y": 1000, "collapsed": false },
    { "id": "journey", "path": "Notes/journey.md", "parentId": null, "x": 1050, "y": 350, "collapsed": false },
    { "id": "next", "path": "Notes/next.md", "parentId": "journey", "x": 1390, "y": 500, "collapsed": false }
  ]
}
```
