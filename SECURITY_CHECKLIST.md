# 🔐 Security Checklist - Token Exposure Fix

## ⚠️ URGENT - Token Exposure Remediation

Your Hugging Face token has been exposed in the repository and must be revoked immediately.

### Step 1: Revoke Exposed Token (DO THIS IMMEDIATELY)
- [ ] Go to https://huggingface.co/settings/tokens
- [ ] Find and delete your exposed token 
- [ ] Click "Delete" to revoke it permanently
- [ ] Create a NEW token with LIMITED permissions (read/write for datasets only)
- [ ] Save the new token securely

### Step 2: Update HF Spaces Environment Variables
- [ ] Go to https://huggingface.co/spaces/looksa/university-chatbot/
- [ ] Click Settings → Secrets and variables
- [ ] Update `HF_TOKEN` with your NEW token (not the revoked one)
- [ ] Update all other secrets:
  - `GROQ_API_KEY` - Your Groq API key
  - `ADMIN_USERNAME` - Secure username
  - `ADMIN_PASSWORD` - Strong password
  - `SECRET_KEY` - Generate with: `python -c "import secrets; print(secrets.token_urlsafe(32))"`
  - `QDRANT_URL` - Your Qdrant instance URL
  - `QDRANT_API_KEY` - Qdrant API key (if not local)
- [ ] Restart the Space (Settings → Restart Space)

### Step 3: Prepare Local Repository for Safe Pushing
- [ ] `.gitignore` updated ✅ (includes `imp/`, `*.env`, etc.)
- [ ] Review `.env.template` - shows all required variables ✅
- [ ] Check `app.py` loads from `/run/secrets/` ✅
- [ ] Create `.env` locally (NOT in git) with your test values
- [ ] Test locally with: `python app.py`

### Step 4: Push Updates Safely
**Option A: Using Safe Push Script (Recommended)**
```bash
# Linux/Mac
chmod +x safe-push.sh
./safe-push.sh

# Windows
safe-push.bat
```

**Option B: Manual Safe Push**
```bash
# Verify no secrets are staged
git status
# Should NOT show: imp/, .env, uploads/, or any *_key/*_token files

# Stage only app files
git add app.py advanced_rag.py
git add static/ templates/
git add requirements.txt Dockerfile docker-compose.yml
git add .env.template README.md PUSH_GUIDE.md SECURITY_CHECKLIST.md

# Verify staged changes
git diff --cached | grep -i "key\|token\|password" || echo "✅ No secrets found"

# Commit
git commit -m "Update chatbot components (no secrets)"

# Push
git push
```

### Step 5: Verify Repository Security
After pushing, verify no secrets are exposed:
```bash
# Check git history for secrets
git log --all --oneline --grep="secret\|token\|key"

# Should show NO sensitive content
```

## 📋 Files Included in This Update

### ✅ Updated Files (Safe to Push)
- `.gitignore` - Enhanced security patterns
- `.env.template` - Template with all required variables
- `PUSH_GUIDE.md` - Detailed safe pushing guide
- `SECURITY_CHECKLIST.md` - This file
- `safe-push.sh` - Linux/Mac safe push script
- `safe-push.bat` - Windows safe push script

### ❌ Files That Should NEVER Be Pushed
- `imp/` - API keys directory
- `.env` - Local environment variables
- `uploads/` - User uploaded files
- `chroma_db/` - Vector database
- `test*.py` - Test files with potential sensitive data
- `*_backup.py` - Backup files
- `deploy_to_hf.*` - Deployment scripts

## 🚀 How the App Works with HF Spaces

1. **Local Development:**
   - Create `.env` file with your secrets
   - Run: `python app.py`
   - App loads from `.env` file

2. **HF Spaces (Cloud):**
   - App container starts
   - `app.py` checks `/run/secrets/` directory first (HF secrets)
   - If not found, checks environment variables (HF spaces secrets)
   - Falls back to `.env` file (not available in HF)
   - Never hardcodes secrets ✅

## ✅ Final Verification

Before declaring this fixed:

```bash
# 1. Token is revoked
# Go to: https://huggingface.co/settings/tokens
# Confirm old token is deleted ✓

# 2. New token is configured in HF Spaces
# Go to: https://huggingface.co/spaces/looksa/university-chatbot/settings
# Confirm HF_TOKEN is set to new value ✓

# 3. Repository is clean
# No exposed tokens should appear ✓

# 4. Sensitive files are ignored
git ls-files | grep -E "(\.env|imp/|_key\.txt|_token\.txt)" 
# Should return NO results ✓

# 5. Space works after restart
# Go to Space, wait 2-3 minutes for restart
# Test chatbot functionality ✓
```

## 🔐 Going Forward - Best Practices

### Never Do:
- ❌ Commit `.env` files
- ❌ Hardcode API keys in code
- ❌ Push API keys in comments
- ❌ Store secrets in documentation
- ❌ Share `.env` files via chat/email

### Always Do:
- ✅ Use `.env.template` for variable names only
- ✅ Store secrets in HF Spaces UI (Settings → Secrets)
- ✅ Use environment variables in code
- ✅ Review git status before committing
- ✅ Test `git diff --cached` before committing

### Setup Checklist for New Features:
1. Add to `.env.template` (no actual values)
2. Add to HF Spaces secrets UI
3. Code references via `os.environ.get()`
4. Test locally with `.env` file
5. Push only code changes (not secrets)

## 📚 Related Files

- [PUSH_GUIDE.md](./PUSH_GUIDE.md) - Detailed pushing instructions
- [.env.template](./.env.template) - Environment variables template
- [.gitignore](./.gitignore) - Files to never commit
- [safe-push.sh](./safe-push.sh) - Linux/Mac safe push script
- [safe-push.bat](./safe-push.bat) - Windows safe push script

---

**Last Updated:** 2026-07-06
**Status:** ⚠️ REQUIRES ACTION - Token exposure remediation needed
