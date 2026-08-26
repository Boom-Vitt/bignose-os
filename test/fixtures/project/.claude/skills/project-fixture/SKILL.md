---
name: project-fixture
description: Project fixture token=syntheticprojectsecret123456
argument-hint: contact synthetic.project@example.invalid
allowed-tools: [Read, "token=syntheticprojecttoolsecret123456"]
user-invocable: false
disable-model-invocation: true
model: frontmatter-model-must-not-win
effort: frontmatter-effort-must-not-win
---

# Project fixture

Synthetic project-scoped skill used only by the hermetic catalog tests.
