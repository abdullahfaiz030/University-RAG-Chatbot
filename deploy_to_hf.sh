#!/bin/bash
# Deploy to Hugging Face Spaces
# Usage: ./deploy_to_hf.sh YOUR_HF_USERNAME

if [ -z "$1" ]; then
    echo "Usage: ./deploy_to_hf.sh YOUR_HF_USERNAME"
    echo ""
    echo "Example: ./deploy_to_hf.sh looksa"
    exit 1
fi

HF_USERNAME=$1
HF_SPACE_NAME="university-chatbot"
HF_SPACE_URL="https://huggingface.co/spaces/$HF_USERNAME/$HF_SPACE_NAME"

echo ""
echo "========================================"
echo "Deploying to Hugging Face Spaces"
echo "========================================"
echo "Space URL: $HF_SPACE_URL"
echo ""

# Check if git is installed
if ! command -v git &> /dev/null; then
    echo "Error: Git is not installed."
    exit 1
fi

# Check if git-lfs is installed (optional but recommended)
if ! command -v git-lfs &> /dev/null; then
    echo "Warning: Git LFS not installed. Recommend: brew install git-lfs"
fi

echo "Step 1: Creating .gitignore for HF Spaces..."
cat > .gitignore << 'EOF'
.env
__pycache__/
*.pyc
*.pyo
.DS_Store
chroma_db/
uploads/
*.log
venv/
.vscode/
.idea/
*.db
*.sqlite
app_backup.py
*_backup.*
app_hf.py
EOF

echo "Step 2: Staging files for commit..."
git add .

echo "Step 3: Committing changes..."
git commit -m "Deploy advanced chatbot to Hugging Face Spaces"

echo "Step 4: Adding HF Spaces remote..."
git remote remove hf-space 2>/dev/null || true
git remote add hf-space "https://huggingface.co/spaces/$HF_USERNAME/$HF_SPACE_NAME"

echo "Step 5: Pushing to Hugging Face Spaces..."
echo "Please enter your Hugging Face credentials when prompted."
echo "(Use your HF token as password)"
echo ""

if git push hf-space main; then
    echo ""
    echo "========================================"
    echo "✓ Deployment successful!"
    echo "========================================"
    echo ""
    echo "Your chatbot is deploying to:"
    echo "$HF_SPACE_URL"
    echo ""
    echo "IMPORTANT: Configure these secrets in HF Spaces:"
    echo "1. Go to: $HF_SPACE_URL/settings"
    echo "2. Click 'Repository secrets'"
    echo "3. Add these variables:"
    echo "   - GROQ_API_KEY = your_api_key"
    echo "   - QDRANT_URL = your_qdrant_url"
    echo "   - QDRANT_API_KEY = your_qdrant_key"
    echo "   - ADMIN_PASSWORD = your_password"
    echo "   - SECRET_KEY = random_string"
    echo ""
    echo "The space will rebuild automatically."
    echo "Check the 'Logs' tab for deployment status."
else
    echo ""
    echo "Error: Push failed."
    echo "Please check:"
    echo "1. Your HF username is correct: $HF_USERNAME"
    echo "2. Space exists at: $HF_SPACE_URL"
    echo "3. Your HF token is valid"
    exit 1
fi
