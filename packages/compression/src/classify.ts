import type { ClassifyResult } from './types.js';

// -- Head 1: Structural Pattern Detector (SPD) --

const CODE_FENCE_RE   = /^```[\w]*\n[\s\S]*?\n```/m;
const INDENT_CODE_RE  = /^( {4}|\t).+/m;
const LATEX_RE        = /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/;
const UNICODE_MATH_RE = /[∀∃∈∉⊆⊇∪∩∧∨¬→↔∑∏∫√∞≈≠≤≥±×÷]/;
const JSON_RE         = /^\s*[{[]/;
const YAML_RE         = /^[\w-]+:\s+.+/m;
const POETRY_RE       = /\n[A-Z][^.!?]*\n[A-Z][^.!?]*\n/;

function detectStructuralPatterns(text: string): {
  isT0: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (CODE_FENCE_RE.test(text))   reasons.push('code_fence');
  if (INDENT_CODE_RE.test(text))  reasons.push('indented_code');
  if (LATEX_RE.test(text))        reasons.push('latex_math');
  if (UNICODE_MATH_RE.test(text)) reasons.push('unicode_math');
  if (JSON_RE.test(text))         reasons.push('json_structure');
  if (YAML_RE.test(text))         reasons.push('yaml_structure');
  if (POETRY_RE.test(text))       reasons.push('verse_pattern');

  // Line-length variance — high variation signals structured content
  const lines = text.split('\n');
  const lengths = lines.map(l => l.length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / lengths.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  if (cv > 1.2 && lines.length > 3) reasons.push('high_line_length_variance');

  // Special character density
  const specialChars = (text.match(/[{}\[\]<>|\\;:@#$%^&*()=+`~]/g) ?? []).length;
  const ratio = specialChars / Math.max(text.length, 1);
  if (ratio > 0.15) reasons.push('high_special_char_ratio');

  return { isT0: reasons.length > 0, reasons };
}

// -- Head 5: Content-Type Detector (CTD) --

const FORCE_T0_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /https?:\/\/[^\s]+/,                                        label: 'url'                },
  { re: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,                              label: 'email'              },
  { re: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/,                       label: 'phone'              },
  { re: /\b(v\d+\.\d+(\.\d+)?|version\s+\d+)\b/i,                  label: 'version_number'     },
  { re: /[a-f0-9]{40,64}/i,                                         label: 'hash_or_sha'        },
  { re: /\b(?:SELECT\s+(?!(?:your|my|the|a|an|this|that|one)\s).+?\s+FROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/is, label: 'sql_query' },
  { re: /sk-[a-zA-Z0-9_-]{20,}/,                                     label: 'api_key'            },
  { re: /\bAKIA[A-Z0-9]{16}\b/,                                      label: 'api_key'            },
  { re: /\bgh[ps]_[a-zA-Z0-9]{36,}\b/,                               label: 'api_key'            },
  { re: /\bgithub_pat_[a-zA-Z0-9_]{36,}\b/,                          label: 'api_key'            },
  { re: /\b[sr]k_(live|test)_[a-zA-Z0-9]{24,}\b/,                    label: 'api_key'            },
  { re: /(?:\/[\w.-]+){2,}/,                                         label: 'file_path'          },
  { re: /\b\d+(\.\d+){1,5}\b/,                                      label: 'ip_or_semver'       },
  { re: /"[^"]{3,}"(?:\s*[,:])/,                                    label: 'quoted_key'         },
  { re: /\b(shall|must|may not|notwithstanding|whereas|hereby)\b/i, label: 'legal_term'         },
  { re: /["\u201c][^\u201d\u201c]{10,}["\u201d]|"[^"]{10,}"/,      label: 'direct_quote'       },
  { re: /\b\d+\.?\d*\s*(km|m|kg|s|°C|°F|Hz|MHz|GHz|ms|µs|ns|MB|GB|TB)\b/i, label: 'numeric_with_units' },
];

function detectContentTypes(text: string): {
  isT0: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  for (const { re, label } of FORCE_T0_PATTERNS) {
    if (re.test(text)) reasons.push(label);
  }
  return { isT0: reasons.length > 0, reasons };
}

// -- Tier heuristic for clean prose --

function inferProseTier(text: string): 'T2' | 'T3' {
  const words = text.split(/\s+/).length;
  if (words < 20) return 'T2';
  return 'T3';
}

// -- Main classifier entry point --

export function classifyMessage(content: string): ClassifyResult {
  const structural = detectStructuralPatterns(content);
  const contentTypes = detectContentTypes(content);

  const allReasons = [...structural.reasons, ...contentTypes.reasons];
  const isT0 = structural.isT0 || contentTypes.isT0;

  let decision: ClassifyResult['decision'];
  let confidence: number;

  if (isT0) {
    decision = 'T0';
    confidence = Math.min(0.95, 0.7 + allReasons.length * 0.05);
  } else {
    decision = inferProseTier(content);
    confidence = 0.65;
  }

  return { decision, confidence, reasons: allReasons };
}
