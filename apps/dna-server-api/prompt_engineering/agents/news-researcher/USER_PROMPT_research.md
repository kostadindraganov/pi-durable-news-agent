# Purpose

Research these items for sweep {{sweep_id}}.

## Variables

ITEMS: {{items}}
FOCUS: {{focus}}

## Workflow

1. For each item in ITEMS, call read_item.
2. Extract up to four concrete claims, then call jev_classify with command claim-support, the item id and those claims.
3. When an item has possible overlap, compare the concrete event, version, date, and new facts with the listed coverage. Report what is the same, what is new, or why the link is uncertain.
4. Call report_findings for each assigned item with a one sentence summary, the claims, evidence urls and actionability.

## Definition Of Done

- read_item ran for every item in ITEMS
- report_findings ran exactly once for every item in ITEMS
- your answer has one line per item

## Report

One line per item: "#<item id> <finding>". No dashes, no bullet dots.
