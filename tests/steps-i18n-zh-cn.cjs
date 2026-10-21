// i18n/zh-CN: the Simplified Chinese dictionary draft (multilingual P2c) - key coverage and script purity.
// Placeholders and Markdown structure are enforced by scripts/check-i18n.mjs once zh-CN is registered (P3).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { zhCN } = load('i18n/zh-CN.ts');
const { zhTW } = load('i18n/zh-TW.ts');

// Characters that exist only in Traditional script (no Simplified use), so any hit is an unconverted Traditional string.
const TRADITIONAL_ONLY =
  '個這們與為發選擇檔設預開關點圖從會時對頁標題議筆記網資訊視儲載匯刪複製顯處輸語態狀' +
  '據際體後來說還動應機連結過進現實開業習學種經單項該導態證規劃範編譯請讀寫階層變樣區繫階' +
  '當傳備訊貼測試驗確認執轉換錄敘內續維組織構調討論並義層級閱覽幫預測歷戶蓋隨號碼頭';

test('zh-CN covers every zh-TW key and adds none', () => {
  const tw = Object.keys(zhTW);
  const cn = Object.keys(zhCN);
  assert.equal(cn.length, tw.length);
  assert.deepEqual(tw.filter(key => !(key in zhCN)), []);
  assert.deepEqual(cn.filter(key => !(key in zhTW)), []);
  assert.deepEqual(cn.filter(key => typeof zhCN[key] !== 'string' || !zhCN[key].trim()), []);
});

test('zh-CN values contain no Traditional-only characters or corner quotes', () => {
  const hits = [];
  for (const [key, value] of Object.entries(zhCN)) {
    const chars = [...new Set([...value].filter(ch => TRADITIONAL_ONLY.includes(ch)))];
    if (chars.length || /[「」『』]/.test(value)) hits.push(`${key}: ${chars.join('')}`);
  }
  assert.deepEqual(hits, []);
});

test('zh-CN glossary terms are applied', () => {
  const all = Object.values(zhCN).join('\n');
  for (const bad of ['心智圖', '議題', '母议题', '檔案', '資料夾', '設定', '預設', '搜尋', '連結', '介面', '使用者', '載入', '匯入', '視窗', '訊息', '儲存', '貼上', '外掛', '網路', '資訊', '選單', '範本', '復原', '來賓']) {
    assert.ok(!all.includes(bad), bad);
  }
  for (const term of ['心智图', '议题', '子议题', '父议题', '大纲', '洞见', '嘉宾', '观察者', '收敛', '文件夹', '设置', '搜索', '用户', '加载', '导入', '窗口', '消息', '保存', '粘贴', '插件', '网络', '菜单', '笔记', '模板', '撤销']) {
    assert.ok(all.includes(term), term);
  }
});
