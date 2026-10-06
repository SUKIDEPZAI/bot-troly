// Nhận diện cách nói đời thường, viết tắt, tiếng lóng và câu mệnh lệnh.
// Mục tiêu là bổ sung ngữ cảnh cho router; không thay thế nguyên văn người dùng.

const SHORTCUTS = [
  [/\bko\b/gi, 'không'], [/\bkhong\b/gi, 'không'], [/\bk\b/gi, 'không'],
  [/\bkh\b/gi, 'không'], [/\bchả\b/gi, 'không'], [/\bchả\b/gi, 'không'],
  [/\bdc\b/gi, 'được'], [/\bđc\b/gi, 'được'], [/\bđk\b/gi, 'được không'],
  [/\bck\b/gi, 'chồng'], [/\bvk\b/gi, 'vợ'], [/\bny\b/gi, 'người yêu'],
  [/\bntn\b/gi, 'như thế nào'], [/\bntn\b/gi, 'như thế nào'], [/\bsaoz\b/gi, 'sao'],
  [/\bsao v\b/gi, 'sao vậy'], [/\bs v\b/gi, 'sao vậy'], [/\bsv\b/gi, 'sao vậy'],
  [/\bmn\b/gi, 'mọi người'], [/\bmk\b/gi, 'mình'], [/\bmik\b/gi, 'mình'],
 [/\bt\b/gi, 'tôi'], [/\btui\b/gi, 'tôi'],
  [/\btao\b/gi, 'tôi'], [/\bm\b/gi, 'bạn'], [/\bb\b/gi, 'bạn'],
  [/\bj\b/gi, 'gì'], [/\bg\b/gi, 'gì'], [/\bgi\b/gi, 'gì'],
  [/\br\b/gi, 'rồi'], [/\brồi\b/gi, 'rồi'], [/\bvs\b/gi, 'với'],
  [/\bv\b/gi, 'vậy'], [/\bcx\b/gi, 'cũng'], [/\bcxg\b/gi, 'cũng'],
  [/\bbt\b/gi, 'biết'], [/\bbiết r\b/gi, 'biết rồi'], [/\bhnay\b/gi, 'hôm nay'],
  [/\bhqua\b/gi, 'hôm qua'], [/\btrc\b/gi, 'trước'], [/\btrc đó\b/gi, 'trước đó'],
  [/\bib\b/gi, 'nhắn tin'], [/\brep\b/gi, 'trả lời'], [/\bcheck\b/gi, 'kiểm tra'],
  [/\bfix\b/gi, 'sửa'], [/\bcode\b/gi, 'lập trình'], [/\bweb\b/gi, 'website'],
  [/\bwed\b/gi, 'website'], [/\bapp\b/gi, 'ứng dụng'], [/\bacc\b/gi, 'tài khoản'],
  [/\bad\b/gi, 'quản trị viên'], [/\bmod\b/gi, 'điều hành viên'],
  [/\bpls\b/gi, 'làm ơn'], [/\bplz\b/gi, 'làm ơn'], [/\bthx\b/gi, 'cảm ơn'],
  [/\bthanks\b/gi, 'cảm ơn'], [/\bbro\b/gi, 'bạn'], [/\bbroo\b/gi, 'bạn'],
  [/\bae\b/gi, 'mọi người'], [/\boke\b/gi, 'được'], [/\bok\b/gi, 'được'],
  [/\bokay\b/gi, 'được'], [/\buh\b/gi, 'ừ'], [/\bừm\b/gi, 'ừ'],
  [/\bvl\b/gi, 'rất'], [/\bvcl\b/gi, 'rất'], [/\bvc\b/gi, 'rất'],
  [/\bđỉnh\b/gi, 'rất tốt'], [/\bcháy\b/gi, 'rất tốt'], [/\bxịn\b/gi, 'tốt'],
  [/\btoang\b/gi, 'hỏng'], [/\btoang r\b/gi, 'đã hỏng'], [/\bcr\b/gi, 'người yêu'],
  [/\bfl\b/gi, 'theo dõi'], [/\bunf\b/gi, 'bỏ theo dõi'], [/\blmao\b/gi, 'rất buồn cười'],
  [/\bwtf\b/gi, 'cái gì vậy'], [/\bwtf\b/gi, 'cái gì vậy'], [/\bbruh\b/gi, 'khó hiểu'],
  [/\bfr\b/gi, 'thật sự'], [/\birl\b/gi, 'ngoài đời'], [/\bngl\b/gi, 'thật lòng'],
  [/\bbtw\b/gi, 'nhân tiện'], [/\bfyi\b/gi, 'để biết thêm'], [/\basap\b/gi, 'càng sớm càng tốt']
];

const IMPERATIVE_PATTERNS = [
  /\b(làm|viết|tạo|code|sửa|fix|check|kiểm tra|giải|giải thích|phân tích|tìm|tra cứu|tóm tắt|dịch|review|cho|gửi|xuất|build|debug)\b/i,
  /\b(giúp|giúp mình|giúp tôi|làm giúp|làm hộ|viết hộ|sửa hộ|fix hộ|coi giúp|xem giúp|làm đi|code đi|tạo đi)\b/i,
  /\b(hãy|hãy làm|hãy viết|hãy tạo|hãy sửa|please|pls|plz)\b/i
];

const QUESTION_PATTERNS = [
  /\?/, /\b(tại sao|vì sao|sao|thế nào|như nào|như thế nào|là gì|bao nhiêu|khi nào|ở đâu|ai là)\b/i
];

const YOUTH_PATTERNS = [
  /\b(bro|broo|ae|mn|ib|rep|check|fix|vl|vcl|wtf|bruh|lmao|ngl|fr|bây giờ|rồi|oke|ok|xịn|cháy|toang|đỉnh)\b/i,
  /[!?]{2,}|[a-zA-ZÀ-ỹ]{2,}(.)\1{2,}/i,
  /(kk|haha|hahaha|=\)|=\(|:v|:\))/i
];

export function normalizeUserLanguage(text = '') {
  let normalized = ` ${text.trim()} `;
  let changes = 0;
  for (const [pattern, replacement] of SHORTCUTS) {
    const before = normalized;
    normalized = normalized.replace(pattern, replacement);
    if (normalized !== before) changes++;
  }
  normalized = normalized.replace(/\s+/g, ' ').trim();
  const hasImperative = IMPERATIVE_PATTERNS.some(r => r.test(text));
  const isQuestion = QUESTION_PATTERNS.some(r => r.test(text));
  const youth = YOUTH_PATTERNS.some(r => r.test(text));
  const compact = changes >= 1 || /\b(ko|kh|k|dc|đc|ntn|mn|mk|mik|ib|rep|vs|cx|bt|hnay|hqua|trc|pls|plz)\b/i.test(text);
  const style = youth ? 'young_slang' : compact ? 'abbreviated' : 'standard';
  const speechAct = hasImperative ? 'request' : isQuestion ? 'question' : 'statement';
  return { original: text, normalized, style, speechAct, shortcutChanges: changes, hasImperative, isQuestion, youth }; 
}
