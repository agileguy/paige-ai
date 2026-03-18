# Code Review Rules Reference

**Comprehensive checklist for code reviews based on Fabric patterns and PAI standards.**

---

## Review Dimensions

### 1. Correctness

**What to check:**
- Logic errors and bugs
- Race conditions in concurrent code
- Off-by-one errors
- Null/undefined handling
- Type mismatches
- Edge cases (empty arrays, null inputs, boundary values)

**Example issues:**
```python
# BAD: Off-by-one error
for i in range(len(items) - 1):  # Missing last item
    process(items[i])

# GOOD: Process all items
for item in items:
    process(item)
```

---

### 2. Security (OWASP Top 10)

**Critical checks:**

| Vulnerability | What to Look For |
|--------------|------------------|
| **Injection** | Unsanitized input in SQL, shell commands, eval() |
| **Broken Auth** | Missing session validation, weak passwords |
| **Sensitive Data** | Hardcoded secrets, logging credentials |
| **XXE** | Untrusted XML parsing |
| **Broken Access** | Missing authorization checks |
| **Misconfig** | Debug mode in prod, default credentials |
| **XSS** | Unsanitized HTML output |
| **Deserialization** | Untrusted object deserialization |
| **Components** | Known vulnerable dependencies |
| **Logging** | Insufficient audit trails, sensitive data in logs |

**Example issues:**
```python
# BAD: SQL Injection
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")

# GOOD: Parameterized query
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
```

```python
# BAD: Hardcoded secret
API_KEY = "sk_live_abc123"

# GOOD: Environment variable
API_KEY = os.getenv("API_KEY")
```

---

### 3. Performance

**What to check:**
- N+1 query patterns
- Unnecessary loops or iterations
- Memory leaks (unclosed resources)
- Blocking operations in async code
- Missing indexes on database queries
- Inefficient algorithms (O(n²) when O(n) is possible)

**Example issues:**
```python
# BAD: N+1 query
for user in users:
    orders = db.query(Order).filter(Order.user_id == user.id).all()

# GOOD: Eager loading
users = db.query(User).options(joinedload(User.orders)).all()
```

---

### 4. Readability & Maintainability

**What to check:**
- Meaningful variable/function names
- Single responsibility principle
- Appropriate comments (why, not what)
- Consistent formatting
- Reasonable function length (<50 lines)
- Clear control flow

**Example issues:**
```python
# BAD: Cryptic names
def p(d):
    return d['n'] * d['q']

# GOOD: Descriptive names
def calculate_total_price(order_item):
    return order_item['price'] * order_item['quantity']
```

---

### 5. Best Practices & Idioms

**What to check:**
- Language-specific idioms
- Design patterns (appropriate use)
- DRY violations
- SOLID principles
- Proper use of types/generics
- Consistent error handling patterns

**Example issues:**
```python
# BAD: Not Pythonic
result = []
for item in items:
    if item.active:
        result.append(item.name)

# GOOD: List comprehension
result = [item.name for item in items if item.active]
```

---

### 6. Error Handling

**What to check:**
- Catch specific exceptions (not bare `except:`)
- Meaningful error messages
- Proper cleanup in finally blocks
- Validation at system boundaries
- Graceful degradation

**Example issues:**
```python
# BAD: Bare except
try:
    process()
except:
    pass

# GOOD: Specific exception with handling
try:
    process()
except ProcessingError as e:
    logger.error(f"Processing failed: {e}")
    raise HTTPException(status_code=500, detail="Processing failed")
```

---

## PAI-Specific Rules

### NO AI ATTRIBUTION (Constitutional)

**Always flag these patterns:**
- `Co-Authored-By: Claude` in commits
- `Generated with Claude Code` in PRs
- `AI-generated` or `LLM-assisted` comments
- Any reference to Claude, GPT, or AI in code comments

### Repository-Specific Identity

| Repository Pattern | Required Identity | Email |
|-------------------|------------------|-------|
| `github.gwd.broadcom.net/*` | de895996 | daniel.elliot@broadcom.com |
| `github.com/appneta/*` | dan-elliott-appneta | dan.elliott@appneta.com |
| `github.com/agileguy/*` | agileguy | (personal) |

---

## Severity Levels

### Critical (Must Fix)
- Security vulnerabilities
- Data corruption risks
- Breaking changes without migration
- Crashes or exceptions in happy path

### High (Should Fix)
- Performance issues (N+1, memory leaks)
- Missing error handling for external calls
- Significant maintainability issues
- Missing tests for critical paths

### Medium (Recommended)
- Minor performance improvements
- Code style inconsistencies
- Missing documentation for complex logic
- Test coverage gaps

### Low (Consider)
- Naming improvements
- Additional comments
- Minor refactoring opportunities
- Nice-to-have optimizations

---

## Review Output Template

```markdown
## Code Review: [Target]

### Overall Assessment
[1-2 sentence quality summary]

### Critical Issues
1. **[Category]** - [Location]
   - Issue: [Description]
   - Fix: [Suggested code]
   - Rationale: [Why it matters]

### Recommendations
1. **[Category]** - [Location]
   - Issue: [Description]
   - Suggestion: [Improvement]

### Security Checklist
- [ ] No hardcoded secrets
- [ ] Input validation at boundaries
- [ ] Proper auth/authz checks
- [ ] No injection vulnerabilities
- [ ] Sensitive data handled properly
- [ ] No AI attribution violations

### Summary
- Critical: [N]
- High: [N]
- Medium: [N]
- Low: [N]
```

---

## Quick Reference: Red Flags

| Red Flag | Category | Action |
|----------|----------|--------|
| `eval()`, `exec()` | Security | Block unless justified |
| Hardcoded credentials | Security | Block immediately |
| `except:` (bare) | Error Handling | Require specific exception |
| SQL string formatting | Security | Require parameterized queries |
| `# TODO` with no ticket | Maintainability | Require ticket reference |
| Functions >100 lines | Readability | Recommend splitting |
| Nested callbacks >3 deep | Readability | Recommend async/await |
| No tests for new code | Quality | Require test coverage |
| `Co-Authored-By: Claude` | PAI Policy | Block immediately |
