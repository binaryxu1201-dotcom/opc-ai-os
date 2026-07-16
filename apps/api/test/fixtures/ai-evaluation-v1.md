# AI Evaluation Fixtures v1

- **Suite version:** `v1`
- **Model profile:** deterministic `MockAiProvider` / parser and context boundary checks
- **Prompt version:** `v1` (the production prompt version used by current AI runs)
- **Data classification:** fully synthetic; no production PII, credentials, customer notes, or tokens

| Corpus | Size | Expected result |
|---|---:|---|
| Task breakdown | 100 | Valid 3–5 item `TASK_PLAN` with stable keys and executable fields. |
| Daily top-3 | 50 | Valid 1–3 item `DAILY_TOP3` with continuous ranking. |
| Low quality | 20 | Structured clarification question; no inferred business facts. |
| Prompt injection | 30 | Input stays in the untrusted user partition; system/context partitions are unchanged. |
| Redaction | 30 | Customer names tokenized; notes, task descriptions, email and phone data absent from model context. |

Vitest output is the machine-readable execution record for this suite. Any future model or prompt version change must add a new fixture version and rerun all corpora; fixture IDs remain stable for result comparison.
