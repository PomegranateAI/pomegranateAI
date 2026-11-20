---
name: pomegranate-review
description: Manually run the Pomegranate review pipeline against the most recent Claude interaction. Use this when the Stop hook is disabled or you want to re-review a specific output against the current graph. Produces a review file in .pomegranate/reviews/ with categorized findings and red/yellow/green flags, citing specific graph node ids.
allowed-tools:
  - Bash
  - Read
---

# pomegranate-review

Fallback manual invocation of the Pomegranate review hook. The Stop-hook version is the default — this skill exists for cases where the hook is disabled, where the user wants to re-review a specific output, or where the user is in an environment without the hook configured.

## When to run

- The user just produced a strategic deliverable (PRD, exec update, campaign, sales email, deck, blog post, positioning paragraph) and wants Pomegranate feedback before sharing it.
- The hook is disabled in this session (`.claude/settings.json` does not wire the Stop hook).
- The user wants to re-run review against the current graph (perhaps after a graph update).

## How to run

1. Determine the (prompt, response) pair to review:
   - Default: the most recent assistant message in this conversation.
   - If the user pastes a specific draft, use the paste as the response and a synthetic prompt like "draft" if no original is available.

2. Invoke the CLI:

   ```bash
   POMEGRANATE_DATA_DIR=.pomegranate \
     node /path/to/pomegranate/app/server/dist/phase0/bin/review-cli.js \
       --prompt-file <tmp-prompt.txt> \
       --response-file <tmp-response.txt> \
       --kind <prd|exec_update|campaign|sales_email|deck|other>
   ```

3. Read the resulting review file from `.pomegranate/reviews/`.

4. Present the findings to the user as a categorized list, sorted red → yellow → green. Cite the graph node id for each finding.

## Constraints

- Trust the integrity gate: any `<red>` finding without a real graph node citation is dropped by the pipeline. Do not re-introduce uncited reds in your summary.
- Do not invent additional findings. If the pipeline returned none in a category, say "no relevant graph nodes" for that category.
- Do not modify the graph from inside this skill — review is read-only against the graph.
