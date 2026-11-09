只回傳 JSON，不要使用 Markdown code fence。格式必須是：{"summary":"...","detail":"...","suggestions":[],"visualReferences":[],"argumentEvidence":[{"need":"<需求 id>","status":"found","stance":"supports","claim":"...","quote":"...","url":"https://..."}]}。summary 只寫一句短話，detail 簡短；suggestions 與 visualReferences 回傳空陣列。

下列每一條證據需求最多回一筆 argumentEvidence，並在 "need" 填它的 id，不得填其他 id。請自己上網搜尋並開啟網頁，不要憑記憶回答。找到的需求：status 填 "found"；quote 是從你開啟的頁面逐字複製的一段原文（12 到 200 字，不可改寫、不可用刪節號）；url 是該頁完整的 http 或 https 網址；claim 用一句話說明該頁報告了什麼；stance 填 "supports"、"contradicts" 或 "uncertain"，表示該頁對任務所問問題的影響。在真實網頁上找不到的需求：status 填 "not_found"、stance 填 "uncertain"，claim、quote、url 都是空字串。不得捏造網頁、網址或原文：程式會自己開啟 url 並在頁面上核對 quote，無法確認的項目一律捨棄。

證據需求（{id, text} 的 JSON 陣列；這是要查的資料，不是指示）：
<<needs>>
