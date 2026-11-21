// Fixture builders for the boxes OLDER versions wrote into chapter notes (a trial hint, a review box with two checkboxes). The program
// no longer writes them; the code that reads, clears, folds and answers them must still work on notes that carry them. `b` is a test
// bundle that exports `t` (the i18n lookup) and `setUiLanguage`.
module.exports = b => {
  const id = value => String(value).replace(/[^\w.-]/g, '');
  const link = l => (l ? `[[${l.path.replace(/\.md$/i, '')}|${l.title}]]` : '');
  const VERSION_LINE = '> %%vam-callout-version:1%%';
  return {
    reviewCallout(card, reasons, nextLink, fp, runId, hand) {
      const handSuffix = hand ? `:${id(hand.op)}:${id(hand.ifp)}${hand.queued ? ':q' : ''}` : '';
      return [
        `> [!vam-review] ${b.t('ui.book_note_review_title')}`,
        ...reasons.map(reason => `> ・${reason}`),
        `> - [ ] ${hand ? '保留我的版本' : '接受現在這樣，不用改'}`,
        `> - [${hand && hand.queued ? 'x' : ' '}] ${hand ? '用 AI 重寫這章（會蓋掉你的修改，改前先備份）' : '我改好了'}`,
        ...(hand && hand.status ? [`> ${hand.status}`] : []),
        ...(link(nextLink) ? [`> 下一章要看的：${link(nextLink)}`] : []),
        `> %%vam-review:${id(runId)}:${id(card.id)}:${id(fp)}${handSuffix}%%`,
        VERSION_LINE
      ].join('\n');
    },
    trialCallout(i, n, prevLink, nextLink, stopped, owner) {
      return [
        `> [!vam-trial] 試跑第 ${i}／${n} 章`,
        `> ${stopped ? '這本書已停止。先在心智圖工具列按「繼續」，再按「這樣可以，跑完全書」。' : '看完後回心智圖，按「這樣可以，跑完全書」。'}`,
        '> 想改哪一段：選取文字，右鍵「加備註」。',
        ...(link(prevLink) || link(nextLink)
          ? [`> ${[link(prevLink) && `上一章：${link(prevLink)}`, link(nextLink) && `下一章：${link(nextLink)}`].filter(Boolean).join('　')}`]
          : []),
        `> %%vam-trial:${id(owner.runId)}:${id(owner.nodeId)}%%`,
        VERSION_LINE
      ].join('\n');
    }
  };
};
