export const COFFEE_TOPICS: Array<{ id: string; zh: string; en: string }> = [
  { id: "ai-saved-time", zh: "公司導入 AI 省下的時間，應該由誰決定怎麼用？", en: "Who should decide how a company uses the time saved by AI?" },
  { id: "efficiency-or-security", zh: "一家公司應該先追求效率，還是員工的安全感？", en: "Should a company prioritize efficiency or employees’ sense of security?" },
  { id: "remote-work", zh: "遠距工作讓人更自由，還是更難下班？", en: "Does remote work make people freer, or make it harder to switch off?" },
  { id: "ideas-in-meetings", zh: "為什麼好點子常在會議裡消失？", en: "Why do good ideas often disappear in meetings?" },
  { id: "small-company-ai", zh: "小公司要如何採用 AI，又不增加員工負擔？", en: "How can a small company adopt AI without adding to employees’ workload?" },
  { id: "schools-and-ai", zh: "學校應該教學生使用 AI，還是先限制使用？", en: "Should schools teach students to use AI or restrict it first?" },
  { id: "school-lunch", zh: "免費營養午餐是否應該開放家長加價？", en: "Should parents be allowed to pay extra for school lunches that are otherwise free?" },
  { id: "children-freedom", zh: "孩子需要更多自由，還是更清楚的規則？", en: "Do children need more freedom or clearer rules?" },
  { id: "test-scores", zh: "考試成績能不能代表一個人真正學會了什麼？", en: "Can test scores show what someone has really learned?" },
  { id: "loving-work", zh: "工作一定要是自己熱愛的事嗎？", en: "Does your work have to be something you love?" },
  { id: "cities-and-forests", zh: "城市可以向森林學到什麼？", en: "What can cities learn from forests?" },
  { id: "neighborhood-help", zh: "一個社區怎樣才能讓陌生人願意互相幫忙？", en: "How can a neighborhood help strangers feel willing to help each other?" },
  { id: "convenience-and-skills", zh: "便利的生活，是否讓我們失去某些能力？", en: "Does a more convenient life make us lose some abilities?" },
  { id: "social-media", zh: "社群媒體讓人更有連結，還是更孤單？", en: "Does social media connect people or make them lonelier?" },
  { id: "recommendation-algorithms", zh: "推薦演算法是在幫我們選擇，還是在縮小選擇？", en: "Do recommendation algorithms help us choose or narrow our choices?" },
  { id: "human-creativity", zh: "當 AI 能創作，人的創作價值會在哪裡？", en: "When AI can create, where does the value of human creativity lie?" },
  { id: "fairness", zh: "公平是每個人得到一樣，還是得到自己需要的？", en: "Is fairness giving everyone the same thing or what each person needs?" },
  { id: "product-needs", zh: "一個產品應該滿足需求，還是挑戰使用者的習慣？", en: "Should a product meet users’ needs or challenge their habits?" },
  { id: "real-progress", zh: "我們如何分辨真正的進步與只是變得更忙？", en: "How can we tell real progress from simply getting busier?" },
  { id: "preserve-disagreement", zh: "什麼情況下，保留分歧比達成共識更有價值？", en: "When is preserving disagreement more valuable than reaching consensus?" }
];

export function coffeeTopicText(id: string, language: "zh-TW" | "en"): string | undefined {
  const topic = COFFEE_TOPICS.find(item => item.id === id);
  return topic?.[language === "en" ? "en" : "zh"];
}

export function pickCoffeeTopic(language: "zh-TW" | "en", previous = "", random: () => number = Math.random): string {
  const candidates = COFFEE_TOPICS.filter(item => item[language === "en" ? "en" : "zh"] !== previous);
  const pool = candidates.length ? candidates : COFFEE_TOPICS;
  return pool[Math.floor(random() * pool.length)][language === "en" ? "en" : "zh"];
}
