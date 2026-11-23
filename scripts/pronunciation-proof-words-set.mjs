// The phrase set for the word-and-sound proof (scripts/pronunciation-proof-words.mjs,
// ld-ne0.16): per Azure locale, the macOS `say` voices that read it, and
// short phrases each with one word swapped for another (`swap`: the same
// audio assessed against the phrase with that word changed is a learner
// who said the wrong word, or a sound far enough off to be one) and, for
// scripts an English voice can't read, a romanisation (`roman`) for the
// accent sample. `pair`: the swap changes one sound only (perro → pero),
// and this is where it sits among the swapped word's sounds (0 first), as
// the reference word is spelt: a check of whether Azure's lowest phoneme
// score lands on it. Data only, no imports.

/** `core`: ten phrases, two native voices. `light`: six phrases, one. */
export const WORD_PROOF_SET = [
  {
    locale: "es-MX", name: "Spanish", tier: "core",
    native: ["Paulina", "Eddy (Spanish (Mexico))"], accent: "Samantha",
    items: [
      { text: "hola", swap: ["hola", "bola"] },
      { text: "gracias", swap: ["gracias", "grasas"] },
      { text: "buenos días", swap: ["días", "mesas"] },
      { text: "quiero un café", swap: ["café", "té"] },
      { text: "¿dónde está el baño?", swap: ["baño", "banco"] },
      { text: "me llamo Ana", swap: ["Ana", "Luis"] },
      { text: "perro", swap: ["perro", "pero"], pair: 2 },
      { text: "la cuenta, por favor", swap: ["cuenta", "puerta"] },
      { text: "tengo hambre", swap: ["hambre", "sueño"] },
      { text: "hasta mañana", swap: ["mañana", "luego"] },
    ],
  },
  {
    locale: "de-DE", name: "German", tier: "core",
    native: ["Anna", "Eddy (German (Germany))"], accent: "Samantha",
    items: [
      { text: "Hallo", swap: ["Hallo", "Halle"] },
      { text: "Danke schön", swap: ["schön", "sehr"] },
      { text: "Ich heiße Anna", swap: ["Anna", "Peter"] },
      { text: "Wo ist der Bahnhof?", swap: ["Bahnhof", "Flughafen"] },
      { text: "Ich möchte einen Kaffee", swap: ["Kaffee", "Tee"] },
      { text: "Guten Morgen", swap: ["Morgen", "Abend"] },
      { text: "schön", swap: ["schön", "schon"], pair: 1 },
      { text: "Die Rechnung, bitte", swap: ["Rechnung", "Speisekarte"] },
      { text: "Ich habe Hunger", swap: ["Hunger", "Durst"] },
      { text: "Bis morgen", swap: ["morgen", "bald"] },
    ],
  },
  {
    locale: "fr-FR", name: "French", tier: "core",
    native: ["Thomas", "Jacques"], accent: "Samantha",
    items: [
      { text: "bonjour", swap: ["bonjour", "bonsoir"] },
      { text: "merci beaucoup", swap: ["beaucoup", "bien"] },
      { text: "je m'appelle Marie", swap: ["Marie", "Paul"] },
      { text: "où sont les toilettes ?", swap: ["toilettes", "enfants"] },
      { text: "je voudrais un café", swap: ["café", "thé"] },
      { text: "tu", swap: ["tu", "tout"], pair: 1 },
      { text: "c'est très bon", swap: ["bon", "beau"] },
      { text: "j'ai faim", swap: ["faim", "soif"] },
      { text: "à demain", swap: ["demain", "bientôt"] },
      { text: "bonne nuit", swap: ["nuit", "journée"] },
    ],
  },
  {
    locale: "ja-JP", name: "Japanese", tier: "core",
    native: ["Kyoko", "Eddy (Japanese (Japan))"], accent: "Samantha",
    items: [
      { text: "こんにちは", swap: ["こんにちは", "こんばんは"], roman: "konnichiwa" },
      { text: "ありがとうございます", swap: ["ありがとう", "おはよう"], roman: "arigatou gozaimasu" },
      { text: "水をください", swap: ["水", "お茶"], roman: "mizu o kudasai" },
      { text: "駅はどこですか", swap: ["駅", "トイレ"], roman: "eki wa doko desu ka" },
      { text: "私は学生です", swap: ["学生", "先生"], roman: "watashi wa gakusei desu" },
      { text: "おいしい", swap: ["おいしい", "おおきい"], roman: "oishii" },
      { text: "いただきます", swap: ["いただきます", "ごちそうさま"], roman: "itadakimasu" },
      { text: "日本語を勉強しています", swap: ["日本語", "英語"], roman: "nihongo o benkyou shite imasu" },
      { text: "これはいくらですか", swap: ["これ", "あれ"], roman: "kore wa ikura desu ka" },
      { text: "また明日", swap: ["明日", "来週"], roman: "mata ashita" },
    ],
  },
  {
    locale: "it-IT", name: "Italian", tier: "core",
    native: ["Alice", "Eddy (Italian (Italy))"], accent: "Samantha",
    items: [
      { text: "ciao", swap: ["ciao", "miao"] },
      { text: "grazie mille", swap: ["mille", "tante"] },
      { text: "mi chiamo Luca", swap: ["Luca", "Marco"] },
      { text: "dov'è la stazione?", swap: ["stazione", "farmacia"] },
      { text: "vorrei un caffè", swap: ["caffè", "gelato"] },
      { text: "buongiorno", swap: ["buongiorno", "buonasera"] },
      { text: "il conto, per favore", swap: ["conto", "menù"] },
      { text: "ho fame", swap: ["fame", "sete"] },
      { text: "a domani", swap: ["domani", "presto"] },
      { text: "nonno", swap: ["nonno", "nono"], pair: 2 },
    ],
  },
  {
    locale: "ko-KR", name: "Korean", tier: "core",
    native: ["Yuna", "Eddy (Korean (South Korea))"], accent: "Samantha",
    items: [
      { text: "안녕하세요", swap: ["안녕하세요", "반갑습니다"], roman: "annyeonghaseyo" },
      { text: "감사합니다", swap: ["감사합니다", "죄송합니다"], roman: "gamsahamnida" },
      { text: "물 주세요", swap: ["물", "불"], roman: "mul juseyo", pair: 0 },
      { text: "화장실이 어디예요?", swap: ["화장실이", "은행이"], roman: "hwajangsiri eodiyeyo" },
      { text: "저는 학생이에요", swap: ["학생이에요", "선생님이에요"], roman: "jeoneun haksaengieyo" },
      { text: "맛있어요", swap: ["맛있어요", "멋있어요"], roman: "masisseoyo", pair: 1 },
      { text: "커피 한 잔 주세요", swap: ["커피", "녹차"], roman: "keopi han jan juseyo" },
      { text: "배고파요", swap: ["배고파요", "목말라요"], roman: "baegopayo" },
      { text: "내일 봐요", swap: ["내일", "다음에"], roman: "naeil bwayo" },
      { text: "얼마예요?", swap: ["얼마예요", "어디예요"], roman: "eolmayeyo" },
    ],
  },
  {
    locale: "pt-BR", name: "Portuguese", tier: "light",
    native: ["Luciana"], accent: "Samantha",
    items: [
      { text: "obrigado", swap: ["obrigado", "desculpe"] },
      { text: "bom dia", swap: ["dia", "noite"] },
      { text: "eu quero um café", swap: ["café", "suco"] },
      { text: "onde fica o banheiro?", swap: ["banheiro", "hotel"] },
      { text: "pão", swap: ["pão", "pau"], pair: 2 },
      { text: "até amanhã", swap: ["amanhã", "logo"] },
    ],
  },
  {
    locale: "ru-RU", name: "Russian", tier: "light",
    native: ["Milena"], accent: "Samantha",
    items: [
      { text: "привет", swap: ["привет", "пока"], roman: "privet" },
      { text: "спасибо", swap: ["спасибо", "пожалуйста"], roman: "spasibo" },
      { text: "я хочу чаю", swap: ["чаю", "кофе"], roman: "ya khochu chayu" },
      { text: "где вокзал?", swap: ["вокзал", "аптека"], roman: "gde vokzal" },
      { text: "меня зовут Анна", swap: ["Анна", "Иван"], roman: "menya zovut Anna" },
      { text: "до свидания", swap: ["свидания", "завтра"], roman: "do svidaniya" },
    ],
  },
  {
    locale: "nl-NL", name: "Dutch", tier: "light",
    native: ["Xander"], accent: "Samantha",
    items: [
      { text: "dank je wel", swap: ["wel", "niet"] },
      { text: "goedemorgen", swap: ["goedemorgen", "goedenavond"] },
      { text: "ik wil koffie", swap: ["koffie", "thee"] },
      { text: "waar is het station?", swap: ["station", "strand"] },
      { text: "huis", swap: ["huis", "hoes"], pair: 1 },
      { text: "tot morgen", swap: ["morgen", "straks"] },
    ],
  },
  {
    locale: "sv-SE", name: "Swedish", tier: "light",
    native: ["Alva"], accent: "Samantha",
    items: [
      { text: "tack så mycket", swap: ["mycket", "lite"] },
      { text: "god morgon", swap: ["morgon", "kväll"] },
      { text: "jag vill ha kaffe", swap: ["kaffe", "te"] },
      { text: "var är stationen?", swap: ["stationen", "banken"] },
      { text: "sju", swap: ["sju", "sjö"], pair: 1 },
      { text: "vi ses snart", swap: ["snart", "sen"] },
    ],
  },
  {
    locale: "hi-IN", name: "Hindi", tier: "light",
    native: ["Lekha"], accent: "Samantha",
    items: [
      { text: "नमस्ते", swap: ["नमस्ते", "धन्यवाद"], roman: "namaste" },
      { text: "धन्यवाद", swap: ["धन्यवाद", "शुक्रिया"], roman: "dhanyavaad" },
      { text: "मुझे पानी चाहिए", swap: ["पानी", "चाय"], roman: "mujhe paani chaahiye" },
      { text: "स्टेशन कहाँ है?", swap: ["स्टेशन", "बाज़ार"], roman: "station kahaan hai" },
      { text: "मेरा नाम राम है", swap: ["राम", "सीता"], roman: "mera naam Raam hai" },
      { text: "फिर मिलेंगे", swap: ["फिर", "कल"], roman: "phir milenge" },
    ],
  },
  {
    locale: "en-US", name: "English", tier: "light",
    // The accent sample for English: a Spanish voice reading it.
    native: ["Samantha"], accent: "Paulina",
    items: [
      { text: "thank you very much", swap: ["much", "well"] },
      { text: "where is the station?", swap: ["station", "hospital"] },
      { text: "I would like a coffee", swap: ["coffee", "sandwich"] },
      { text: "three", swap: ["three", "tree"], pair: 0 },
      { text: "the weather is nice today", swap: ["nice", "cold"] },
      { text: "see you tomorrow", swap: ["tomorrow", "later"] },
    ],
  },
  {
    locale: "ar-SA", name: "Arabic", tier: "light",
    native: ["Majed"], accent: "Samantha",
    items: [
      { text: "مرحبا", swap: ["مرحبا", "شكرا"], roman: "marhaban" },
      { text: "شكرا جزيلا", swap: ["جزيلا", "لك"], roman: "shukran jazeelan" },
      { text: "أريد قهوة", swap: ["قهوة", "ماء"], roman: "ureedu qahwa" },
      { text: "أين المحطة؟", swap: ["المحطة", "الفندق"], roman: "ayna al mahatta" },
      { text: "اسمي أحمد", swap: ["أحمد", "سارة"], roman: "ismi ahmad" },
      { text: "إلى اللقاء", swap: ["اللقاء", "الغد"], roman: "ila al liqaa" },
    ],
  },
];

/** The reference with the swapped word: the first occurrence of `from`. */
export function swappedText(item) {
  const [from, to] = item.swap;
  const at = item.text.indexOf(from);
  if (at < 0) throw new Error(`swap word not in ${item.text}`);
  return item.text.slice(0, at) + to + item.text.slice(at + from.length);
}
