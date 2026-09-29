export type SpamScoreInput = {
  name: string;
  email?: string;
  location?: string;
  message: string;
};

export type SpamScore = {
  score: number;
  signals: string[];
  band: "low" | "medium" | "high";
};

const urlPattern = /(https?:\/\/|www\.)/gi;
const htmlPattern = /<\/?[a-z][^>]*>/i;

function punctuationRatio(value: string) {
  if (!value) return 0;
  const punctuation = value.replace(/[\p{L}\p{N}\s]/gu, "").length;
  return punctuation / value.length;
}

export function scoreInquiry(input: SpamScoreInput): SpamScore {
  let score = 0;
  const signals: string[] = [];
  const combined = [input.name, input.email, input.location, input.message].filter(Boolean).join(" ");
  const urls = combined.match(urlPattern)?.length ?? 0;

  if (urls >= 1) {
    score += urls >= 3 ? 4 : 2;
    signals.push("contains-url");
  }
  if (htmlPattern.test(combined)) {
    score += 3;
    signals.push("contains-html");
  }
  if (/(.)\1{7,}/u.test(input.message)) {
    score += 2;
    signals.push("repeated-characters");
  }
  if (punctuationRatio(input.message) > 0.45) {
    score += 2;
    signals.push("punctuation-heavy");
  }
  if (input.name.length > 0 && punctuationRatio(input.name) > 0.4) {
    score += 2;
    signals.push("invalid-name-shape");
  }

  return {
    score,
    signals,
    band: score >= 5 ? "high" : score >= 3 ? "medium" : "low",
  };
}
