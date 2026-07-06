# 🔒 Safe Push Guide for Hugging Face Spaces

## ⚠️ CRITICAL - Token Exposure

Your HF token has been exposed in the repository. **IMMEDIATELY:**

1. Go to https://huggingface.co/settings/tokens
2. Find your exposed token
3. Click "Delete" to revoke it
4. Create a new token with limited permissions
5. Update your Hugging Face Spaces environment variables with the new token

## 📁 What to Push vs What NOT to Push

### ✅ PUSH THESE FILES (Core Application)
```
app.py                     # Main Flask application
advanced_rag.py           # RAG system logic
static/
  ├── script.js           # Frontend logic
  ├── style.css           # Styling
  └── admin.js            # Admin interface logic
templates/
  ├── index.html          # Main page
  ├── admin.html          # Admin panel
  └── admin_login.html    # Login page
requirements.txt          # Python dependencies
Dockerfile               # Container config
docker-compose.yml       # Service orchestration
.env.template            # Template (no secrets)
*.md                     # Documentation
```

### ❌ NEVER PUSH THESE (Sensitive Data)
```
imp/                              # API key files
.env                              # Actual environment vars
*.local                           # Local configs
database files (*.db, *.sqlite3)
uploads/                          # User uploads
chroma_db/                        # Vector database
Test files (test*.py)
Backup files (*_backup.py)
Deployment scripts (deploy_to_hf.*)
```

## 🚀 How to Push Safely to HF Spaces

### Option 1: Manual Push (Recommended for Security)
```bash
# 1. Verify .gitignore is working
git status  # Should NOT show imp/, .env, or upload files

# 2. Stage only app files
git add app.py advanced_rag.py
git add static/ templates/
git add requirements.txt Dockerfile docker-compose.yml
git add README.md .env.template

# 3. Check staged files (verify no secrets)
git diff --cached

# 4. Commit and push
git commit -m "Update chatbot components"
git push -u origin main
```

### Option 2: Using Git Sparse Checkout (For HF Spaces)
When cloning to HF Spaces, only pull necessary files:
```bash
git clone --sparse https://huggingface.co/spaces/looksa/university-chatbot .
git sparse-checkout set app.py advanced_rag.py static templates requirements.txt
```

## 🔐 Environment Variables Setup

In Hugging Face Spaces:
1. Go to Space Settings → Secrets and variables
2. Add these environment variables (do NOT commit):
   - `GROQ_API_KEY=` (your new key)
   - `HF_TOKEN=` (your new token)
   - `SECRET_KEY=` (generate new)
   - `ADMIN_USERNAME=`
   - `ADMIN_PASSWORD=`
   - `QDRANT_URL=`
   - `QDRANT_API_KEY=`

The app.py already supports loading from HF Secrets directory: `/run/secrets/`

## 🧹 Clean Git History (Optional)

If you want to completely remove secrets from git history:
```bash
# Using git filter-repo (install first: pip install git-filter-repo)
git filter-repo --invert-paths --path 'imp/**'
git filter-repo --invert-paths --path '**/*_api_key.txt'

# Force push (be careful!)
git push --force-with-lease
```

## ✅ Verification Checklist
- [ ] HF token revoked (old one deleted from HF account)
- [ ] New HF token created with limited scope
- [ ] .gitignore updated
- [ ] .env.template shows all required variables
- [ ] No .env file in git (check: `git ls-files | grep .env`)
- [ ] No imp/ folder in git
- [ ] No uploads/ folder in git
- [ ] HF Spaces secrets configured with new token
- [ ] Test deployment works

## 📝 Going Forward

1. **Before pushing:** Always run `git status` and verify NO sensitive files are staged
2. **Use `.env.template`:** Keep it updated with all required variables
3. **Store secrets in HF Spaces UI:** Never in files
4. **Regular audits:** Periodically check what's in your repository

---
**Remember:** Environment variables are the secure way to manage secrets in containerized apps!
