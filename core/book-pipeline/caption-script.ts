/**
 * Captions in a Traditional Chinese book (live v5: 「樱桃番茄」, 「果實long在藤上」): picture search results often come in Simplified
 * Chinese or carry an English word. The common Simplified-only characters are turned into their Traditional form; a lowercase English
 * word inside a Chinese caption is a reason for a person to look (a capitalised word is a name and stays).
 */

/** Simplified-only characters and their Traditional form, in pairs (none of the keys is itself a common Traditional character). */
const PAIRS =
  "樱櫻实實叶葉种種长長发發这這为為时時们們个個来來国國说說会會对對学學过過还還么麼样樣开開关關东東车車门門问問间間见見现現觉覺" +
  "认認让讓话話语語读讀写寫书書画畫图圖鸟鳥鱼魚马馬龙龍风風气氣电電业業农農产產头頭体體动動节節华華园園远遠运運进進边邊达達处處" +
  "务務广廣应應树樹桥橋楼樓机機杂雜条條极極欢歡线線红紅绿綠蓝藍黄黃经經结結给給统統绘繪织織细細级級纪紀约約网網罗羅联聯声聲听聽" +
  "买買卖賣贝貝贵貴费費资資质質转轉轮輪轻輕较較选選适適钟鐘铁鐵银銀钱錢镇鎮闻聞队隊阳陽阴陰际際陆陸难難雾霧静靜页頁顶頂项項顺順" +
  "须須领領题題颜顏类類显顯饭飯馆館鸡雞鲜鮮麦麥齐齊齿齒龟龜莲蓮苹蘋茎莖荚莢杨楊枣棗标標检檢汉漢汤湯湾灣灯燈热熱爱愛状狀猪豬环環" +
  "盘盤确確礼禮离離积積称稱笔筆简簡纸紙练練组組终終续續维維编編缘緣习習圣聖肤膚胜勝脑腦脚腳药藥获獲萝蘿营營虫蟲虾蝦蚁蟻补補装裝" +
  "观觀规規视視计計记記设設证證识識词詞译譯试試诗詩该該详詳谢謝财財货貨购購赛賽连連邮郵酱醬钢鋼锅鍋镜鏡闪閃闭閉阶階陈陳随隨隐隱" +
  "鸣鳴鸭鴨鹅鵝鹰鷹壳殼荫蔭绵綿蜡蠟";
const TRADITIONAL = new Map<string, string>();
for (let i = 0; i + 1 < PAIRS.length; i += 2) TRADITIONAL.set(PAIRS[i], PAIRS[i + 1]);

/** The text with the common Simplified-only characters in their Traditional form (anything else unchanged). */
export function toTraditional(text: string): string {
  return text.replace(/\p{Script=Han}/gu, char => TRADITIONAL.get(char) ?? char);
}

/** A lowercase English word (two letters or more) right next to a Chinese character, a space between at most. */
const LATIN_IN_HAN = /\p{Script=Han}[ \t]?[a-z]{2,}(?![A-Za-z])|(?<![A-Za-z])[a-z]{2,}[ \t]?\p{Script=Han}/u;
/** The caption mixes a lowercase English word into Chinese text (not a name: names are capitalised). */
export function hasLatinWord(caption: string): boolean {
  return LATIN_IN_HAN.test(caption);
}
