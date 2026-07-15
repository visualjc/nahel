---
allowed-tools: Read, Write, LS
---

# PRD Edit

Edit an existing Product Requirements Document.

## Usage
```
/pm:prd-edit <feature_name>
```

## Instructions

### 1. Read Current PRD

Resolve PRD path and read `$PRD_DIR/$ARGUMENTS.md`:
```bash
PRD_DIR=$(.claude/scripts/pm/resolve-prd-dir.sh) || { echo "❌ No PRD directory. Run /pm:prd-new $ARGUMENTS first"; exit 1; }
```
Read `$PRD_DIR/$ARGUMENTS.md`:
- Parse frontmatter
- Read all sections

### 2. Interactive Edit

Ask user what sections to edit:
- Executive Summary
- Problem Statement  
- User Stories
- Requirements (Functional/Non-Functional)
- Success Criteria
- Constraints & Assumptions
- Out of Scope
- Dependencies

### 3. Update PRD

Get current datetime: `date -u +"%Y-%m-%dT%H:%M:%SZ"`

Update PRD file:
- Preserve frontmatter except `updated` field
- Apply user's edits to selected sections
- Update `updated` field with current datetime

### 4. Check Epic Impact

If PRD has associated epic:
- Notify user: "This PRD has epic: {epic_name}"
- Ask: "Epic may need updating based on PRD changes. Review epic? (yes/no)"
- If yes, show: "Review with: /pm:epic-edit {epic_name}"

### 5. Output

```
✅ Updated PRD: $ARGUMENTS
  Sections edited: {list_of_sections}
  
{If has epic}: ⚠️ Epic may need review: {epic_name}

Next: /pm:prd-parse $ARGUMENTS to update epic
```

## Important Notes

Preserve original creation date.
Keep version history in frontmatter if needed.
Follow `/rules/frontmatter-operations.md`.