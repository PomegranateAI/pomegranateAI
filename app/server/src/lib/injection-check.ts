// Prompt-injection check at ingest.
//
// Flags text that addresses an AI rather than informing a reader — "ignore
// previous instructions", fake system/assistant turns, requests to reveal the
// prompt, to call tools, or to hide actions from the user. A flagged document
// is still stored, but capture is held for a person to approve
// (pending_routes, reason prefixed "Possible prompt injection"), so nothing it
// says reaches the vault or an agent's context unreviewed.
//
// Deterministic and cheap (no LLM: an LLM judge can itself be injected). The
// patterns favour precision; the test set (injection-check.test.ts) pins both
// the attacks it must catch and ordinary school documents it must not.
// Disable with INGEST_INJECTION_CHECK=0.

export interface InjectionMatch {
  rule: string;
  /** Up to 120 characters around the match — shown to the reviewer. */
  excerpt: string;
}

const RULES: Array<{ rule: string; re: RegExp }> = [
  {
    rule: 'override_instructions',
    re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|preceding|all|any|your|the|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directives|guidelines|messages)\b/i,
  },
  { rule: 'new_instructions', re: /\b(new|updated|real|actual|secret|hidden)\s+(system\s+)?instructions?\s*[:：]/i },
  { rule: 'role_reassignment', re: /\b(from now on|starting now|henceforth)\b[^.\n]{0,20}\byou\s+(are|will|must|shall)\b/i },
  { rule: 'role_reassignment', re: /\byou are (now|no longer)\s+(an?\s+)?(ai|assistant|model|chatbot|agent|dan|jailbroken|unrestricted)\b/i },
  { rule: 'fake_turn', re: /<\/?\s*(system|assistant|user|im_start|im_end|tool_call|function_call)\s*>|\[\/?INST\]|<<\/?SYS>>|^\s*#{2,}\s*(system|assistant)\s*(prompt|message)?\s*:?\s*$/im },
  { rule: 'fake_turn', re: /^\s*(system|assistant)\s*(prompt|message)?\s*:\s*\S/im },
  { rule: 'prompt_exfiltration', re: /\b(reveal|print|show|repeat|output|leak|tell me)\b[^.\n]{0,30}\b(your|the)\s+(system\s+|initial\s+|hidden\s+)?(prompt|instructions|configuration|api key|secrets?)\b/i },
  {
    rule: 'tool_invocation',
    re: /\b(call|use|invoke|run|execute|trigger)\b[^.\n]{0,25}\b(ingest_document|update_node|update_attribute|upsert_rule|delete_rule|approve_route|choose_route|reject_route|create_subfolder|set_default_folder|request_folder_access)\b/i,
  },
  { rule: 'concealment', re: /\b(do not|don't|never)\s+(tell|inform|mention|reveal|alert|notify)\b[^.\n]{0,25}\b(the\s+)?(user|human|teacher|admin|operator)\b/i },
  { rule: 'concealment', re: /\bwithout\s+(telling|informing|alerting|notifying)\s+(the\s+)?(user|human|admin|operator)\b/i },
  { rule: 'addressed_to_ai', re: /\b(attention|note|instruction|message)\s+(to|for)\s+(the\s+)?(ai|llm|assistant|language model|chatbot|agent)s?\b\s*[:：,]/i },
  { rule: 'addressed_to_ai', re: /\b(if you are|as)\s+an?\s+(ai|llm|large language model|language model)\b[^.\n]{0,40}\b(you must|you should|ignore|do not|respond|reply|output)\b/i },
  { rule: 'exfiltration', re: /\b(send|forward|email|post|upload|exfiltrate)\b[^.\n]{0,40}\b(all|every|the entire|the whole)\b[^.\n]{0,30}\b(documents?|notes|vault|knowledge base|data|context)\b[^.\n]{0,30}\b(to|at)\s+\S+/i },
];

/** Every injection pattern found in `text` (at most one match per rule). */
export function detectInjection(text: string): InjectionMatch[] {
  const out: InjectionMatch[] = [];
  const seen = new Set<string>();
  for (const { rule, re } of RULES) {
    if (seen.has(rule)) continue;
    const m = re.exec(text);
    if (!m) continue;
    seen.add(rule);
    const start = Math.max(0, m.index - 30);
    const excerpt = text.slice(start, m.index + m[0].length + 30).replace(/\s+/g, ' ').trim().slice(0, 120);
    out.push({ rule, excerpt });
  }
  return out;
}

export function injectionCheckEnabled(): boolean {
  return process.env.INGEST_INJECTION_CHECK !== '0';
}
